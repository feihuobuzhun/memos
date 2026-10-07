package v1

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	v1pb "github.com/usememos/memos/proto/gen/api/v1"
	storepb "github.com/usememos/memos/proto/gen/store"
	"github.com/usememos/memos/provider/ai"
	"github.com/usememos/memos/provider/ai/chat"
	"github.com/usememos/memos/store"
)

// installStubDiaryMoodProvider configures a provider for diary readings and
// answers every call with the given text.
func installStubDiaryMoodProvider(ctx context.Context, t *testing.T, svc *APIV1Service, reply string) *stubCompleter {
	t.Helper()
	_, err := svc.Store.UpsertInstanceSetting(ctx, &storepb.InstanceSetting{
		Key: storepb.InstanceSettingKey_AI,
		Value: &storepb.InstanceSetting_AiSetting{AiSetting: &storepb.InstanceAISetting{
			Providers: []*storepb.AIProviderConfig{{
				Id: "provider-1", Title: "OpenAI", Type: storepb.AIProviderType_OPENAI, ApiKey: "sk-test",
			}},
			DiaryMood: &storepb.DiaryMoodConfig{
				Enabled: true, ProviderId: "provider-1", Model: "gpt-4o-mini",
			},
		}},
	})
	require.NoError(t, err)

	completer := &stubCompleter{text: reply}
	svc.diaryMoodCompleterOverride = func(ai.ProviderConfig) (chat.Completer, error) {
		return completer, nil
	}
	return completer
}

// createDiaryMemoAt writes a memo as the user with an exact creation instant,
// which is what decides the local day a diary entry belongs to.
func createDiaryMemoAt(ctx context.Context, t *testing.T, svc *APIV1Service, user *store.User, content string, at time.Time) *store.Memo {
	t.Helper()
	memo, err := svc.CreateMemo(userCtx(ctx, user.ID), &v1pb.CreateMemoRequest{
		Memo: &v1pb.Memo{Content: content, Visibility: v1pb.Visibility_PRIVATE},
	})
	require.NoError(t, err)
	stored := storeMemoByName(ctx, t, svc, memo.Name)
	unix := at.Unix()
	require.NoError(t, svc.Store.UpdateMemo(ctx, &store.UpdateMemo{ID: stored.ID, CreatedTs: &unix}))
	return stored
}

// TestAnalyzeDiaryMood_ReadsTheDayAndReusesTheReading covers the whole path:
// the configured tags select the day's entries, the reader's own offset decides
// which day they fall in, and an unchanged day is never sent twice.
func TestAnalyzeDiaryMood_ReadsTheDayAndReusesTheReading(t *testing.T) {
	ctx := context.Background()
	svc := newIntegrationService(t)
	author := createSpaceTestUser(ctx, t, svc, "writer", store.RoleUser)
	authorCtx := userCtx(ctx, author.ID)
	completer := installStubDiaryMoodProvider(ctx, t, svc,
		"```json\n{\"label\": \"平静\", \"emoji\": \"😌\", \"score\": 42, \"summary\": \"你今天过得安稳。\", \"keywords\": [\"散步\", \"散步\", \"读书\"]}\n```")

	// UTC+8, so the local day of 2026-03-14 runs from 2026-03-13T16:00Z.
	offset := int32(480)
	createDiaryMemoAt(ctx, t, svc, author, "#日记 早上去公园散步。", time.Date(2026, 3, 14, 9, 0, 0, 0, time.FixedZone("", 8*3600)))
	createDiaryMemoAt(ctx, t, svc, author, "#日记 晚上读了两章书。", time.Date(2026, 3, 14, 22, 0, 0, 0, time.FixedZone("", 8*3600)))
	// Same instant range in UTC terms but the next local day, and a memo that is
	// not a diary entry at all. Neither may reach the model.
	createDiaryMemoAt(ctx, t, svc, author, "#日记 第二天的事。", time.Date(2026, 3, 15, 1, 0, 0, 0, time.FixedZone("", 8*3600)))
	createDiaryMemoAt(ctx, t, svc, author, "#work 周报草稿。", time.Date(2026, 3, 14, 15, 0, 0, 0, time.FixedZone("", 8*3600)))

	response, err := svc.AnalyzeDiaryMood(authorCtx, &v1pb.AnalyzeDiaryMoodRequest{
		Date: "2026-03-14", UtcOffsetMinutes: offset,
	})
	require.NoError(t, err)
	require.NotNil(t, response.Mood)
	assert.Equal(t, "2026-03-14", response.Mood.GetDate())
	assert.Equal(t, "平静", response.Mood.GetLabel())
	assert.Equal(t, "😌", response.Mood.GetEmoji())
	assert.Equal(t, int32(42), response.Mood.GetScore())
	assert.Equal(t, int32(2), response.Mood.GetMemoCount())
	// Repeated keywords are collapsed rather than stored twice.
	assert.Equal(t, []string{"散步", "读书"}, response.Mood.GetKeywords())

	require.Len(t, completer.requests, 1)
	input := completer.requests[0].Input
	assert.Contains(t, input, "散步")
	assert.Contains(t, input, "两章书")
	assert.NotContains(t, input, "第二天的事")
	assert.NotContains(t, input, "周报草稿")

	// The stored reading is returned as it is while the day is unchanged, so
	// reopening the diary costs nothing.
	again, err := svc.AnalyzeDiaryMood(authorCtx, &v1pb.AnalyzeDiaryMoodRequest{
		Date: "2026-03-14", UtcOffsetMinutes: offset,
	})
	require.NoError(t, err)
	assert.Equal(t, "平静", again.Mood.GetLabel())
	assert.Len(t, completer.requests, 1)

	// Asking again on purpose does send the day again.
	forced, err := svc.AnalyzeDiaryMood(authorCtx, &v1pb.AnalyzeDiaryMoodRequest{
		Date: "2026-03-14", UtcOffsetMinutes: offset, Force: true,
	})
	require.NoError(t, err)
	assert.Equal(t, "平静", forced.Mood.GetLabel())
	assert.Len(t, completer.requests, 2)

	// A day is listed once, under the date it was read for.
	listed, err := svc.ListDiaryMoods(authorCtx, &v1pb.ListDiaryMoodsRequest{
		StartDate: "2026-03-01", EndDate: "2026-03-31",
	})
	require.NoError(t, err)
	require.Len(t, listed.Moods, 1)
	assert.Equal(t, "2026-03-14", listed.Moods[0].GetDate())
	assert.True(t, listed.Available)
}

// TestAnalyzeDiaryMood_EmptyDayCostsNothing keeps a day nobody wrote in from
// reaching the provider at all.
func TestAnalyzeDiaryMood_EmptyDayCostsNothing(t *testing.T) {
	ctx := context.Background()
	svc := newIntegrationService(t)
	author := createSpaceTestUser(ctx, t, svc, "writer", store.RoleUser)
	completer := installStubDiaryMoodProvider(ctx, t, svc, `{"label": "不该出现"}`)

	response, err := svc.AnalyzeDiaryMood(userCtx(ctx, author.ID), &v1pb.AnalyzeDiaryMoodRequest{
		Date: "2026-03-14",
	})
	require.NoError(t, err)
	assert.Nil(t, response.Mood)
	assert.Empty(t, completer.requests)
}

// TestAnalyzeDiaryMood_RespectsTheReadersChoice checks the personal opt-out: an
// instance may be fully configured and still never read someone's days.
func TestAnalyzeDiaryMood_RespectsTheReadersChoice(t *testing.T) {
	ctx := context.Background()
	svc := newIntegrationService(t)
	author := createSpaceTestUser(ctx, t, svc, "writer", store.RoleUser)
	authorCtx := userCtx(ctx, author.ID)
	installStubDiaryMoodProvider(ctx, t, svc, `{"label": "不该出现"}`)
	createDiaryMemoAt(ctx, t, svc, author, "#日记 今天还行。", time.Now().Add(-time.Hour))

	moodAnalysis := false
	_, err := svc.Store.UpsertUserSetting(ctx, &storepb.UserSetting{
		UserId: author.ID,
		Key:    storepb.UserSetting_DIARY,
		Value: &storepb.UserSetting_Diary{Diary: &storepb.DiaryUserSetting{
			Tags: []string{"日记"}, MoodAnalysis: &moodAnalysis,
		}},
	})
	require.NoError(t, err)

	_, err = svc.AnalyzeDiaryMood(authorCtx, &v1pb.AnalyzeDiaryMoodRequest{Date: "2026-03-14"})
	require.Error(t, err)
	assert.Equal(t, codes.FailedPrecondition, status.Code(err))

	// The diary itself keeps working; only the reading is off.
	listed, err := svc.ListDiaryMoods(authorCtx, &v1pb.ListDiaryMoodsRequest{
		StartDate: "2026-03-01", EndDate: "2026-03-31",
	})
	require.NoError(t, err)
	assert.False(t, listed.Available)
}

// TestAnalyzeDiaryMood_FollowsConfiguredTags proves the tag list is a setting
// rather than a hardcoded "diary".
func TestAnalyzeDiaryMood_FollowsConfiguredTags(t *testing.T) {
	ctx := context.Background()
	svc := newIntegrationService(t)
	author := createSpaceTestUser(ctx, t, svc, "writer", store.RoleUser)
	authorCtx := userCtx(ctx, author.ID)
	completer := installStubDiaryMoodProvider(ctx, t, svc, `{"label": "轻快", "emoji": "🙂", "score": 10, "summary": "你今天挺放松。"}`)

	_, err := svc.Store.UpsertUserSetting(ctx, &storepb.UserSetting{
		UserId: author.ID,
		Key:    storepb.UserSetting_DIARY,
		// A leading "#" is accepted from clients and normalized away on write.
		Value: &storepb.UserSetting_Diary{Diary: &storepb.DiaryUserSetting{Tags: []string{"碎碎念"}}},
	})
	require.NoError(t, err)

	at := time.Date(2026, 3, 14, 12, 0, 0, 0, time.UTC)
	createDiaryMemoAt(ctx, t, svc, author, "#碎碎念 今天想吃面。", at)
	createDiaryMemoAt(ctx, t, svc, author, "#日记 默认标签不再算数。", at)

	response, err := svc.AnalyzeDiaryMood(authorCtx, &v1pb.AnalyzeDiaryMoodRequest{Date: "2026-03-14"})
	require.NoError(t, err)
	require.NotNil(t, response.Mood)
	assert.Equal(t, int32(1), response.Mood.GetMemoCount())
	require.Len(t, completer.requests, 1)
	assert.Contains(t, completer.requests[0].Input, "想吃面")
	assert.NotContains(t, completer.requests[0].Input, "默认标签")
}

func TestParseDiaryMoodResponse(t *testing.T) {
	t.Run("prose around the object", func(t *testing.T) {
		mood, err := parseDiaryMoodResponse("Sure! {\"label\":\"calm\",\"score\":5.6} Hope that helps.")
		require.NoError(t, err)
		assert.Equal(t, "calm", mood.GetLabel())
		// A fractional score from a model that ignored "integer" is truncated
		// rather than rejected.
		assert.Equal(t, int32(5), mood.GetScore())
	})
	t.Run("score is clamped", func(t *testing.T) {
		mood, err := parseDiaryMoodResponse(`{"label":"elated","score":999}`)
		require.NoError(t, err)
		assert.Equal(t, int32(100), mood.GetScore())
	})
	t.Run("no object", func(t *testing.T) {
		_, err := parseDiaryMoodResponse("I cannot help with that.")
		require.Error(t, err)
	})
	t.Run("empty object", func(t *testing.T) {
		_, err := parseDiaryMoodResponse("{}")
		require.Error(t, err)
	})
}

func TestNormalizeDiarySetting(t *testing.T) {
	setting := &storepb.DiaryUserSetting{Tags: []string{" #日记 ", "日记", "diary/", "", "#"}}
	require.NoError(t, normalizeDiarySetting(setting))
	assert.Equal(t, []string{"日记", "diary"}, setting.GetTags())

	// An empty list is "I never chose", so the diary falls back to its defaults
	// instead of selecting every memo ever written.
	assert.Equal(t, defaultDiaryTags, effectiveDiaryTags(&storepb.DiaryUserSetting{}))
	assert.Equal(t, []string{"日记", "diary"}, effectiveDiaryTags(setting))

	// Mood analysis is on until someone says otherwise.
	assert.True(t, diaryMoodAnalysisEnabled(&storepb.DiaryUserSetting{}))
	off := false
	assert.False(t, diaryMoodAnalysisEnabled(&storepb.DiaryUserSetting{MoodAnalysis: &off}))
}

func TestDiaryDayWindow(t *testing.T) {
	date, err := parseDiaryDate("2026-03-14")
	require.NoError(t, err)

	start, end := diaryDayWindow(date, 480)
	assert.Equal(t, time.Date(2026, 3, 13, 16, 0, 0, 0, time.UTC), start.UTC())
	assert.Equal(t, time.Date(2026, 3, 14, 16, 0, 0, 0, time.UTC), end.UTC())

	start, end = diaryDayWindow(date, 0)
	assert.Equal(t, time.Date(2026, 3, 14, 0, 0, 0, 0, time.UTC), start.UTC())
	assert.Equal(t, time.Date(2026, 3, 15, 0, 0, 0, 0, time.UTC), end.UTC())

	_, err = parseDiaryDate("14/03/2026")
	require.Error(t, err)
}

// TestAnalyzeDiaryMood_CarriesRecentTrendAsContext checks that an already
// stored reading of a nearby day rides along as compact context, without
// resending that day's own diary text.
func TestAnalyzeDiaryMood_CarriesRecentTrendAsContext(t *testing.T) {
	ctx := context.Background()
	svc := newIntegrationService(t)
	author := createSpaceTestUser(ctx, t, svc, "writer", store.RoleUser)
	authorCtx := userCtx(ctx, author.ID)
	completer := installStubDiaryMoodProvider(ctx, t, svc,
		`{"label": "平静", "score": 10, "summary": "还好。"}`)

	createDiaryMemoAt(ctx, t, svc, author, "#日记 第一天写的内容。", time.Date(2026, 3, 13, 12, 0, 0, 0, time.UTC))
	first, err := svc.AnalyzeDiaryMood(authorCtx, &v1pb.AnalyzeDiaryMoodRequest{Date: "2026-03-13"})
	require.NoError(t, err)
	require.NotNil(t, first.Mood)

	createDiaryMemoAt(ctx, t, svc, author, "#日记 第二天写的内容。", time.Date(2026, 3, 14, 12, 0, 0, 0, time.UTC))
	second, err := svc.AnalyzeDiaryMood(authorCtx, &v1pb.AnalyzeDiaryMoodRequest{Date: "2026-03-14"})
	require.NoError(t, err)
	require.NotNil(t, second.Mood)

	require.Len(t, completer.requests, 2)
	// The first day had no earlier reading to draw on.
	assert.NotContains(t, completer.requests[0].Input, "Recent mood trend")
	// The second day's prompt carries the first day's stored reading as
	// context, but never the first day's own diary text.
	secondInput := completer.requests[1].Input
	assert.Contains(t, secondInput, "Recent mood trend")
	assert.Contains(t, secondInput, "2026-03-13: 平静")
	assert.Contains(t, secondInput, "第二天写的内容")
	assert.NotContains(t, secondInput, "第一天写的内容")
}
