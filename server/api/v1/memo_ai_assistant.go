package v1

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/pkg/errors"

	"github.com/usememos/memos/core/memopayload"
	storepb "github.com/usememos/memos/proto/gen/store"
	"github.com/usememos/memos/provider/ai"
	"github.com/usememos/memos/provider/ai/chat"
	chatgemini "github.com/usememos/memos/provider/ai/chat/gemini"
	chatopenai "github.com/usememos/memos/provider/ai/chat/openai"
	"github.com/usememos/memos/store"
)

const (
	// assistantReviewQueueSize bounds queued reviews. Bursts beyond this are
	// dropped rather than delaying memo creation or growing without limit.
	assistantReviewQueueSize = 64
	// assistantReviewWorkers bounds concurrent provider calls.
	assistantReviewWorkers = 2
	// assistantReviewTimeout bounds one end-to-end review.
	assistantReviewTimeout = 3 * time.Minute
	// maxAssistantContextChars bounds the background memos sent to the model.
	maxAssistantContextChars = 8000
	// maxAssistantMemoChars bounds a single memo inside the prompt.
	maxAssistantMemoChars = 2000
	// maxAssistantReferenceMemos bounds how many referenced memos travel with a
	// review. References are explicit author intent, so they are always sent —
	// this cap only keeps a link-heavy memo inside the context budget.
	maxAssistantReferenceMemos = 10
	// assistantResponseMaxTokens bounds the model response length.
	assistantResponseMaxTokens = 1200

	// defaultAssistantPrompt is used when an assistant has no custom prompt.
	defaultAssistantPrompt = `You are a thoughtful reading partner for someone's personal notes.
Read the new note and reply in the same language the note is written in.
Offer one concrete observation about the note, then one open question that helps the author think further.
Be concise: at most 120 words, plain prose, no headings and no bullet lists.`
)

// assistantReviewDispatcher owns the lazily started review worker pool.
type assistantReviewDispatcher struct {
	once  sync.Once
	queue chan assistantReviewJob
}

// assistantReviewJob identifies a memo awaiting review. Only the ID travels
// through the queue so the worker always reads the current row.
type assistantReviewJob struct {
	memoID int32
}

// dispatchAssistantReviewBestEffort queues an automatic review for a new memo.
// It never blocks memo creation and never returns an error to the caller.
func (s *APIV1Service) dispatchAssistantReviewBestEffort(ctx context.Context, memo *store.Memo) {
	if memo == nil {
		return
	}
	aiSetting, err := s.Store.GetInstanceAISetting(ctx)
	if err != nil {
		slog.Warn("Failed to read AI setting for assistant review", slog.Any("err", err))
		return
	}
	// Route here as well as in the worker so an instance with the feature off,
	// or a memo no assistant handles, costs nothing beyond this cached read.
	route := routeAssistantForTags(aiSetting.GetAssistants(), memo.Payload.GetTags())
	if route == nil {
		// Logged, because "nothing happened" is otherwise indistinguishable from
		// a broken provider — the master switch and the tag filter are the two
		// settings that silently opt a memo out.
		slog.Debug("No AI assistant handles this memo",
			slog.String("memo_uid", memo.UID),
			slog.Bool("feature_enabled", aiSetting.GetAssistants().GetEnabled()),
			slog.Any("memo_tags", memo.Payload.GetTags()))
		return
	}

	s.assistantReview.once.Do(s.startAssistantReviewWorkers)
	select {
	case s.assistantReview.queue <- assistantReviewJob{memoID: memo.ID}:
		slog.Info("Queued AI assistant review",
			slog.String("memo_uid", memo.UID),
			slog.String("assistant", route.assistant.GetTitle()))
	default:
		slog.Warn("AI assistant review queue is full; skipping memo",
			slog.String("memo_uid", memo.UID))
	}
}

func (s *APIV1Service) startAssistantReviewWorkers() {
	s.assistantReview.queue = make(chan assistantReviewJob, assistantReviewQueueSize)
	for range assistantReviewWorkers {
		go func() {
			for job := range s.assistantReview.queue {
				s.runAssistantReview(job)
			}
		}()
	}
}

func (s *APIV1Service) runAssistantReview(job assistantReviewJob) {
	// The originating request context is already canceled by now, so the review
	// runs on its own deadline.
	ctx, cancel := context.WithTimeout(context.Background(), assistantReviewTimeout)
	defer cancel()

	if err := s.reviewMemoWithAssistant(ctx, job.memoID); err != nil {
		slog.Warn("Failed to run AI assistant review",
			slog.Int64("memo_id", int64(job.memoID)), slog.Any("err", err))
	}
}

func (s *APIV1Service) reviewMemoWithAssistant(ctx context.Context, memoID int32) error {
	memo, err := s.Store.GetMemo(ctx, &store.FindMemo{ID: &memoID})
	if err != nil {
		return errors.Wrap(err, "failed to load memo")
	}
	// The memo may have been deleted or archived while queued.
	if memo == nil || memo.RowStatus != store.Normal {
		return nil
	}

	aiSetting, err := s.Store.GetInstanceAISetting(ctx)
	if err != nil {
		return errors.Wrap(err, "failed to read AI setting")
	}
	// A review must never review itself, which would loop forever. Reviews are
	// only dispatched for top-level memos today; this keeps that from becoming
	// a load-bearing assumption.
	if memo.Payload.GetAssistant() != nil {
		return nil
	}
	route := routeAssistantForTags(aiSetting.GetAssistants(), memo.Payload.GetTags())
	if route == nil {
		return nil
	}
	assistant := route.assistant

	provider, err := resolveAssistantProvider(aiSetting, assistant)
	if err != nil {
		return err
	}
	model, err := resolveAssistantModel(assistant, provider.Type)
	if err != nil {
		return err
	}

	referencedMemos, err := s.loadAssistantReferencedMemos(ctx, memo)
	if err != nil {
		return errors.Wrap(err, "failed to load referenced memos")
	}

	contextMemos, err := s.loadAssistantContextMemos(ctx, memo, assistant, route.matchedTag)
	if err != nil {
		return errors.Wrap(err, "failed to load context memos")
	}
	// A memo already included as a reference must not repeat in the
	// scope-based background.
	contextMemos = dropAssistantContextDuplicates(contextMemos, referencedMemos)

	completer, err := s.assistantCompleter(provider)
	if err != nil {
		return err
	}
	prompt := assistant.GetPrompt()
	if strings.TrimSpace(prompt) == "" {
		prompt = defaultAssistantPrompt
	}
	response, err := completer.Complete(ctx, chat.Request{
		Model:        model,
		Instructions: prompt,
		Input:        buildAssistantInput(memo, referencedMemos, contextMemos),
		MaxTokens:    assistantResponseMaxTokens,
	})
	if err != nil {
		return errors.Wrap(err, "failed to generate assistant review")
	}
	text := strings.TrimSpace(response.Text)
	if text == "" {
		return errors.New("assistant review response was empty")
	}

	if err := s.createAssistantComment(ctx, assistant, memo, text); err != nil {
		return err
	}
	slog.Info("Posted AI assistant review",
		slog.String("memo_uid", memo.UID),
		slog.String("assistant", assistant.GetTitle()),
		slog.Int("referenced_memos", len(referencedMemos)),
		slog.Int("context_memos", len(contextMemos)))
	return nil
}

func resolveAssistantProvider(
	setting *storepb.InstanceAISetting,
	assistant *storepb.AIAssistantConfig,
) (ai.ProviderConfig, error) {
	providers := make([]ai.ProviderConfig, 0, len(setting.GetProviders()))
	for _, provider := range setting.GetProviders() {
		if provider == nil {
			continue
		}
		providers = append(providers, convertAIProviderConfigFromStore(provider))
	}
	provider, err := ai.FindProvider(providers, assistant.GetProviderId())
	if err != nil {
		return ai.ProviderConfig{}, errors.Wrapf(err, "assistant %q provider is not configured", assistant.GetTitle())
	}
	return *provider, nil
}

func resolveAssistantModel(assistant *storepb.AIAssistantConfig, providerType ai.ProviderType) (string, error) {
	if model := strings.TrimSpace(assistant.GetModel()); model != "" {
		return model, nil
	}
	return ai.DefaultChatModel(providerType)
}

// assistantCompleter builds the chat client for one review. The indirection
// exists so a test can exercise the whole review path — routing, context,
// comment authorship, visibility — without a provider.
func (s *APIV1Service) assistantCompleter(provider ai.ProviderConfig) (chat.Completer, error) {
	if s.assistantCompleterOverride != nil {
		return s.assistantCompleterOverride(provider)
	}
	return newAssistantCompleter(provider)
}

func newAssistantCompleter(provider ai.ProviderConfig) (chat.Completer, error) {
	options := chat.ApplyOptions(nil)
	switch provider.Type {
	case ai.ProviderOpenAI:
		return chatopenai.New(provider, options)
	case ai.ProviderGemini:
		return chatgemini.New(provider, options)
	default:
		return nil, errors.Wrapf(ai.ErrChatNotSupported, "provider type %q", provider.Type)
	}
}

// loadAssistantContextMemos returns the author's background memos for the
// configured scope, excluding the memo under review.
func (s *APIV1Service) loadAssistantContextMemos(
	ctx context.Context,
	memo *store.Memo,
	assistant *storepb.AIAssistantConfig,
	matchedTag string,
) ([]*store.Memo, error) {
	scope := assistant.GetContextScope()
	if scope == storepb.AIAssistantContextScope_CURRENT_MEMO_ONLY {
		return nil, nil
	}
	limit := int(assistant.GetContextLimit())
	if limit <= 0 {
		return nil, nil
	}

	find := &store.FindMemo{
		CreatorID:       &memo.CreatorID,
		RowStatus:       rowStatusPtr(store.Normal),
		ExcludeComments: true,
		// Fetch one extra row so removing the memo under review still leaves a
		// full page of background.
		Limit: intPtr(limit + 1),
	}
	if scope == storepb.AIAssistantContextScope_SAME_TAG_MEMOS {
		if matchedTag == "" {
			return nil, nil
		}
		find.Filters = []string{fmt.Sprintf("tag in [%q]", matchedTag)}
	}

	memos, err := s.Store.ListMemos(ctx, find)
	if err != nil {
		return nil, err
	}

	contextMemos := make([]*store.Memo, 0, limit)
	for _, candidate := range memos {
		if candidate == nil || candidate.ID == memo.ID {
			continue
		}
		contextMemos = append(contextMemos, candidate)
		if len(contextMemos) == limit {
			break
		}
	}
	return contextMemos, nil
}

// loadAssistantReferencedMemos returns the memos the reviewed memo links to.
// A reference is the author's own explicit curation — the strongest context
// available — so referenced memos travel with every review, whatever the
// configured scope. The review is written for the author's eyes only, but its
// prompt must still not carry a memo the author cannot read, so the standard
// access scope filters the targets.
func (s *APIV1Service) loadAssistantReferencedMemos(ctx context.Context, memo *store.Memo) ([]*store.Memo, error) {
	relationType := store.MemoRelationReference
	relations, err := s.Store.ListMemoRelations(ctx, &store.FindMemoRelation{MemoID: &memo.ID, Type: &relationType})
	if err != nil {
		return nil, err
	}

	ids := make([]int32, 0, len(relations))
	for _, relation := range relations {
		if relation == nil || relation.RelatedMemoID <= 0 || relation.RelatedMemoID == memo.ID {
			continue
		}
		ids = append(ids, relation.RelatedMemoID)
		if len(ids) == maxAssistantReferenceMemos {
			break
		}
	}
	if len(ids) == 0 {
		return nil, nil
	}

	return s.Store.ListMemos(ctx, &store.FindMemo{
		IDList:          ids,
		RowStatus:       rowStatusPtr(store.Normal),
		ExcludeComments: true,
		Access: &store.MemoAccessScope{
			UserID:         &memo.CreatorID,
			AllowPublic:    true,
			AllowProtected: true,
		},
	})
}

// dropAssistantContextDuplicates removes scope-based memos already included
// as references, so one memo never appears in both sections.
func dropAssistantContextDuplicates(contextMemos, referencedMemos []*store.Memo) []*store.Memo {
	if len(contextMemos) == 0 || len(referencedMemos) == 0 {
		return contextMemos
	}
	referencedIDs := make(map[int32]struct{}, len(referencedMemos))
	for _, memo := range referencedMemos {
		if memo != nil {
			referencedIDs[memo.ID] = struct{}{}
		}
	}
	kept := make([]*store.Memo, 0, len(contextMemos))
	for _, memo := range contextMemos {
		if memo == nil {
			continue
		}
		if _, duplicate := referencedIDs[memo.ID]; duplicate {
			continue
		}
		kept = append(kept, memo)
	}
	return kept
}

// buildAssistantInput renders the user payload sent alongside the assistant's
// system prompt. Structural labels stay in English so they read the same to
// every model; the prompt decides the reply language.
func buildAssistantInput(memo *store.Memo, referencedMemos, contextMemos []*store.Memo) string {
	var builder strings.Builder
	builder.WriteString("# New note\n\n")
	builder.WriteString(truncateRunes(memo.Content, maxAssistantMemoChars))

	remaining := maxAssistantContextChars
	// References come first and share the same budget: the author linked them
	// on purpose, so they outrank the scope-based background.
	remaining = writeAssistantMemoSection(&builder, remaining, "Notes referenced by the new note", referencedMemos)
	writeAssistantMemoSection(&builder, remaining, "Earlier notes for context (most recent first)", contextMemos)
	return builder.String()
}

// writeAssistantMemoSection renders one headed list inside the remaining
// character budget and returns what is left of it.
func writeAssistantMemoSection(builder *strings.Builder, budget int, heading string, memos []*store.Memo) int {
	var section strings.Builder
	index := 0
	for _, memo := range memos {
		if memo == nil {
			continue
		}
		content := strings.TrimSpace(truncateRunes(memo.Content, maxAssistantMemoChars))
		if content == "" {
			continue
		}
		if len(content) > budget {
			continue
		}
		budget -= len(content)
		index++
		fmt.Fprintf(&section, "\n%d. %s\n", index, content)
	}
	if section.Len() == 0 {
		return budget
	}
	builder.WriteString("\n\n# " + heading + "\n")
	builder.WriteString(section.String())
	return budget
}

func truncateRunes(value string, limit int) string {
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit]) + "…"
}

// createAssistantComment stores the review as a comment on the reviewed memo.
//
// The comment is stored under the reviewed memo's own author, not under an
// account of its own. A memo's audience is defined by its creator: only the
// author may comment on a PRIVATE memo, and only the author can read a PRIVATE
// comment. A review authored by anyone else is therefore rejected outright on a
// private memo, and invisible to the author even where it is accepted. Which
// assistant wrote it is recorded in the payload instead.
func (s *APIV1Service) createAssistantComment(
	ctx context.Context,
	assistant *storepb.AIAssistantConfig,
	relatedMemo *store.Memo,
	content string,
) error {
	author, err := s.Store.GetUser(ctx, &store.FindUser{ID: &relatedMemo.CreatorID})
	if err != nil {
		return errors.Wrap(err, "failed to load the reviewed memo's author")
	}
	if author == nil {
		return errors.Errorf("the reviewed memo's author %d no longer exists", relatedMemo.CreatorID)
	}
	uid, err := ValidateAndGenerateUID("")
	if err != nil {
		return errors.Wrap(err, "failed to generate comment UID")
	}
	comment := &store.Memo{
		UID:       uid,
		CreatorID: author.ID,
		Content:   content,
		// Inherit placement so a review is never more visible than its memo.
		Visibility: relatedMemo.Visibility,
		SpaceID:    relatedMemo.SpaceID,
	}
	if err := memopayload.RebuildMemoPayload(ctx, comment, s.MarkdownService); err != nil {
		return errors.Wrap(err, "failed to build comment payload")
	}
	// Drop any tag the model happened to write. Indexing them would let an
	// assistant invent entries in the author's tag list.
	comment.Payload.Tags = nil
	// Attribution travels with the comment, so a renamed or deleted assistant
	// does not rewrite the identity an existing review was written under.
	comment.Payload.Assistant = &storepb.MemoPayload_AssistantAttribution{
		AssistantId: assistant.GetId(),
		Title:       assistant.GetTitle(),
		Icon:        assistant.GetIcon(),
	}

	if err := s.createMemoWithMutation(ctx, author, comment, &relatedMemo.ID, nil, nil, nil); err != nil {
		return errors.Wrap(err, "failed to create assistant comment")
	}
	s.SSEHub.publishMemoChanged()
	return nil
}

func rowStatusPtr(status store.RowStatus) *store.RowStatus {
	return &status
}

func intPtr(value int) *int {
	return &value
}
