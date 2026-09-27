package v1

import (
	"context"
	"strings"

	"github.com/pkg/errors"

	v1pb "github.com/usememos/memos/proto/gen/api/v1"
	storepb "github.com/usememos/memos/proto/gen/store"
	"github.com/usememos/memos/store"
)

const (
	// defaultReviewDailyCount matches what most people want without thinking
	// about it: a short stack that can be read in one sitting.
	defaultReviewDailyCount = 16
	// maxReviewDailyCount bounds one day's review. The whole selection is loaded
	// with content in a single response.
	maxReviewDailyCount = 50
	// maxReviewTags bounds the tag list of an include/exclude condition.
	maxReviewTags = 32
	// maxReviewTagLength bounds one routing tag.
	maxReviewTagLength = 128
)

// defaultReviewSetting is what a user who has never opened the review settings
// gets: everything they have ever written, sixteen memos a day.
func defaultReviewSetting() *storepb.ReviewUserSetting {
	return &storepb.ReviewUserSetting{
		Condition:  storepb.ReviewUserSetting_ALL_MEMOS,
		TimeRange:  storepb.ReviewUserSetting_ALL_TIME,
		DailyCount: defaultReviewDailyCount,
	}
}

// normalizeReviewSetting fills in defaults and rejects values the review query
// could not honor. It mutates setting in place.
func normalizeReviewSetting(setting *storepb.ReviewUserSetting) error {
	if setting.GetCondition() == storepb.ReviewUserSetting_CONDITION_UNSPECIFIED {
		setting.Condition = storepb.ReviewUserSetting_ALL_MEMOS
	}
	if setting.GetTimeRange() == storepb.ReviewUserSetting_TIME_RANGE_UNSPECIFIED {
		setting.TimeRange = storepb.ReviewUserSetting_ALL_TIME
	}
	if setting.GetDailyCount() <= 0 {
		setting.DailyCount = defaultReviewDailyCount
	}
	if setting.GetDailyCount() > maxReviewDailyCount {
		return errors.Errorf("daily count is too large; maximum is %d", maxReviewDailyCount)
	}

	tags, err := normalizeReviewTags(setting.GetTags())
	if err != nil {
		return err
	}
	switch setting.GetCondition() {
	case storepb.ReviewUserSetting_INCLUDE_TAGS, storepb.ReviewUserSetting_EXCLUDE_TAGS:
		if len(tags) == 0 {
			return errors.New("this review condition requires at least one tag")
		}
	default:
		// Drop tags the condition ignores so a later switch back to ALL_MEMOS
		// cannot silently resurrect a stale list.
		tags = nil
	}
	setting.Tags = tags
	return nil
}

func normalizeReviewTags(tags []string) ([]string, error) {
	if len(tags) > maxReviewTags {
		return nil, errors.Errorf("too many review tags; maximum is %d", maxReviewTags)
	}
	normalized := make([]string, 0, len(tags))
	seen := map[string]bool{}
	for _, tag := range tags {
		// Accept the way people type tags, including a leading "#", and store the
		// canonical bare form the memo payload uses.
		tag = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(tag), "#"))
		tag = strings.Trim(tag, "/")
		if tag == "" {
			continue
		}
		if len(tag) > maxReviewTagLength {
			return nil, errors.Errorf("review tag is too long; maximum length is %d characters", maxReviewTagLength)
		}
		if seen[tag] {
			continue
		}
		seen[tag] = true
		normalized = append(normalized, tag)
	}
	return normalized, nil
}

// loadReviewSetting returns the user's stored review setting, or the default
// when they have never saved one. The result is always normalized, so callers
// never have to reason about unspecified enums.
func (s *APIV1Service) loadReviewSetting(ctx context.Context, userID int32) (*storepb.ReviewUserSetting, error) {
	stored, err := s.Store.GetUserSetting(ctx, &store.FindUserSetting{
		UserID: &userID,
		Key:    storepb.UserSetting_REVIEW,
	})
	if err != nil {
		return nil, errors.Wrap(err, "failed to read review setting")
	}
	setting := stored.GetReview()
	if setting == nil {
		return defaultReviewSetting(), nil
	}
	// A stored setting was normalized on write; normalizing again only fills in
	// fields added since it was saved.
	if err := normalizeReviewSetting(setting); err != nil {
		return nil, err
	}
	return setting, nil
}

func convertReviewSettingFromStore(setting *storepb.ReviewUserSetting) *v1pb.UserSetting_ReviewSetting {
	if setting == nil {
		setting = defaultReviewSetting()
	}
	condition := v1pb.UserSetting_ReviewSetting_ALL_MEMOS
	switch setting.GetCondition() {
	case storepb.ReviewUserSetting_INCLUDE_TAGS:
		condition = v1pb.UserSetting_ReviewSetting_INCLUDE_TAGS
	case storepb.ReviewUserSetting_EXCLUDE_TAGS:
		condition = v1pb.UserSetting_ReviewSetting_EXCLUDE_TAGS
	case storepb.ReviewUserSetting_UNTAGGED:
		condition = v1pb.UserSetting_ReviewSetting_UNTAGGED
	default:
	}
	timeRange := v1pb.UserSetting_ReviewSetting_ALL_TIME
	switch setting.GetTimeRange() {
	case storepb.ReviewUserSetting_LAST_MONTH:
		timeRange = v1pb.UserSetting_ReviewSetting_LAST_MONTH
	case storepb.ReviewUserSetting_LAST_3_MONTHS:
		timeRange = v1pb.UserSetting_ReviewSetting_LAST_3_MONTHS
	case storepb.ReviewUserSetting_LAST_6_MONTHS:
		timeRange = v1pb.UserSetting_ReviewSetting_LAST_6_MONTHS
	case storepb.ReviewUserSetting_LAST_YEAR:
		timeRange = v1pb.UserSetting_ReviewSetting_LAST_YEAR
	default:
	}
	return &v1pb.UserSetting_ReviewSetting{
		Condition:  condition,
		Tags:       append([]string(nil), setting.GetTags()...),
		TimeRange:  timeRange,
		DailyCount: setting.GetDailyCount(),
	}
}

func convertReviewSettingToStore(setting *v1pb.UserSetting_ReviewSetting) *storepb.ReviewUserSetting {
	if setting == nil {
		return defaultReviewSetting()
	}
	condition := storepb.ReviewUserSetting_ALL_MEMOS
	switch setting.GetCondition() {
	case v1pb.UserSetting_ReviewSetting_INCLUDE_TAGS:
		condition = storepb.ReviewUserSetting_INCLUDE_TAGS
	case v1pb.UserSetting_ReviewSetting_EXCLUDE_TAGS:
		condition = storepb.ReviewUserSetting_EXCLUDE_TAGS
	case v1pb.UserSetting_ReviewSetting_UNTAGGED:
		condition = storepb.ReviewUserSetting_UNTAGGED
	default:
	}
	timeRange := storepb.ReviewUserSetting_ALL_TIME
	switch setting.GetTimeRange() {
	case v1pb.UserSetting_ReviewSetting_LAST_MONTH:
		timeRange = storepb.ReviewUserSetting_LAST_MONTH
	case v1pb.UserSetting_ReviewSetting_LAST_3_MONTHS:
		timeRange = storepb.ReviewUserSetting_LAST_3_MONTHS
	case v1pb.UserSetting_ReviewSetting_LAST_6_MONTHS:
		timeRange = storepb.ReviewUserSetting_LAST_6_MONTHS
	case v1pb.UserSetting_ReviewSetting_LAST_YEAR:
		timeRange = storepb.ReviewUserSetting_LAST_YEAR
	default:
	}
	return &storepb.ReviewUserSetting{
		Condition:  condition,
		Tags:       append([]string(nil), setting.GetTags()...),
		TimeRange:  timeRange,
		DailyCount: setting.GetDailyCount(),
	}
}
