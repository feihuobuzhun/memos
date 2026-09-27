package v1

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	v1pb "github.com/usememos/memos/proto/gen/api/v1"
	"github.com/usememos/memos/store"
)

// createGraphMemo writes a memo with a known UID so a test can talk about
// nodes by name.
func createGraphMemo(ctx context.Context, t *testing.T, svc *APIV1Service, userID int32, uid, content string, visibility store.Visibility) *store.Memo {
	t.Helper()
	created, err := svc.Store.CreateMemo(ctx, &store.Memo{
		UID:        uid,
		CreatorID:  userID,
		Content:    content,
		Visibility: visibility,
		CreatedTs:  time.Now().Unix(),
	})
	require.NoError(t, err)
	return created
}

// reference records that `from` links to `to`, which is what the walk follows.
func reference(ctx context.Context, t *testing.T, svc *APIV1Service, from, to *store.Memo) {
	t.Helper()
	_, err := svc.Store.UpsertMemoRelation(ctx, &store.MemoRelation{
		MemoID:        from.ID,
		RelatedMemoID: to.ID,
		Type:          store.MemoRelationReference,
	})
	require.NoError(t, err)
}

func graphNodeNames(response *v1pb.GetMemoReferenceGraphResponse) []string {
	names := make([]string, 0, len(response.Nodes))
	for _, node := range response.Nodes {
		names = append(names, node.Name)
	}
	return names
}

func graphEdgePairs(response *v1pb.GetMemoReferenceGraphResponse) []string {
	pairs := make([]string, 0, len(response.Edges))
	for _, edge := range response.Edges {
		pairs = append(pairs, edge.Source+"->"+edge.Target)
	}
	return pairs
}

func graphNodeByName(t *testing.T, response *v1pb.GetMemoReferenceGraphResponse, name string) *v1pb.GetMemoReferenceGraphResponse_Node {
	t.Helper()
	for _, node := range response.Nodes {
		if node.Name == name {
			return node
		}
	}
	t.Fatalf("node %q not in graph %v", name, graphNodeNames(response))
	return nil
}

// buildFanOut wires the shape the feature was designed around: A references B
// and C, B references D and E, C references F and G.
func buildFanOut(ctx context.Context, t *testing.T, svc *APIV1Service, userID int32) map[string]*store.Memo {
	t.Helper()
	memos := map[string]*store.Memo{}
	for _, uid := range []string{"card-a", "card-b", "card-c", "card-d", "card-e", "card-f", "card-g"} {
		memos[uid] = createGraphMemo(ctx, t, svc, userID, uid, "content of "+uid, store.Private)
	}
	reference(ctx, t, svc, memos["card-a"], memos["card-b"])
	reference(ctx, t, svc, memos["card-a"], memos["card-c"])
	reference(ctx, t, svc, memos["card-b"], memos["card-d"])
	reference(ctx, t, svc, memos["card-b"], memos["card-e"])
	reference(ctx, t, svc, memos["card-c"], memos["card-f"])
	reference(ctx, t, svc, memos["card-c"], memos["card-g"])
	return memos
}

func TestGetMemoReferenceGraph_WalksOutgoingReferencesBreadthFirst(t *testing.T) {
	ctx := context.Background()
	svc := newIntegrationService(t)
	user := createSpaceTestUser(ctx, t, svc, "reader", store.RoleUser)
	userCtx := userCtx(ctx, user.ID)
	buildFanOut(ctx, t, svc, user.ID)

	response, err := svc.GetMemoReferenceGraph(userCtx, &v1pb.GetMemoReferenceGraphRequest{
		Name:      "memos/card-a",
		Direction: v1pb.GetMemoReferenceGraphRequest_OUTGOING,
	})
	require.NoError(t, err)

	// The root first, then each level in order, so a client can lay the graph
	// out in one pass.
	assert.Equal(t, []string{
		"memos/card-a",
		"memos/card-b", "memos/card-c",
		"memos/card-d", "memos/card-e", "memos/card-f", "memos/card-g",
	}, graphNodeNames(response))
	assert.ElementsMatch(t, []string{
		"memos/card-a->memos/card-b", "memos/card-a->memos/card-c",
		"memos/card-b->memos/card-d", "memos/card-b->memos/card-e",
		"memos/card-c->memos/card-f", "memos/card-c->memos/card-g",
	}, graphEdgePairs(response))
	assert.Equal(t, int32(0), graphNodeByName(t, response, "memos/card-a").Depth)
	assert.Equal(t, int32(1), graphNodeByName(t, response, "memos/card-b").Depth)
	assert.Equal(t, int32(2), graphNodeByName(t, response, "memos/card-g").Depth)
	assert.False(t, response.Truncated)
	assert.False(t, graphNodeByName(t, response, "memos/card-d").HasMore)
	assert.NotEmpty(t, graphNodeByName(t, response, "memos/card-b").Snippet)
	assert.NotNil(t, graphNodeByName(t, response, "memos/card-b").CreateTime)
}

func TestGetMemoReferenceGraph_StopsAtTheRequestedDepthAndSaysThereIsMore(t *testing.T) {
	ctx := context.Background()
	svc := newIntegrationService(t)
	user := createSpaceTestUser(ctx, t, svc, "reader", store.RoleUser)
	userCtx := userCtx(ctx, user.ID)
	buildFanOut(ctx, t, svc, user.ID)

	response, err := svc.GetMemoReferenceGraph(userCtx, &v1pb.GetMemoReferenceGraphRequest{
		Name:      "memos/card-a",
		Direction: v1pb.GetMemoReferenceGraphRequest_OUTGOING,
		Depth:     1,
	})
	require.NoError(t, err)

	assert.Equal(t, []string{"memos/card-a", "memos/card-b", "memos/card-c"}, graphNodeNames(response))
	assert.True(t, response.Truncated)
	// Both leaves still have references, so both invite a further look.
	assert.True(t, graphNodeByName(t, response, "memos/card-b").HasMore)
	assert.True(t, graphNodeByName(t, response, "memos/card-c").HasMore)
	assert.False(t, graphNodeByName(t, response, "memos/card-a").HasMore)
}

func TestGetMemoReferenceGraph_FollowsBacklinksAndBothDirections(t *testing.T) {
	ctx := context.Background()
	svc := newIntegrationService(t)
	user := createSpaceTestUser(ctx, t, svc, "reader", store.RoleUser)
	userCtx := userCtx(ctx, user.ID)
	memos := buildFanOut(ctx, t, svc, user.ID)
	// Another card also points at B, so B has two referrers.
	referrer := createGraphMemo(ctx, t, svc, user.ID, "card-h", "content of card-h", store.Private)
	reference(ctx, t, svc, referrer, memos["card-b"])

	incoming, err := svc.GetMemoReferenceGraph(userCtx, &v1pb.GetMemoReferenceGraphRequest{
		Name:      "memos/card-b",
		Direction: v1pb.GetMemoReferenceGraphRequest_INCOMING,
	})
	require.NoError(t, err)
	// Who points here, not what this points at.
	assert.ElementsMatch(t, []string{"memos/card-b", "memos/card-a", "memos/card-h"}, graphNodeNames(incoming))

	both, err := svc.GetMemoReferenceGraph(userCtx, &v1pb.GetMemoReferenceGraphRequest{
		Name:      "memos/card-b",
		Direction: v1pb.GetMemoReferenceGraphRequest_BOTH,
		Depth:     1,
	})
	require.NoError(t, err)
	assert.ElementsMatch(t, []string{
		"memos/card-b", "memos/card-a", "memos/card-h", "memos/card-d", "memos/card-e",
	}, graphNodeNames(both))
}

func TestGetMemoReferenceGraph_KeepsTheEdgeThatClosesACycle(t *testing.T) {
	ctx := context.Background()
	svc := newIntegrationService(t)
	user := createSpaceTestUser(ctx, t, svc, "reader", store.RoleUser)
	userCtx := userCtx(ctx, user.ID)
	a := createGraphMemo(ctx, t, svc, user.ID, "cycle-a", "a", store.Private)
	b := createGraphMemo(ctx, t, svc, user.ID, "cycle-b", "b", store.Private)
	c := createGraphMemo(ctx, t, svc, user.ID, "cycle-c", "c", store.Private)
	reference(ctx, t, svc, a, b)
	reference(ctx, t, svc, b, c)
	reference(ctx, t, svc, c, a)

	response, err := svc.GetMemoReferenceGraph(userCtx, &v1pb.GetMemoReferenceGraphRequest{
		Name:      "memos/cycle-a",
		Direction: v1pb.GetMemoReferenceGraphRequest_OUTGOING,
	})
	require.NoError(t, err)

	// Each memo appears once, and the edge back to the root is reported rather
	// than dropped, so the client can draw the loop.
	assert.Equal(t, []string{"memos/cycle-a", "memos/cycle-b", "memos/cycle-c"}, graphNodeNames(response))
	assert.ElementsMatch(t, []string{
		"memos/cycle-a->memos/cycle-b",
		"memos/cycle-b->memos/cycle-c",
		"memos/cycle-c->memos/cycle-a",
	}, graphEdgePairs(response))
	assert.False(t, response.Truncated)
}

func TestGetMemoReferenceGraph_OmitsMemosTheCallerCannotRead(t *testing.T) {
	ctx := context.Background()
	svc := newIntegrationService(t)
	owner := createSpaceTestUser(ctx, t, svc, "owner", store.RoleUser)
	stranger := createSpaceTestUser(ctx, t, svc, "stranger", store.RoleUser)

	public := createGraphMemo(ctx, t, svc, owner.ID, "public-root", "public root", store.Public)
	secret := createGraphMemo(ctx, t, svc, owner.ID, "private-leaf", "private leaf", store.Private)
	alsoPublic := createGraphMemo(ctx, t, svc, owner.ID, "public-leaf", "public leaf", store.Public)
	reference(ctx, t, svc, public, secret)
	reference(ctx, t, svc, public, alsoPublic)

	response, err := svc.GetMemoReferenceGraph(userCtx(ctx, stranger.ID), &v1pb.GetMemoReferenceGraphRequest{
		Name:      "memos/public-root",
		Direction: v1pb.GetMemoReferenceGraphRequest_OUTGOING,
	})
	require.NoError(t, err)

	// The private memo is absent, and so is the edge to it; nothing hints that
	// it exists.
	assert.Equal(t, []string{"memos/public-root", "memos/public-leaf"}, graphNodeNames(response))
	assert.Equal(t, []string{"memos/public-root->memos/public-leaf"}, graphEdgePairs(response))
	assert.False(t, graphNodeByName(t, response, "memos/public-leaf").HasMore)
}

func TestGetMemoReferenceGraph_IgnoresComments(t *testing.T) {
	ctx := context.Background()
	svc := newIntegrationService(t)
	user := createSpaceTestUser(ctx, t, svc, "reader", store.RoleUser)
	userCtx := userCtx(ctx, user.ID)
	createGraphMemo(ctx, t, svc, user.ID, "commented", "the thought", store.Private)
	_, err := svc.CreateMemoComment(userCtx, &v1pb.CreateMemoCommentRequest{
		Name:    "memos/commented",
		Comment: &v1pb.Memo{Content: "a reply", Visibility: v1pb.Visibility_PRIVATE},
	})
	require.NoError(t, err)

	response, err := svc.GetMemoReferenceGraph(userCtx, &v1pb.GetMemoReferenceGraphRequest{
		Name:      "memos/commented",
		Direction: v1pb.GetMemoReferenceGraphRequest_BOTH,
	})
	require.NoError(t, err)

	// A comment is a reply, not a reference, and most of them are written by an
	// assistant rather than by the author thinking.
	assert.Equal(t, []string{"memos/commented"}, graphNodeNames(response))
	assert.Empty(t, response.Edges)
	assert.False(t, response.Truncated)
}

func TestGetMemoReferenceGraph_HonorsTheNodeBudget(t *testing.T) {
	ctx := context.Background()
	svc := newIntegrationService(t)
	user := createSpaceTestUser(ctx, t, svc, "reader", store.RoleUser)
	userCtx := userCtx(ctx, user.ID)
	buildFanOut(ctx, t, svc, user.ID)

	response, err := svc.GetMemoReferenceGraph(userCtx, &v1pb.GetMemoReferenceGraphRequest{
		Name:      "memos/card-a",
		Direction: v1pb.GetMemoReferenceGraphRequest_OUTGOING,
		MaxNodes:  2,
	})
	require.NoError(t, err)

	assert.Len(t, response.Nodes, 2)
	assert.True(t, response.Truncated)
	// Only the edge whose both ends survived is reported.
	assert.Equal(t, []string{"memos/card-a->memos/card-b"}, graphEdgePairs(response))
}

func TestGetMemoReferenceGraph_RejectsBadInput(t *testing.T) {
	ctx := context.Background()
	svc := newIntegrationService(t)
	user := createSpaceTestUser(ctx, t, svc, "reader", store.RoleUser)
	userCtx := userCtx(ctx, user.ID)
	createGraphMemo(ctx, t, svc, user.ID, "lonely", "alone", store.Private)

	_, err := svc.GetMemoReferenceGraph(userCtx, &v1pb.GetMemoReferenceGraphRequest{Name: "not-a-memo"})
	assert.Error(t, err)

	_, err = svc.GetMemoReferenceGraph(userCtx, &v1pb.GetMemoReferenceGraphRequest{Name: "memos/does-not-exist"})
	assert.Error(t, err)

	_, err = svc.GetMemoReferenceGraph(userCtx, &v1pb.GetMemoReferenceGraphRequest{Name: "memos/lonely", Depth: -1})
	assert.Error(t, err)

	// A depth past the cap is clamped rather than rejected, so a client cannot
	// ask for an unbounded walk but also cannot fail because it tried.
	response, err := svc.GetMemoReferenceGraph(userCtx, &v1pb.GetMemoReferenceGraphRequest{
		Name:  "memos/lonely",
		Depth: 99,
	})
	require.NoError(t, err)
	assert.Equal(t, []string{"memos/lonely"}, graphNodeNames(response))
}
