package v1

import (
	"context"
	"slices"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1pb "github.com/usememos/memos/proto/gen/api/v1"
	"github.com/usememos/memos/store"
)

const (
	defaultReferenceGraphDepth = 3
	maxReferenceGraphDepth     = 5
	defaultReferenceGraphNodes = 200
	maxReferenceGraphNodes     = 500
)

// GetMemoReferenceGraph walks the REFERENCE relations around one memo, breadth
// first, and returns what it reached. Doing the walk here rather than in the
// client is the whole point: a client cannot expand a level without a request
// per node, and it cannot tell "no references" from "references you may not
// read" without leaking which is which.
func (s *APIV1Service) GetMemoReferenceGraph(ctx context.Context, request *v1pb.GetMemoReferenceGraphRequest) (*v1pb.GetMemoReferenceGraphResponse, error) {
	memoUID, err := ExtractMemoUIDFromName(request.Name)
	if err != nil {
		return nil, status.Errorf(codes.InvalidArgument, "invalid memo name: %v", err)
	}
	if request.Depth < 0 || request.MaxNodes < 0 {
		return nil, status.Error(codes.InvalidArgument, "depth and max_nodes cannot be negative")
	}
	depth := clampGraphBound(int(request.Depth), defaultReferenceGraphDepth, maxReferenceGraphDepth)
	maxNodes := clampGraphBound(int(request.MaxNodes), defaultReferenceGraphNodes, maxReferenceGraphNodes)

	root, err := s.Store.GetMemo(ctx, &store.FindMemo{UID: &memoUID})
	if err != nil {
		return nil, status.Error(codes.Internal, "failed to get memo")
	}
	if root == nil {
		return nil, status.Error(codes.NotFound, "memo not found")
	}
	if err := s.checkMemoReadAccess(ctx, root); err != nil {
		return nil, err
	}

	walk, err := s.walkReferenceGraph(ctx, root, request.Direction, depth, maxNodes)
	if err != nil {
		return nil, err
	}
	return walk.response(), nil
}

func clampGraphBound(requested, fallback, limit int) int {
	if requested <= 0 {
		return fallback
	}
	return min(requested, limit)
}

// referenceGraphWalk accumulates one breadth-first walk. Nodes are kept in
// discovery order so the root comes first and every node's parent precedes it,
// which is what lets a client lay the graph out in one pass.
type referenceGraphWalk struct {
	nodes     []*v1pb.GetMemoReferenceGraphResponse_Node
	nodeIndex map[int32]int
	edges     []*v1pb.GetMemoReferenceGraphResponse_Edge
	edgeSeen  map[[2]int32]bool
	truncated bool
}

func (s *APIV1Service) walkReferenceGraph(
	ctx context.Context,
	root *store.Memo,
	direction v1pb.GetMemoReferenceGraphRequest_Direction,
	depth, maxNodes int,
) (*referenceGraphWalk, error) {
	accessScope, _, err := s.resolveMemoAccessScope(ctx)
	if err != nil {
		return nil, status.Error(codes.Internal, "failed to resolve memo access")
	}

	walk := &referenceGraphWalk{nodeIndex: map[int32]int{}, edgeSeen: map[[2]int32]bool{}}
	if err := walk.addNode(s, root, 0); err != nil {
		return nil, err
	}

	frontier := []int32{root.ID}
	for level := 0; level < depth && len(frontier) > 0; level++ {
		relations, err := s.listReferenceRelations(ctx, frontier, direction)
		if err != nil {
			return nil, status.Error(codes.Internal, "failed to list memo relations")
		}

		// Every endpoint that is new to the graph. Sorted so the level is the
		// same on every call and in creation order, which the relation query
		// does not promise.
		var discovered []int32
		for _, relation := range relations {
			for _, id := range []int32{relation.MemoID, relation.RelatedMemoID} {
				if _, seen := walk.nodeIndex[id]; seen {
					continue
				}
				if !containsInt32(discovered, id) {
					discovered = append(discovered, id)
				}
			}
		}

		slices.Sort(discovered)

		// A memo the caller may not read is simply absent, which also drops
		// every edge that touched it.
		reachable, err := s.loadGraphMemos(ctx, discovered, accessScope)
		if err != nil {
			return nil, status.Error(codes.Internal, "failed to load related memos")
		}

		var next []int32
		for _, id := range discovered {
			memo, ok := reachable[id]
			if !ok {
				continue
			}
			if len(walk.nodes) >= maxNodes {
				walk.truncated = true
				break
			}
			if err := walk.addNode(s, memo, int32(level+1)); err != nil {
				return nil, err
			}
			next = append(next, id)
		}

		for _, relation := range relations {
			walk.addEdge(relation.MemoID, relation.RelatedMemoID)
		}

		frontier = next
	}

	// The outermost ring was never expanded, so anything it points at is
	// missing. Say which of those memos actually have more, rather than
	// implying every leaf is a dead end.
	if err := s.markUnexpanded(ctx, walk, frontier, direction, accessScope); err != nil {
		return nil, status.Error(codes.Internal, "failed to list memo relations")
	}
	return walk, nil
}

// markUnexpanded flags the memos that still have references outside the graph.
// It is what turns a leaf into "click to keep going" instead of "nothing here".
func (s *APIV1Service) markUnexpanded(
	ctx context.Context,
	walk *referenceGraphWalk,
	frontier []int32,
	direction v1pb.GetMemoReferenceGraphRequest_Direction,
	accessScope *store.MemoAccessScope,
) error {
	if len(frontier) == 0 {
		return nil
	}
	relations, err := s.listReferenceRelations(ctx, frontier, direction)
	if err != nil {
		return err
	}

	// Candidates the graph does not already hold, paired with the node that
	// reaches them.
	reachedBy := map[int32][]int32{}
	var candidates []int32
	for _, relation := range relations {
		for _, pair := range [][2]int32{
			{relation.MemoID, relation.RelatedMemoID},
			{relation.RelatedMemoID, relation.MemoID},
		} {
			node, other := pair[0], pair[1]
			if _, ok := walk.nodeIndex[node]; !ok {
				continue
			}
			if _, inGraph := walk.nodeIndex[other]; inGraph {
				continue
			}
			if _, known := reachedBy[other]; !known {
				candidates = append(candidates, other)
			}
			reachedBy[other] = append(reachedBy[other], node)
		}
	}

	// A memo the caller may not read is not "more to see", and saying it is
	// would advertise that it exists.
	readable, err := s.loadGraphMemos(ctx, candidates, accessScope)
	if err != nil {
		return err
	}
	for other, nodes := range reachedBy {
		if _, ok := readable[other]; !ok {
			continue
		}
		for _, node := range nodes {
			walk.nodes[walk.nodeIndex[node]].HasMore = true
			walk.truncated = true
		}
	}
	return nil
}

// listReferenceRelations returns the REFERENCE relations on one side, or both,
// of the given memos. Comments are deliberately excluded: they are replies, not
// references, and here they would bury the thinking under the machine's notes.
func (s *APIV1Service) listReferenceRelations(
	ctx context.Context,
	memoIDs []int32,
	direction v1pb.GetMemoReferenceGraphRequest_Direction,
) ([]*store.MemoRelation, error) {
	referenceType := store.MemoRelationReference
	var relations []*store.MemoRelation

	followOutgoing := direction != v1pb.GetMemoReferenceGraphRequest_INCOMING
	followIncoming := direction == v1pb.GetMemoReferenceGraphRequest_INCOMING ||
		direction == v1pb.GetMemoReferenceGraphRequest_BOTH

	if followOutgoing {
		outgoing, err := s.Store.ListMemoRelations(ctx, &store.FindMemoRelation{
			SourceMemoIDList: memoIDs,
			Type:             &referenceType,
		})
		if err != nil {
			return nil, err
		}
		relations = append(relations, outgoing...)
	}
	if followIncoming {
		incoming, err := s.Store.ListMemoRelations(ctx, &store.FindMemoRelation{
			RelatedMemoIDList: memoIDs,
			Type:              &referenceType,
		})
		if err != nil {
			return nil, err
		}
		relations = append(relations, incoming...)
	}
	return relations, nil
}

// loadGraphMemos resolves the candidate IDs the caller is allowed to read.
// Archived memos are kept: a reference to something you filed away is still a
// real part of how the thought was built.
func (s *APIV1Service) loadGraphMemos(ctx context.Context, ids []int32, accessScope *store.MemoAccessScope) (map[int32]*store.Memo, error) {
	if len(ids) == 0 {
		return map[int32]*store.Memo{}, nil
	}
	memos, err := s.Store.ListMemos(ctx, &store.FindMemo{IDList: ids, Access: accessScope})
	if err != nil {
		return nil, err
	}
	byID := make(map[int32]*store.Memo, len(memos))
	for _, memo := range memos {
		byID[memo.ID] = memo
	}
	return byID, nil
}

func (w *referenceGraphWalk) addNode(s *APIV1Service, memo *store.Memo, depth int32) error {
	snippet, err := s.getMemoContentSnippet(memo.Content)
	if err != nil {
		return status.Error(codes.Internal, "failed to generate memo snippet")
	}
	w.nodeIndex[memo.ID] = len(w.nodes)
	w.nodes = append(w.nodes, &v1pb.GetMemoReferenceGraphResponse_Node{
		Name:       "memos/" + memo.UID,
		Snippet:    snippet,
		Depth:      depth,
		CreateTime: timestamppb.New(time.Unix(memo.CreatedTs, 0).UTC()),
	})
	return nil
}

// addEdge keeps only edges whose both endpoints made it into the graph, so a
// client never has to handle a dangling one.
func (w *referenceGraphWalk) addEdge(sourceID, targetID int32) {
	sourceIdx, sourceOK := w.nodeIndex[sourceID]
	targetIdx, targetOK := w.nodeIndex[targetID]
	if !sourceOK || !targetOK {
		w.truncated = true
		return
	}
	key := [2]int32{sourceID, targetID}
	if w.edgeSeen[key] {
		return
	}
	w.edgeSeen[key] = true
	w.edges = append(w.edges, &v1pb.GetMemoReferenceGraphResponse_Edge{
		Source: w.nodes[sourceIdx].Name,
		Target: w.nodes[targetIdx].Name,
	})
}

func (w *referenceGraphWalk) response() *v1pb.GetMemoReferenceGraphResponse {
	return &v1pb.GetMemoReferenceGraphResponse{
		Nodes:     w.nodes,
		Edges:     w.edges,
		Truncated: w.truncated,
	}
}

func containsInt32(values []int32, target int32) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}
