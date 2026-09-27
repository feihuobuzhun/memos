package v1

import (
	"context"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"math/rand/v2"
	"strings"
	"time"

	"github.com/pkg/errors"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	v1pb "github.com/usememos/memos/proto/gen/api/v1"
	storepb "github.com/usememos/memos/proto/gen/store"
	"github.com/usememos/memos/store"
)

// maxReviewCandidates bounds how many eligible memos are considered when
// drawing a day's review. Only identifiers are read, so this stays cheap even
// for an archive of years, and a sample drawn from the most recent twenty
// thousand memos is indistinguishable from one drawn from all of them.
const maxReviewCandidates = 20000

// ListReviewMemos returns today's review: a stable sample of the caller's own
// memos, drawn from the memos their review setting makes eligible.
func (s *APIV1Service) ListReviewMemos(ctx context.Context, request *v1pb.ListReviewMemosRequest) (*v1pb.ListReviewMemosResponse, error) {
	localDate, err := parseReviewLocalDate(request.GetLocalDate())
	if err != nil {
		return nil, status.Errorf(codes.InvalidArgument, "invalid local_date: %v", err)
	}

	user, err := s.fetchCurrentUser(ctx)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to get current user: %v", err)
	}
	if user == nil {
		return nil, status.Errorf(codes.Unauthenticated, "user not authenticated")
	}

	setting, err := s.loadReviewSetting(ctx, user.ID)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to read review setting: %v", err)
	}

	candidates, err := s.listReviewCandidates(ctx, user.ID, setting)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to list review candidates: %v", err)
	}
	if len(candidates) == 0 {
		return &v1pb.ListReviewMemosResponse{}, nil
	}

	selected := selectDailyReviewIDs(candidates, int(setting.GetDailyCount()), user.ID, localDate)
	memos, err := s.Store.ListMemos(ctx, &store.FindMemo{IDList: selected})
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to load review memos: %v", err)
	}
	// The store returns its own order; restore the drawn order so the sequence
	// the reader steps through is the one the seed decided.
	byID := make(map[int32]*store.Memo, len(memos))
	for _, memo := range memos {
		byID[memo.ID] = memo
	}
	ordered := make([]*store.Memo, 0, len(selected))
	for _, id := range selected {
		if memo, ok := byID[id]; ok {
			ordered = append(ordered, memo)
		}
	}

	memoMessages, err := s.convertMemoListFromStore(ctx, ordered)
	if err != nil {
		return nil, err
	}
	return &v1pb.ListReviewMemosResponse{
		Memos:         memoMessages,
		EligibleCount: int32(len(candidates)),
	}, nil
}

// parseReviewLocalDate accepts the caller's own calendar date. It is only ever
// used as part of a shuffle seed, so it needs a shape, not a time zone.
func parseReviewLocalDate(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", errors.New("local_date is required")
	}
	if _, err := time.Parse(time.DateOnly, value); err != nil {
		return "", errors.Wrap(err, "local_date must be formatted as YYYY-MM-DD")
	}
	return value, nil
}

// listReviewCandidates returns the IDs of every memo the setting makes
// eligible, newest first. Content is excluded: the full memos are loaded only
// for the few that end up in the day's selection.
func (s *APIV1Service) listReviewCandidates(
	ctx context.Context,
	userID int32,
	setting *storepb.ReviewUserSetting,
) ([]int32, error) {
	limit := maxReviewCandidates
	find := &store.FindMemo{
		CreatorID: &userID,
		// Archived memos are deliberately out of reach: archiving is how someone
		// says "stop showing me this".
		RowStatus: rowStatusPtr(store.Normal),
		// A review is for the author's own writing. A reply written by an AI
		// assistant is stored under the author too, so it has to be excluded by
		// attribution rather than by authorship.
		Filters:        []string{"!has_assistant"},
		ExcludeContent: true,
		Limit:          &limit,
	}
	// Comments are included: an annotation written during a review is a
	// top-level memo, but a reply the author typed under a memo is still their
	// own thought and worth meeting again.
	find.ExcludeComments = false

	if expression := reviewConditionFilter(setting); expression != "" {
		find.Filters = append(find.Filters, expression)
	}
	if expression := reviewTimeRangeFilter(setting.GetTimeRange()); expression != "" {
		find.Filters = append(find.Filters, expression)
	}

	memos, err := s.Store.ListMemos(ctx, find)
	if err != nil {
		return nil, err
	}
	ids := make([]int32, 0, len(memos))
	for _, memo := range memos {
		ids = append(ids, memo.ID)
	}
	return ids, nil
}

// reviewConditionFilter renders the tag condition as a CEL expression. Tag
// membership matches nested children too, so "book" also reaches "book/novel".
func reviewConditionFilter(setting *storepb.ReviewUserSetting) string {
	switch setting.GetCondition() {
	case storepb.ReviewUserSetting_INCLUDE_TAGS:
		return fmt.Sprintf("tag in %s", celStringList(setting.GetTags()))
	case storepb.ReviewUserSetting_EXCLUDE_TAGS:
		return fmt.Sprintf("!(tag in %s)", celStringList(setting.GetTags()))
	case storepb.ReviewUserSetting_UNTAGGED:
		return "size(tags) == 0"
	default:
		return ""
	}
}

func reviewTimeRangeFilter(timeRange storepb.ReviewUserSetting_TimeRange) string {
	// Rendered as a duration back from now rather than a stored instant, so a
	// saved setting keeps meaning the same thing as the days pass.
	var window string
	switch timeRange {
	case storepb.ReviewUserSetting_LAST_MONTH:
		window = "720h"
	case storepb.ReviewUserSetting_LAST_3_MONTHS:
		window = "2160h"
	case storepb.ReviewUserSetting_LAST_6_MONTHS:
		window = "4320h"
	case storepb.ReviewUserSetting_LAST_YEAR:
		window = "8760h"
	default:
		return ""
	}
	return fmt.Sprintf("created_ts >= now - duration(%q)", window)
}

// celStringList renders a CEL list literal. JSON string quoting matches CEL's,
// so a tag containing a quote or a backslash cannot break out of the literal.
func celStringList(values []string) string {
	quoted := make([]string, 0, len(values))
	for _, value := range values {
		encoded, err := json.Marshal(value)
		if err != nil {
			continue
		}
		quoted = append(quoted, string(encoded))
	}
	return "[" + strings.Join(quoted, ", ") + "]"
}

// selectDailyReviewIDs draws one day's review. The seed is the reader and the
// reader's own calendar date, so the selection and its order hold steady for a
// day however often the dialog is reopened, and turn over at their midnight
// rather than the server's.
func selectDailyReviewIDs(candidates []int32, count int, userID int32, localDate string) []int32 {
	if count <= 0 || len(candidates) == 0 {
		return nil
	}
	shuffled := append([]int32(nil), candidates...)

	digest := fnv.New64a()
	fmt.Fprintf(digest, "memos-daily-review:%d:%s", userID, localDate)
	seed := digest.Sum64()
	// Two distinct words, so the generator does not start from a state whose
	// halves are equal.
	generator := rand.New(rand.NewPCG(seed, seed^0x9e3779b97f4a7c15))
	generator.Shuffle(len(shuffled), func(i, j int) {
		shuffled[i], shuffled[j] = shuffled[j], shuffled[i]
	})

	return shuffled[:min(count, len(shuffled))]
}
