package v1

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/types/known/fieldmaskpb"

	"github.com/usememos/memos/core/memopayload"
	v1pb "github.com/usememos/memos/proto/gen/api/v1"
	storepb "github.com/usememos/memos/proto/gen/store"
	"github.com/usememos/memos/store"
)

// createReviewMemo writes a memo directly through the store so its creation
// time can be placed in the past, which the time-range condition needs.
func createReviewMemo(ctx context.Context, t *testing.T, svc *APIV1Service, userID int32, content string, createdDaysAgo int) *store.Memo {
	t.Helper()
	uid, err := ValidateAndGenerateUID("")
	require.NoError(t, err)
	memo := &store.Memo{
		UID:        uid,
		CreatorID:  userID,
		Content:    content,
		Visibility: store.Private,
		CreatedTs:  time.Now().AddDate(0, 0, -createdDaysAgo).Unix(),
	}
	// The tag index lives in the payload, and the store does not derive it, so
	// a fixture written directly has to build it the way the API does.
	require.NoError(t, memopayload.RebuildMemoPayload(ctx, memo, svc.MarkdownService))
	created, err := svc.Store.CreateMemo(ctx, memo)
	require.NoError(t, err)
	return created
}

func reviewContents(t *testing.T, response *v1pb.ListReviewMemosResponse) []string {
	t.Helper()
	contents := make([]string, 0, len(response.Memos))
	for _, memo := range response.Memos {
		contents = append(contents, memo.Content)
	}
	return contents
}

func saveReviewSetting(ctx context.Context, t *testing.T, svc *APIV1Service, userID int32, setting *storepb.ReviewUserSetting) {
	t.Helper()
	_, err := svc.Store.UpsertUserSetting(ctx, &storepb.UserSetting{
		UserId: userID,
		Key:    storepb.UserSetting_REVIEW,
		Value:  &storepb.UserSetting_Review{Review: setting},
	})
	require.NoError(t, err)
}

// TestListReviewMemos_ConditionsSelectEligibleMemos covers the four review
// conditions and the time range against one fixture set.
func TestListReviewMemos_ConditionsSelectEligibleMemos(t *testing.T) {
	ctx := context.Background()
	svc := newIntegrationService(t)
	user := createSpaceTestUser(ctx, t, svc, "reader", store.RoleUser)
	userCtx := userCtx(ctx, user.ID)

	createReviewMemo(ctx, t, svc, user.ID, "#book 认知天性", 10)
	createReviewMemo(ctx, t, svc, user.ID, "#book/novel 三体", 20)
	createReviewMemo(ctx, t, svc, user.ID, "#work 周报", 30)
	createReviewMemo(ctx, t, svc, user.ID, "没有标签的想法", 40)
	// Well outside every bounded window, and untagged, so it also proves the
	// window applies on top of the condition.
	createReviewMemo(ctx, t, svc, user.ID, "四年前的旧笔记", 1500)

	tests := []struct {
		name    string
		setting *storepb.ReviewUserSetting
		want    []string
	}{
		{
			name:    "all memos",
			setting: &storepb.ReviewUserSetting{Condition: storepb.ReviewUserSetting_ALL_MEMOS},
			want:    []string{"#book 认知天性", "#book/novel 三体", "#work 周报", "没有标签的想法", "四年前的旧笔记"},
		},
		{
			name: "include tags reaches nested children",
			setting: &storepb.ReviewUserSetting{
				Condition: storepb.ReviewUserSetting_INCLUDE_TAGS,
				Tags:      []string{"book"},
			},
			want: []string{"#book 认知天性", "#book/novel 三体"},
		},
		{
			name: "exclude tags removes nested children too",
			setting: &storepb.ReviewUserSetting{
				Condition: storepb.ReviewUserSetting_EXCLUDE_TAGS,
				Tags:      []string{"book"},
			},
			want: []string{"#work 周报", "没有标签的想法", "四年前的旧笔记"},
		},
		{
			name:    "untagged",
			setting: &storepb.ReviewUserSetting{Condition: storepb.ReviewUserSetting_UNTAGGED},
			want:    []string{"没有标签的想法", "四年前的旧笔记"},
		},
		{
			name: "last year bounds the window",
			setting: &storepb.ReviewUserSetting{
				Condition: storepb.ReviewUserSetting_ALL_MEMOS,
				TimeRange: storepb.ReviewUserSetting_LAST_YEAR,
			},
			want: []string{"#book 认知天性", "#book/novel 三体", "#work 周报", "没有标签的想法"},
		},
		{
			name: "last month bounds the window",
			setting: &storepb.ReviewUserSetting{
				Condition: storepb.ReviewUserSetting_ALL_MEMOS,
				TimeRange: storepb.ReviewUserSetting_LAST_MONTH,
			},
			want: []string{"#book 认知天性", "#book/novel 三体", "#work 周报"},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			saveReviewSetting(ctx, t, svc, user.ID, test.setting)
			response, err := svc.ListReviewMemos(userCtx, &v1pb.ListReviewMemosRequest{LocalDate: "2026-09-26"})
			require.NoError(t, err)
			assert.ElementsMatch(t, test.want, reviewContents(t, response))
			assert.Equal(t, int32(len(test.want)), response.EligibleCount)
		})
	}
}

// TestListReviewMemos_ExcludesArchivedAndAssistantMemos pins the two kinds of
// memo that must never surface: one the author archived, and a reply an AI
// assistant wrote. An assistant reply is stored under the author like any other
// memo, so only its attribution distinguishes it.
func TestListReviewMemos_ExcludesArchivedAndAssistantMemos(t *testing.T) {
	ctx := context.Background()
	svc := newIntegrationService(t)
	user := createSpaceTestUser(ctx, t, svc, "reader", store.RoleUser)
	authorCtx := userCtx(ctx, user.ID)

	keep := createReviewMemo(ctx, t, svc, user.ID, "留下的笔记", 1)

	archived := createReviewMemo(ctx, t, svc, user.ID, "归档掉的笔记", 2)
	archivedStatus := store.Archived
	require.NoError(t, svc.Store.UpdateMemo(ctx, &store.UpdateMemo{ID: archived.ID, RowStatus: &archivedStatus}))

	// A comment the author typed is their own thought and stays eligible.
	comment, err := svc.CreateMemoComment(authorCtx, &v1pb.CreateMemoCommentRequest{
		Name:    buildMemoName(keep.UID),
		Comment: &v1pb.Memo{Content: "我自己写的批注", Visibility: v1pb.Visibility_PRIVATE},
	})
	require.NoError(t, err)
	require.NotNil(t, comment)

	// An assistant reply is not.
	assistantReply := createReviewMemo(ctx, t, svc, user.ID, "AI 写的点评", 1)
	require.NoError(t, svc.Store.UpdateMemo(ctx, &store.UpdateMemo{
		ID: assistantReply.ID,
		Payload: &storepb.MemoPayload{Assistant: &storepb.MemoPayload_AssistantAttribution{
			AssistantId: "reading", Title: "读书助手", Icon: "📗",
		}},
	}))

	response, err := svc.ListReviewMemos(authorCtx, &v1pb.ListReviewMemosRequest{LocalDate: "2026-09-26"})
	require.NoError(t, err)
	assert.ElementsMatch(t, []string{"留下的笔记", "我自己写的批注"}, reviewContents(t, response))
}

// TestListReviewMemos_SelectionIsStableForOneLocalDay is the property that makes
// "16 a day" mean anything: reopening the review must not reshuffle it, and the
// day boundary has to be the reader's rather than the server's.
func TestListReviewMemos_SelectionIsStableForOneLocalDay(t *testing.T) {
	ctx := context.Background()
	svc := newIntegrationService(t)
	user := createSpaceTestUser(ctx, t, svc, "reader", store.RoleUser)
	authorCtx := userCtx(ctx, user.ID)

	for index := range 40 {
		createReviewMemo(ctx, t, svc, user.ID, string(rune('a'+index%26))+"-note", index)
	}
	saveReviewSetting(ctx, t, svc, user.ID, &storepb.ReviewUserSetting{
		Condition: storepb.ReviewUserSetting_ALL_MEMOS, DailyCount: 5,
	})

	today, err := svc.ListReviewMemos(authorCtx, &v1pb.ListReviewMemosRequest{LocalDate: "2026-09-26"})
	require.NoError(t, err)
	require.Len(t, today.Memos, 5, "the daily count caps the selection")
	assert.Equal(t, int32(40), today.EligibleCount, "the eligible total is reported in full")

	again, err := svc.ListReviewMemos(authorCtx, &v1pb.ListReviewMemosRequest{LocalDate: "2026-09-26"})
	require.NoError(t, err)
	assert.Equal(t, reviewContents(t, today), reviewContents(t, again), "same day, same selection and order")

	tomorrow, err := svc.ListReviewMemos(authorCtx, &v1pb.ListReviewMemosRequest{LocalDate: "2026-09-27"})
	require.NoError(t, err)
	assert.NotEqual(t, reviewContents(t, today), reviewContents(t, tomorrow), "a new day draws again")
}

// TestListReviewMemos_OnlyReturnsTheCallersOwnMemos keeps the review private.
func TestListReviewMemos_OnlyReturnsTheCallersOwnMemos(t *testing.T) {
	ctx := context.Background()
	svc := newIntegrationService(t)
	mine := createSpaceTestUser(ctx, t, svc, "mine", store.RoleUser)
	theirs := createSpaceTestUser(ctx, t, svc, "theirs", store.RoleUser)

	createReviewMemo(ctx, t, svc, mine.ID, "我的笔记", 1)
	createReviewMemo(ctx, t, svc, theirs.ID, "别人的笔记", 1)

	response, err := svc.ListReviewMemos(userCtx(ctx, mine.ID), &v1pb.ListReviewMemosRequest{LocalDate: "2026-09-26"})
	require.NoError(t, err)
	assert.Equal(t, []string{"我的笔记"}, reviewContents(t, response))
}

func TestListReviewMemos_RejectsBadInput(t *testing.T) {
	ctx := context.Background()
	svc := newIntegrationService(t)
	user := createSpaceTestUser(ctx, t, svc, "reader", store.RoleUser)

	for _, localDate := range []string{"", "26/09/2026", "2026-9-26", "tomorrow"} {
		_, err := svc.ListReviewMemos(userCtx(ctx, user.ID), &v1pb.ListReviewMemosRequest{LocalDate: localDate})
		require.Error(t, err, localDate)
	}

	// An anonymous caller has no review at all.
	_, err := svc.ListReviewMemos(ctx, &v1pb.ListReviewMemosRequest{LocalDate: "2026-09-26"})
	require.Error(t, err)
}

// TestUpdateUserSettingRoundTripsReview covers the settings panel's write path,
// including the normalization the UI relies on.
func TestUpdateUserSettingRoundTripsReview(t *testing.T) {
	ctx := context.Background()
	svc := newIntegrationService(t)
	user := createSpaceTestUser(ctx, t, svc, "reader", store.RoleUser)
	authorCtx := userCtx(ctx, user.ID)
	name := BuildUserName(user.Username) + "/settings/REVIEW"

	// An unsaved setting still reads back as the default, so the panel has
	// something to render on first open.
	initial, err := svc.GetUserSetting(authorCtx, &v1pb.GetUserSettingRequest{Name: name})
	require.NoError(t, err)
	require.NotNil(t, initial.GetReviewSetting())
	assert.Equal(t, v1pb.UserSetting_ReviewSetting_ALL_MEMOS, initial.GetReviewSetting().GetCondition())
	assert.Equal(t, v1pb.UserSetting_ReviewSetting_ALL_TIME, initial.GetReviewSetting().GetTimeRange())
	assert.Equal(t, int32(defaultReviewDailyCount), initial.GetReviewSetting().GetDailyCount())

	updated, err := svc.UpdateUserSetting(authorCtx, &v1pb.UpdateUserSettingRequest{
		Setting: &v1pb.UserSetting{
			Name: name,
			Value: &v1pb.UserSetting_ReviewSetting_{ReviewSetting: &v1pb.UserSetting_ReviewSetting{
				Condition:  v1pb.UserSetting_ReviewSetting_INCLUDE_TAGS,
				Tags:       []string{" #book ", "book", "work/"},
				TimeRange:  v1pb.UserSetting_ReviewSetting_LAST_3_MONTHS,
				DailyCount: 5,
			}},
		},
		UpdateMask: &fieldmaskpb.FieldMask{Paths: []string{"review"}},
	})
	require.NoError(t, err)
	review := updated.GetReviewSetting()
	// Tags are stored in the bare, de-duplicated form the memo payload uses.
	assert.Equal(t, []string{"book", "work"}, review.GetTags())
	assert.Equal(t, v1pb.UserSetting_ReviewSetting_LAST_3_MONTHS, review.GetTimeRange())
	assert.Equal(t, int32(5), review.GetDailyCount())

	// Switching back to a condition that ignores tags must not keep the list
	// around to reappear later.
	cleared, err := svc.UpdateUserSetting(authorCtx, &v1pb.UpdateUserSettingRequest{
		Setting: &v1pb.UserSetting{
			Name: name,
			Value: &v1pb.UserSetting_ReviewSetting_{ReviewSetting: &v1pb.UserSetting_ReviewSetting{
				Condition: v1pb.UserSetting_ReviewSetting_ALL_MEMOS,
				Tags:      []string{"book"},
			}},
		},
		UpdateMask: &fieldmaskpb.FieldMask{Paths: []string{"review"}},
	})
	require.NoError(t, err)
	assert.Empty(t, cleared.GetReviewSetting().GetTags())

	for _, invalid := range []*v1pb.UserSetting_ReviewSetting{
		// A tag condition with no tag would silently match everything.
		{Condition: v1pb.UserSetting_ReviewSetting_INCLUDE_TAGS},
		{Condition: v1pb.UserSetting_ReviewSetting_EXCLUDE_TAGS, Tags: []string{"  "}},
		{Condition: v1pb.UserSetting_ReviewSetting_ALL_MEMOS, DailyCount: maxReviewDailyCount + 1},
	} {
		_, err := svc.UpdateUserSetting(authorCtx, &v1pb.UpdateUserSettingRequest{
			Setting: &v1pb.UserSetting{
				Name:  name,
				Value: &v1pb.UserSetting_ReviewSetting_{ReviewSetting: invalid},
			},
			UpdateMask: &fieldmaskpb.FieldMask{Paths: []string{"review"}},
		})
		require.Error(t, err)
	}
}
