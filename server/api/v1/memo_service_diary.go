package v1

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/pkg/errors"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/timestamppb"

	"github.com/usememos/memos/internal/ratelimit"
	v1pb "github.com/usememos/memos/proto/gen/api/v1"
	storepb "github.com/usememos/memos/proto/gen/store"
	"github.com/usememos/memos/provider/ai"
	"github.com/usememos/memos/provider/ai/chat"
	"github.com/usememos/memos/store"
)

const (
	// maxStoredDiaryMoods bounds the readings kept per user. A reading is
	// derived from its day's memos and can always be taken again, so the oldest
	// are dropped rather than growing the setting without limit.
	maxStoredDiaryMoods = 730
	// maxDiaryMoodRangeDays bounds one ListDiaryMoods call.
	maxDiaryMoodRangeDays = 400
	// maxDiaryMoodDayMemos bounds how many of a day's memos are read. A day
	// with more than this is read from its first entries.
	maxDiaryMoodDayMemos = 24
	// maxDiaryMoodMemoChars bounds one entry inside the prompt.
	maxDiaryMoodMemoChars = 2000
	// maxDiaryMoodInputChars bounds the whole day sent to the model.
	maxDiaryMoodInputChars = 8000
	// diaryMoodResponseMaxTokens bounds the model response length.
	diaryMoodResponseMaxTokens = 600
	// diaryMoodTimeout bounds one reading, including the provider call.
	diaryMoodTimeout = 90 * time.Second
	// maxDiaryMoodLabelChars bounds the stored mood label.
	maxDiaryMoodLabelChars = 40
	// maxDiaryMoodEmojiBytes bounds the stored emoji. Grapheme clusters with
	// skin-tone or ZWJ sequences need well over a single rune.
	maxDiaryMoodEmojiBytes = 32
	// maxDiaryMoodSummaryChars bounds the stored summary.
	maxDiaryMoodSummaryChars = 400
	// maxDiaryMoodKeywords bounds the stored keywords.
	maxDiaryMoodKeywords = 5
	// maxDiaryMoodKeywordChars bounds one stored keyword.
	maxDiaryMoodKeywordChars = 40
	// maxDiaryMoodContextDays bounds how many days before the one being read
	// are shown as trend context. The context is built from readings already
	// taken, not reprocessed diary text, so it costs nothing extra to include.
	maxDiaryMoodContextDays = 7

	// defaultDiaryMoodPrompt is used when no custom prompt is configured. The
	// structural labels stay in English so they read the same to every model;
	// the reply follows the diary's own language.
	defaultDiaryMoodPrompt = `You read one day of someone's personal diary and name the mood it was written in.
Reply with a single JSON object and nothing else, shaped exactly like this:
{"label": "...", "emoji": "...", "score": 0, "summary": "...", "keywords": ["..."]}
- label: two to four words naming the day's dominant mood, in the language the diary is written in.
- emoji: one emoji standing for that mood.
- score: an integer from -100 (bleak) to 100 (bright) for how the day reads overall.
- summary: one or two sentences addressed to the author as "you", saying what the mood was and what carried it.
- keywords: up to four short phrases naming what the day turned on, in the diary's language.
Judge only what the entries say. Do not give advice, do not diagnose, and do not invent anything that is not written down.`
)

// ListDiaryMoods returns the readings already taken of the caller's diary days
// inside a date range. It never calls a provider: a client renders the diary
// from what is stored and asks for a reading separately.
func (s *APIV1Service) ListDiaryMoods(ctx context.Context, request *v1pb.ListDiaryMoodsRequest) (*v1pb.ListDiaryMoodsResponse, error) {
	startDate, err := parseDiaryDate(request.GetStartDate())
	if err != nil {
		return nil, status.Errorf(codes.InvalidArgument, "invalid start_date: %v", err)
	}
	endDate, err := parseDiaryDate(request.GetEndDate())
	if err != nil {
		return nil, status.Errorf(codes.InvalidArgument, "invalid end_date: %v", err)
	}
	if endDate.Before(startDate) {
		return nil, status.Errorf(codes.InvalidArgument, "end_date must not be before start_date")
	}
	if endDate.Sub(startDate).Hours()/24 > maxDiaryMoodRangeDays {
		return nil, status.Errorf(codes.InvalidArgument, "date range is too wide; maximum is %d days", maxDiaryMoodRangeDays)
	}

	user, err := s.fetchCurrentUser(ctx)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to get current user: %v", err)
	}
	if user == nil {
		return nil, status.Errorf(codes.Unauthenticated, "user not authenticated")
	}

	stored, err := s.loadDiaryMoods(ctx, user.ID)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to read diary moods: %v", err)
	}
	start, end := request.GetStartDate(), request.GetEndDate()
	moods := make([]*v1pb.DiaryMood, 0, len(stored))
	for _, mood := range stored {
		// Dates are "YYYY-MM-DD", so a lexicographic comparison is a calendar one.
		if mood.GetDate() < start || mood.GetDate() > end {
			continue
		}
		moods = append(moods, convertDiaryMoodFromStore(mood))
	}

	available, err := s.diaryMoodAvailable(ctx, user.ID)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to resolve diary mood configuration: %v", err)
	}
	return &v1pb.ListDiaryMoodsResponse{Moods: moods, Available: available}, nil
}

// AnalyzeDiaryMood reads one diary day and stores the result. The stored
// reading is returned untouched while the day's memos are unchanged, so a
// client may ask for a day as often as it likes without paying for it twice.
func (s *APIV1Service) AnalyzeDiaryMood(ctx context.Context, request *v1pb.AnalyzeDiaryMoodRequest) (*v1pb.AnalyzeDiaryMoodResponse, error) {
	date, err := parseDiaryDate(request.GetDate())
	if err != nil {
		return nil, status.Errorf(codes.InvalidArgument, "invalid date: %v", err)
	}
	offset := int(request.GetUtcOffsetMinutes())
	if offset < -14*60 || offset > 14*60 {
		return nil, status.Errorf(codes.InvalidArgument, "utc_offset_minutes is outside the range of real time zones")
	}

	user, err := s.fetchCurrentUser(ctx)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to get current user: %v", err)
	}
	if user == nil {
		return nil, status.Errorf(codes.Unauthenticated, "user not authenticated")
	}
	// A reading is one provider call, so it is charged like the other calls
	// that spend someone else's tokens.
	if err := s.throttleAndCharge(ratelimit.ScopeDiaryMoodUser, userKey(user.ID), 1); err != nil {
		return nil, err
	}

	diarySetting, err := s.loadDiarySetting(ctx, user.ID)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to read diary setting: %v", err)
	}
	if !diaryMoodAnalysisEnabled(diarySetting) {
		return nil, status.Errorf(codes.FailedPrecondition, "diary mood analysis is turned off for this account")
	}

	aiSetting, err := s.Store.GetInstanceAISetting(ctx)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to read AI setting: %v", err)
	}
	config := aiSetting.GetDiaryMood()
	if !config.GetEnabled() || config.GetProviderId() == "" {
		return nil, status.Errorf(codes.FailedPrecondition, "this instance has no diary mood provider configured")
	}
	provider, err := resolveDiaryMoodProvider(aiSetting, config)
	if err != nil {
		return nil, status.Errorf(codes.FailedPrecondition, "%v", err)
	}
	model := strings.TrimSpace(config.GetModel())
	if model == "" {
		model, err = ai.DefaultChatModel(provider.Type)
		if err != nil {
			return nil, status.Errorf(codes.FailedPrecondition, "%v", err)
		}
	}
	prompt := strings.TrimSpace(config.GetPrompt())
	if prompt == "" {
		prompt = defaultDiaryMoodPrompt
	}

	memos, err := s.listDiaryMemosForDay(ctx, user.ID, diarySetting, date, offset)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to list the day's diary memos: %v", err)
	}
	if len(memos) == 0 {
		// Nothing was written, so there is nothing to read. An empty response
		// is the honest answer and costs the caller no provider call.
		return &v1pb.AnalyzeDiaryMoodResponse{}, nil
	}

	// Loaded once and reused for both the no-op check below and the trend
	// context handed to the model: both read the same stored readings.
	stored, err := s.loadDiaryMoods(ctx, user.ID)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to read diary moods: %v", err)
	}

	digest := diaryDayDigest(request.GetDate(), model, prompt, memos)
	if !request.GetForce() {
		for _, mood := range stored {
			if mood.GetDate() == request.GetDate() && mood.GetSourceDigest() == digest {
				return &v1pb.AnalyzeDiaryMoodResponse{Mood: convertDiaryMoodFromStore(mood)}, nil
			}
		}
	}

	completer, err := s.diaryMoodCompleter(provider)
	if err != nil {
		return nil, status.Errorf(codes.FailedPrecondition, "%v", err)
	}
	readCtx, cancel := context.WithTimeout(ctx, diaryMoodTimeout)
	defer cancel()
	trendContext := buildDiaryMoodContext(request.GetDate(), stored)
	response, err := completer.Complete(readCtx, chat.Request{
		Model:        model,
		Instructions: prompt,
		Input:        buildDiaryMoodInput(request.GetDate(), memos, trendContext),
		MaxTokens:    diaryMoodResponseMaxTokens,
	})
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to read the day's mood: %v", err)
	}
	mood, err := parseDiaryMoodResponse(response.Text)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "the model did not answer with a mood: %v", err)
	}
	mood.Date = request.GetDate()
	mood.MemoCount = int32(len(memos))
	mood.SourceDigest = digest
	mood.Model = model
	mood.UpdatedTs = time.Now().Unix()

	if err := s.saveDiaryMood(ctx, user.ID, mood); err != nil {
		return nil, status.Errorf(codes.Internal, "failed to store the day's mood: %v", err)
	}
	return &v1pb.AnalyzeDiaryMoodResponse{Mood: convertDiaryMoodFromStore(mood)}, nil
}

// parseDiaryDate accepts a caller's own calendar day. Their day, not the
// server's: a diary rolls over at the writer's midnight.
func parseDiaryDate(value string) (time.Time, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return time.Time{}, errors.New("a date is required")
	}
	parsed, err := time.Parse(time.DateOnly, value)
	if err != nil {
		return time.Time{}, errors.Wrap(err, "a date must be formatted as YYYY-MM-DD")
	}
	return parsed, nil
}

// diaryDayWindow turns a calendar day and the caller's offset from UTC into the
// instants that bound it.
func diaryDayWindow(date time.Time, offsetMinutes int) (start, end time.Time) {
	zone := time.FixedZone("", offsetMinutes*60)
	start = time.Date(date.Year(), date.Month(), date.Day(), 0, 0, 0, 0, zone)
	return start, start.Add(24 * time.Hour)
}

// listDiaryMemosForDay returns the author's diary memos written on one of their
// days, oldest first, which is the order the day was lived in.
func (s *APIV1Service) listDiaryMemosForDay(
	ctx context.Context,
	userID int32,
	setting *storepb.DiaryUserSetting,
	date time.Time,
	offsetMinutes int,
) ([]*store.Memo, error) {
	start, end := diaryDayWindow(date, offsetMinutes)
	limit := maxDiaryMoodDayMemos
	find := &store.FindMemo{
		CreatorID: &userID,
		// Archiving is how someone says "stop showing me this", and a trashed
		// day should not be read either.
		RowStatus: rowStatusPtr(store.Normal),
		// A diary entry is a memo of its own. Comments are replies, and in this
		// fork most of them were written by an assistant rather than the author.
		ExcludeComments: true,
		Filters: []string{
			diaryTagFilter(setting),
			fmt.Sprintf("created_ts >= timestamp(%d)", start.Unix()),
			fmt.Sprintf("created_ts < timestamp(%d)", end.Unix()),
			"!has_assistant",
		},
		OrderByTimeAsc: true,
		Limit:          &limit,
	}
	return s.Store.ListMemos(ctx, find)
}

// diaryTagFilter renders the diary's tag condition as a CEL expression. Tag
// membership reaches nested children, so "diary" also selects "diary/travel".
func diaryTagFilter(setting *storepb.DiaryUserSetting) string {
	return fmt.Sprintf("tag in %s", celStringList(effectiveDiaryTags(setting)))
}

// diaryDayDigest identifies everything a reading depends on: the day, the
// entries and their revisions, and the model and prompt that read them. An
// unchanged digest means a new reading would say the same thing.
func diaryDayDigest(date, model, prompt string, memos []*store.Memo) string {
	digest := sha256.New()
	fmt.Fprintf(digest, "memos-diary-mood:%s\x00%s\x00", date, model)
	promptDigest := sha256.Sum256([]byte(prompt))
	digest.Write(promptDigest[:])
	for _, memo := range memos {
		fmt.Fprintf(digest, "\x00%d:%d", memo.ID, memo.UpdatedTs)
	}
	return hex.EncodeToString(digest.Sum(nil))
}

// buildDiaryMoodContext renders a compact trend of the stored readings for
// the days right before the one being read. It is built entirely from
// readings already taken — never from the earlier days' own diary text — so a
// long history costs nothing extra to include: there is nothing left to pay
// a provider for.
func buildDiaryMoodContext(date string, stored []*storepb.DiaryMood) string {
	parsedDate, err := parseDiaryDate(date)
	if err != nil {
		return ""
	}
	cutoff := parsedDate.AddDate(0, 0, -maxDiaryMoodContextDays).Format(time.DateOnly)

	var matched []*storepb.DiaryMood
	for _, mood := range stored {
		if d := mood.GetDate(); d < date && d >= cutoff {
			matched = append(matched, mood)
		}
	}
	if len(matched) == 0 {
		return ""
	}
	// stored sorts newest first; the trend reads forward from the earliest day.
	slices.Reverse(matched)

	var builder strings.Builder
	builder.WriteString("# Recent mood trend (context only)\n")
	builder.WriteString("These are readings already taken of the days just before this one. They are " +
		"for background only: judge today from today's own entries below, not from this trend.\n")
	for _, mood := range matched {
		fmt.Fprintf(&builder, "- %s: %s", mood.GetDate(), strings.TrimSpace(mood.GetLabel()))
		fmt.Fprintf(&builder, " (score %d)", mood.GetScore())
		if len(mood.GetKeywords()) > 0 {
			fmt.Fprintf(&builder, " — %s", strings.Join(mood.GetKeywords(), ", "))
		}
		builder.WriteString("\n")
	}
	return builder.String()
}

// buildDiaryMoodInput renders the day as the user payload sent alongside the
// prompt. Entries keep their clock time, because "wrote this at 2am" is part of
// what a day felt like. The trend context, if any, is rendered first and kept
// separate from the day's own entries.
func buildDiaryMoodInput(date string, memos []*store.Memo, trendContext string) string {
	var builder strings.Builder
	if trendContext != "" {
		builder.WriteString(trendContext)
		builder.WriteString("\n")
	}
	fmt.Fprintf(&builder, "# Diary day %s\n", date)
	remaining := maxDiaryMoodInputChars
	for _, memo := range memos {
		content := strings.TrimSpace(truncateRunes(memo.Content, maxDiaryMoodMemoChars))
		if content == "" {
			continue
		}
		if len(content) > remaining {
			break
		}
		remaining -= len(content)
		fmt.Fprintf(&builder, "\n## %s\n%s\n", time.Unix(memo.CreatedTs, 0).UTC().Format("15:04"), content)
	}
	return builder.String()
}

// diaryMoodReading is the JSON shape the prompt asks for. Every field is
// optional on the way in: a model that omits one should cost the reader a
// thinner reading, not an error.
type diaryMoodReading struct {
	Label    string   `json:"label"`
	Emoji    string   `json:"emoji"`
	Score    *float64 `json:"score"`
	Summary  string   `json:"summary"`
	Keywords []string `json:"keywords"`
}

// parseDiaryMoodResponse reads the model's answer. Models wrap JSON in prose or
// a code fence often enough that the object is located rather than assumed, but
// an answer with no object at all is an error: a mood invented here would be
// indistinguishable from one the model actually found.
func parseDiaryMoodResponse(text string) (*storepb.DiaryMood, error) {
	object, err := extractJSONObject(text)
	if err != nil {
		return nil, err
	}
	var reading diaryMoodReading
	if err := json.Unmarshal([]byte(object), &reading); err != nil {
		return nil, errors.Wrap(err, "failed to parse the mood object")
	}

	mood := &storepb.DiaryMood{
		Label:   strings.TrimSpace(truncateRunes(reading.Label, maxDiaryMoodLabelChars)),
		Summary: strings.TrimSpace(truncateRunes(reading.Summary, maxDiaryMoodSummaryChars)),
	}
	if emoji := strings.TrimSpace(reading.Emoji); len(emoji) <= maxDiaryMoodEmojiBytes {
		mood.Emoji = emoji
	}
	if reading.Score != nil {
		mood.Score = int32(max(min(*reading.Score, 100), -100))
	}
	for _, keyword := range reading.Keywords {
		keyword = strings.TrimSpace(truncateRunes(keyword, maxDiaryMoodKeywordChars))
		if keyword == "" || slices.Contains(mood.Keywords, keyword) {
			continue
		}
		mood.Keywords = append(mood.Keywords, keyword)
		if len(mood.Keywords) == maxDiaryMoodKeywords {
			break
		}
	}
	if mood.Label == "" && mood.Summary == "" {
		return nil, errors.New("the mood object named neither a mood nor a summary")
	}
	return mood, nil
}

// extractJSONObject returns the outermost JSON object in text, tolerating a
// code fence or a sentence around it.
func extractJSONObject(text string) (string, error) {
	start := strings.Index(text, "{")
	end := strings.LastIndex(text, "}")
	if start < 0 || end <= start {
		return "", errors.New("the response contained no JSON object")
	}
	return text[start : end+1], nil
}

// loadDiaryMoods returns the user's stored readings, newest day first.
func (s *APIV1Service) loadDiaryMoods(ctx context.Context, userID int32) ([]*storepb.DiaryMood, error) {
	stored, err := s.Store.GetUserSetting(ctx, &store.FindUserSetting{
		UserID: &userID,
		Key:    storepb.UserSetting_DIARY_MOODS,
	})
	if err != nil {
		return nil, err
	}
	moods := stored.GetDiaryMoods().GetMoods()
	slices.SortFunc(moods, func(a, b *storepb.DiaryMood) int {
		return strings.Compare(b.GetDate(), a.GetDate())
	})
	return moods, nil
}

// saveDiaryMood stores one day's reading, replacing any earlier reading of the
// same day and dropping the oldest once the list is full.
//
// The whole list lives in one setting row, so the read-modify-write is
// serialized here; two days read at once would otherwise lose one of them.
func (s *APIV1Service) saveDiaryMood(ctx context.Context, userID int32, mood *storepb.DiaryMood) error {
	s.diaryMoodWriteMu.Lock()
	defer s.diaryMoodWriteMu.Unlock()

	moods, err := s.loadDiaryMoods(ctx, userID)
	if err != nil {
		return err
	}
	updated := make([]*storepb.DiaryMood, 0, len(moods)+1)
	updated = append(updated, mood)
	for _, existing := range moods {
		if existing.GetDate() == mood.GetDate() {
			continue
		}
		updated = append(updated, existing)
	}
	slices.SortFunc(updated, func(a, b *storepb.DiaryMood) int {
		return strings.Compare(b.GetDate(), a.GetDate())
	})
	if len(updated) > maxStoredDiaryMoods {
		updated = updated[:maxStoredDiaryMoods]
	}

	_, err = s.Store.UpsertUserSetting(ctx, &storepb.UserSetting{
		UserId: userID,
		Key:    storepb.UserSetting_DIARY_MOODS,
		Value: &storepb.UserSetting_DiaryMoods{
			DiaryMoods: &storepb.DiaryMoodsUserSetting{Moods: updated},
		},
	})
	return err
}

// diaryMoodAvailable reports whether a reading could be taken right now: the
// instance has a usable provider and this reader has not turned readings off.
// The AI setting is admin-only, so this is how a client learns the answer.
func (s *APIV1Service) diaryMoodAvailable(ctx context.Context, userID int32) (bool, error) {
	diarySetting, err := s.loadDiarySetting(ctx, userID)
	if err != nil {
		return false, err
	}
	if !diaryMoodAnalysisEnabled(diarySetting) {
		return false, nil
	}
	aiSetting, err := s.Store.GetInstanceAISetting(ctx)
	if err != nil {
		return false, err
	}
	config := aiSetting.GetDiaryMood()
	if !config.GetEnabled() {
		return false, nil
	}
	// A provider that cannot be resolved is not an error here: the answer to
	// "could a reading be taken right now" is simply no.
	_, providerErr := resolveDiaryMoodProvider(aiSetting, config)
	return providerErr == nil, nil
}

func resolveDiaryMoodProvider(
	setting *storepb.InstanceAISetting,
	config *storepb.DiaryMoodConfig,
) (ai.ProviderConfig, error) {
	providers := make([]ai.ProviderConfig, 0, len(setting.GetProviders()))
	for _, provider := range setting.GetProviders() {
		if provider == nil {
			continue
		}
		providers = append(providers, convertAIProviderConfigFromStore(provider))
	}
	provider, err := ai.FindProvider(providers, config.GetProviderId())
	if err != nil {
		return ai.ProviderConfig{}, errors.Wrap(err, "the configured diary mood provider is not available")
	}
	return *provider, nil
}

// diaryMoodCompleter builds the chat client for one reading. The indirection
// exists so a test can exercise the whole path — tags, day window, digest
// reuse, storage — without a provider.
func (s *APIV1Service) diaryMoodCompleter(provider ai.ProviderConfig) (chat.Completer, error) {
	if s.diaryMoodCompleterOverride != nil {
		return s.diaryMoodCompleterOverride(provider)
	}
	return newAssistantCompleter(provider)
}

func convertDiaryMoodFromStore(mood *storepb.DiaryMood) *v1pb.DiaryMood {
	if mood == nil {
		return nil
	}
	converted := &v1pb.DiaryMood{
		Date:      mood.GetDate(),
		Label:     mood.GetLabel(),
		Emoji:     mood.GetEmoji(),
		Score:     mood.GetScore(),
		Summary:   mood.GetSummary(),
		Keywords:  append([]string(nil), mood.GetKeywords()...),
		MemoCount: mood.GetMemoCount(),
	}
	if mood.GetUpdatedTs() > 0 {
		converted.UpdateTime = timestamppb.New(time.Unix(mood.GetUpdatedTs(), 0))
	}
	return converted
}
