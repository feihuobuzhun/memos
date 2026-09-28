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
	// maxDiaryTags bounds how many tags may mark a memo as a diary entry.
	maxDiaryTags = 16
	// maxDiaryTagLength bounds one diary tag.
	maxDiaryTagLength = 128
)

// defaultDiaryTags is where a diary starts before anyone picks their own tags.
// It is a default, not a rule: the diary setting replaces it outright, and both
// spellings are here because a diary is usually kept in one language.
var defaultDiaryTags = []string{"日记", "diary"}

// defaultDiarySetting is what a user who has never opened the diary settings
// gets: the default tags, and their days read for mood if the instance can.
func defaultDiarySetting() *storepb.DiaryUserSetting {
	return &storepb.DiaryUserSetting{}
}

// normalizeDiarySetting cleans up the tags and rejects values the diary could
// not honor. It mutates setting in place.
func normalizeDiarySetting(setting *storepb.DiaryUserSetting) error {
	tags, err := normalizeDiaryTags(setting.GetTags())
	if err != nil {
		return err
	}
	setting.Tags = tags
	return nil
}

func normalizeDiaryTags(tags []string) ([]string, error) {
	if len(tags) > maxDiaryTags {
		return nil, errors.Errorf("too many diary tags; maximum is %d", maxDiaryTags)
	}
	normalized := make([]string, 0, len(tags))
	seen := map[string]bool{}
	for _, tag := range tags {
		// Accept the way people type tags, including a leading "#", and store
		// the canonical bare form the memo payload uses.
		tag = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(tag), "#"))
		tag = strings.Trim(tag, "/")
		if tag == "" {
			continue
		}
		if len(tag) > maxDiaryTagLength {
			return nil, errors.Errorf("diary tag is too long; maximum length is %d characters", maxDiaryTagLength)
		}
		if seen[tag] {
			continue
		}
		seen[tag] = true
		normalized = append(normalized, tag)
	}
	return normalized, nil
}

// effectiveDiaryTags returns the tags a diary actually selects by. An empty
// configured list means "I never chose", not "nothing", so it falls back to the
// defaults rather than matching every memo the author ever wrote.
func effectiveDiaryTags(setting *storepb.DiaryUserSetting) []string {
	if tags := setting.GetTags(); len(tags) > 0 {
		return tags
	}
	return append([]string(nil), defaultDiaryTags...)
}

// diaryMoodAnalysisEnabled reports whether this reader wants their days read.
// Absence means yes: the feature still needs an instance-wide provider, so a
// reader who never opened the settings gets whatever was configured for them.
func diaryMoodAnalysisEnabled(setting *storepb.DiaryUserSetting) bool {
	if setting == nil || setting.MoodAnalysis == nil {
		return true
	}
	return setting.GetMoodAnalysis()
}

// loadDiarySetting returns the user's stored diary setting, or the default when
// they have never saved one. The result is always normalized.
func (s *APIV1Service) loadDiarySetting(ctx context.Context, userID int32) (*storepb.DiaryUserSetting, error) {
	stored, err := s.Store.GetUserSetting(ctx, &store.FindUserSetting{
		UserID: &userID,
		Key:    storepb.UserSetting_DIARY,
	})
	if err != nil {
		return nil, errors.Wrap(err, "failed to read diary setting")
	}
	setting := stored.GetDiary()
	if setting == nil {
		return defaultDiarySetting(), nil
	}
	// A stored setting was normalized on write; normalizing again only cleans
	// up fields added since it was saved.
	if err := normalizeDiarySetting(setting); err != nil {
		return nil, err
	}
	return setting, nil
}

func convertDiarySettingFromStore(setting *storepb.DiaryUserSetting) *v1pb.UserSetting_DiarySetting {
	if setting == nil {
		setting = defaultDiarySetting()
	}
	converted := &v1pb.UserSetting_DiarySetting{
		Tags: append([]string(nil), setting.GetTags()...),
	}
	// Presence is meaningful on the way out too: a client that has never been
	// told otherwise should read "unset" as "on", exactly as the server does.
	if setting.MoodAnalysis != nil {
		moodAnalysis := setting.GetMoodAnalysis()
		converted.MoodAnalysis = &moodAnalysis
	}
	return converted
}

func convertDiarySettingToStore(setting *v1pb.UserSetting_DiarySetting) *storepb.DiaryUserSetting {
	if setting == nil {
		return defaultDiarySetting()
	}
	converted := &storepb.DiaryUserSetting{
		Tags: append([]string(nil), setting.GetTags()...),
	}
	if setting.MoodAnalysis != nil {
		moodAnalysis := setting.GetMoodAnalysis()
		converted.MoodAnalysis = &moodAnalysis
	}
	return converted
}
