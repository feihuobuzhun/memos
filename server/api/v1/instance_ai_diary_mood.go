package v1

import (
	"strings"

	"github.com/pkg/errors"

	storepb "github.com/usememos/memos/proto/gen/store"
)

const (
	// maxDiaryMoodModelLength bounds the model identifier.
	maxDiaryMoodModelLength = 128
	// maxDiaryMoodPromptLength bounds the system instruction.
	maxDiaryMoodPromptLength = 8000
)

// prepareDiaryMoodConfigForUpdate validates and normalizes the diary mood
// config, following the same "absence == keep" rule as the API keys and the
// transcription config: a request that omits it leaves the stored one alone.
func prepareDiaryMoodConfigForUpdate(setting *storepb.InstanceAISetting, existing *storepb.InstanceAISetting) error {
	if setting.DiaryMood == nil && existing != nil {
		setting.DiaryMood = existing.GetDiaryMood()
	}
	if setting.DiaryMood == nil {
		return nil
	}

	config := setting.DiaryMood
	config.ProviderId = strings.TrimSpace(config.ProviderId)
	config.Model = strings.TrimSpace(config.Model)
	config.Prompt = strings.TrimSpace(config.Prompt)

	if len(config.Model) > maxDiaryMoodModelLength {
		return errors.Errorf("diary mood model is too long; maximum length is %d characters", maxDiaryMoodModelLength)
	}
	if len(config.Prompt) > maxDiaryMoodPromptLength {
		return errors.Errorf("diary mood prompt is too long; maximum length is %d characters", maxDiaryMoodPromptLength)
	}

	if config.ProviderId != "" {
		referenced := false
		for _, provider := range setting.GetProviders() {
			if provider != nil && provider.GetId() == config.ProviderId {
				referenced = true
				break
			}
		}
		if !referenced {
			return errors.Errorf("diary mood provider_id %q does not reference any configured provider", config.ProviderId)
		}
	}
	// Reading a day needs somewhere to send it, so an enabled config without a
	// provider is a configuration the server could never honor.
	if config.GetEnabled() && config.ProviderId == "" {
		return errors.New("diary mood analysis requires a provider")
	}
	return nil
}
