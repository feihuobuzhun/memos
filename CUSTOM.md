# Customizations

This repository is a personal fork of [usememos/memos](https://github.com/usememos/memos).

It is **pinned**: upstream releases are no longer merged. Individual upstream
changes may be cherry-picked when they are worth the effort, but the fork is
maintained as its own product.

| | |
| --- | --- |
| Upstream baseline | [`05a2c6d`](https://github.com/usememos/memos/commit/05a2c6db7a3e926c9142a635f42f7af0f078c81d) — `chore: replace bird sprites with ink empty states` (2026-09-23) |
| Image | `ghcr.io/feihuobuzhun/memos:latest`, built by `.github/workflows/build-custom-image.yml` on every push to `main` |

## Deploying a change

1. Merge the pull request into `main`.
2. Wait for **Build Custom Image** to finish in the Actions tab.
3. On the server: back up the data volume, then `docker compose pull && docker compose up -d`.

Back up the data volume before deploying anything that touches the backend.

## Features added to the fork

### Sidebar heatmap

Upstream removed the contribution heatmap in 0.18.2. This fork restores it with
the current stack, as a mode of the existing sidebar statistics panel.

- Columns are weeks, the rightmost column is the current week, and the week
  start follows the instance setting.
- The summary line shows total memos, days recorded, current streak, and
  longest streak. A day with no memo yet does not break the current streak.
- Clicking a cell filters the memo list to that day, matching the month
  calendar it replaces. A toggle switches back to the calendar and the choice
  is remembered.
- Reuses the existing statistics data, so it adds no API calls.

Files: `web/src/components/AppSidebar/UsageHeatMap.tsx`, `StatisticsView.tsx`,
`MonthNavigator.tsx`.

### Tag icons

A tag can be given an icon — any Unicode emoji, or one of the Lucide symbols the
Space picker offers — which replaces the `#` mark in both flat and tree tag
modes. The icon is picked from the tag's own mark in the sidebar, or per rule in
Settings → Tags, and is stored on the user's tag metadata as
`UserTagMetadata.icon`, alongside the background colour and blur flag upstream
already keeps there. Keys are anchored regex patterns, so `project/.*` can mark a
whole family at once.

Marks resolve in one order everywhere: the configured icon, then a leading emoji
in the tag name (so `#📗读书`, the fork's original trick, keeps working without a
rewrite of existing memos), then the `#` mark.

Picking from the sidebar writes an exact-name rule. That rule wins the metadata
lookup over any regex rule that styled the tag before, so the regex rule's colour
and blur are copied across once; clearing the icon removes the rule again when it
carried nothing else. Tree mode is read-only here because a branch row's mark slot
already belongs to its disclosure control.

Files: `proto/store/user_setting.proto`, `proto/api/v1/user_service.proto`,
`store/user_tag_icon.go`, `server/api/v1/user_tag_icon.go`,
`server/api/v1/user_service.go` (validation),
`server/api/v1/user_service_converters.go`, `web/src/lib/tag.ts`,
`web/src/hooks/useTagIcon.ts`, `web/src/components/TagIconPicker.tsx`,
`web/src/components/CustomIconPicker.tsx` (trigger overrides),
`web/src/components/AppSidebar/SidebarRow.tsx`,
`web/src/components/AppSidebar/TagsSection.tsx`,
`web/src/components/AppSidebar/AppSidebar.tsx`, `web/src/components/TagTree.tsx`,
`web/src/components/Settings/TagsSection.tsx`.

### Inline memo references

Typing `@` in the editor opens a picker over the author's own memos; choosing one
inserts a reference where the cursor is. The reference is an ordinary Markdown
link to the memo's page — `[Memos](/memos/<uid>)` — so it survives exports, reads
correctly in other Markdown clients, and can be renamed like any other link text.
The default label is the literal `Memos` rather than the target's snippet, because
a snippet written for its own memo rarely reads correctly inside the referencing
sentence.

In the rendered memo the link becomes a chip that routes in-app instead of
opening a tab.

**The content is the single source of truth.** `REFERENCE` relations are derived
from the links in the content on every create and every content edit, which
replaces upstream's separately-stored relation list:

- Deleting the link deletes the backlink. There is no way for the two to drift.
- Derivation is lenient: a link to a missing memo, to a memo the author cannot
  read, or to the memo itself is left as a plain link rather than failing the
  write.
- `SetMemoRelations` returns `Unimplemented`, and `UpdateMemo` rejects a
  `relations` field mask. Clients link a memo by writing the link.
- The upstream import path still restores the relations recorded in an archive
  directly through the store, so an imported memo keeps its history; the
  relations are re-derived from its content the next time it is edited.

The old `+ → Link memo` dialog and the relation editor under the editor are gone,
since a reference now lives in the text. Backlinks are unchanged: the memo detail
sidebar and the related-memo rows still list what points at the memo.

Files: `markdown/memo_reference.go`, `markdown/markdown.go`
(`ExtractedData.MemoReferences`), `server/api/v1/memo_reference_helpers.go`,
`server/api/v1/memo_service.go` (UpdateMemo),
`server/api/v1/memo_relation_service.go`, `web/src/lib/memo-reference.ts`,
`web/src/components/MemoEditor/Editor/memoAutocomplete.ts`,
`web/src/components/MemoEditor/Editor/completion.ts`,
`web/src/components/MemoEditor/hooks/useMemoReferenceSearch.ts`,
`web/src/components/MemoContent/markdown/MemoReferenceLink.tsx`.

### Automatic AI review of new memos

When a memo is created, a configured assistant reviews it and posts the result
as a comment. This is the fork's largest addition and it is implemented
server-side.

**Configuration** lives in the instance AI setting, next to the providers it
calls (`InstanceAISetting.assistants`). Providers and their API keys continue
to be managed in the AI settings section; an assistant only references a
provider by id. Because the configuration is stored server-side, it applies to
every client and every device.

**Routing.** Assistants are evaluated in configured order. The first enabled
assistant whose tags match the new memo wins; a routing tag also matches its
nested children, so `book` matches `book/novel`. An enabled assistant with no
tags is the fallback for everything else. A disabled assistant is skipped
rather than swallowing its tag.

**Context.** Each assistant chooses what to send with the memo: the memo alone,
the author's most recent memos, or the author's memos sharing the tag that
routed this one. Background memos are capped by count and by total characters.

**Execution.** Reviews run on a small worker pool off the request path, so memo
creation returns immediately and the comment appears when the provider answers.
The queue is bounded; bursts beyond it are dropped rather than delaying writes.
Because the hook is on memo creation rather than in the web client, memos
created from the API or a mobile client are reviewed too.

**Authorship.** A review is stored under the reviewed memo's own author, and
which assistant wrote it is recorded in the comment's payload
(`MemoPayload.assistant`) and surfaced as the read-only `Memo.assistant` field.
The web client shows that attribution in place of the author on the comment's
header, so the author is never credited with text they did not write.

This is not a cosmetic choice. A memo's audience is defined by its creator:
only the author may comment on a private memo, and only the author may read a
private comment. An earlier version gave each assistant its own bot account,
which meant every review on a private memo was rejected on write and would
have been invisible on read even if it had been stored — and the composer
defaults to private. Keeping the author as the creator makes visibility and
authorization correct without any exception in the authorization rules.

A client that does not know about `Memo.assistant` still sees a consistent
memo, just without the attribution.

**Safety properties worth preserving when editing this code:**

- A review comment inherits the visibility and space of the memo it reviews, so
  it is never more visible than its parent.
- Tags the model happens to write are dropped from the comment payload, so an
  assistant cannot invent entries in the author's tag list.
- A memo that already carries `payload.assistant` is never reviewed, so an
  assistant cannot review its own output. A review is an ordinary memo by the
  author now, so a tagless fallback assistant would otherwise match it.
- Attribution is copied into the comment at write time, so renaming or deleting
  an assistant does not rewrite the identity an existing review was written
  under.

If an earlier build of this fork provisioned `assistant-<digest>` accounts,
they are now unused and can be removed by hand in Settings → Members. They are
deliberately not deleted automatically: deleting a user also deletes their
memos, which would destroy the reviews they already posted.

Files: `proto/store/instance_setting.proto`, `proto/api/v1/instance_service.proto`,
`proto/store/memo.proto`, `proto/api/v1/memo_service.proto`,
`provider/ai/chat/` (text-generation capability for OpenAI-compatible and Gemini
providers), `server/api/v1/memo_ai_assistant.go`,
`server/api/v1/memo_ai_assistant_routing.go`,
`server/api/v1/instance_ai_assistants.go`,
`server/api/v1/memo_service_converter.go`,
`web/src/components/Settings/AIAssistantSection.tsx`,
`web/src/components/MemoView/components/MemoHeader.tsx`.

### Daily review

A fixed handful of your own memos, redrawn once a day, in the spirit of flomo's
review. Opened from the sidebar; the scope is a per-user setting.

- **Review condition** — all memos, only selected tags, everything except
  selected tags, or only untagged memos. A tag condition with no tag is
  rejected, because it would silently mean "everything".
- **Time range** — all time, or the last 1/3/6/12 months.
- **Memos per day** — how many cards the day's stack holds (default 16, max 50).
- Archived and trashed memos never take part, and neither do memos an AI
  assistant wrote. Your own annotations and your own comments do.
- The draw is **seeded** by `<user id>:<local date>`, so the same day always
  yields the same cards in the same order — reopening the dialog, or refetching
  after writing an annotation, never reshuffles the stack.
- **Annotating** a card creates an ordinary new top-level memo that *references*
  the memo under review, using the same inline reference the editor's `@` picker
  inserts. It is deliberately not a comment: a second reading is a thought of
  its own that happens to be anchored, and it shows up in your timeline, in
  search, and in the reviewed memo's backlinks. After saving you stay on the
  same card.

The AI-assistant exclusion is expressed as a new filter field, `has_assistant`,
usable anywhere the memo filter CEL is accepted (`!has_assistant` means "not
written by an assistant"). It tests for `payload.assistant`, the attribution
added by the AI review feature.

Files: `filter/schema.go`, `proto/store/user_setting.proto`,
`proto/api/v1/user_service.proto`, `proto/api/v1/memo_service.proto`
(`ListReviewMemos`), `server/api/v1/user_review_setting.go`,
`server/api/v1/memo_service_review.go`, `server/api/v1/memo_service_hydrate.go`,
`web/src/hooks/useReviewQueries.ts`, `web/src/lib/review-scope.ts`,
`web/src/components/DailyReview/`.

### Reference graph

A picture of how one memo connects to the others through inline references,
opened from a memo's ⋯ menu. A dialog rather than a page: following a thought
outward should not cost a navigation.

- Laid out as a tidy tree growing to the right — the root on the left, what it
  references beside it, and so on — which is how the references actually read.
- **Direction**: what this memo references, what references it, or both.
- **Depth**: 1–5 levels, default 3.
- Clicking a card re-roots the graph on it and pushes a trail entry, so a
  reader can go further than the requested depth and still get back.
- A card with references past the requested depth is marked, so a leaf is
  visibly "there is more here" rather than "nothing here".
- Each memo is drawn once, in the column of its distance from the root. A
  reference that points at a card already on screen — the edge that closes a
  cycle, or one that skips a level — is still drawn, dashed.
- Comments are excluded. A comment is a reply that belongs to exactly one memo,
  and in this fork most of them are written by an AI assistant rather than by
  the author thinking.
- Memos the caller may not read are absent, and so are the edges that touched
  them, including the "there is more here" mark.

The walk happens on the server (`GetMemoReferenceGraph`), bounded by depth and
a node budget, so opening the graph costs one request instead of one per card.

Files: `proto/api/v1/memo_service.proto`,
`server/api/v1/memo_service_reference_graph.go`,
`web/src/lib/reference-graph-layout.ts`,
`web/src/hooks/useReferenceGraphQuery.ts`,
`web/src/components/ReferenceGraph/`,
`web/src/components/MemoActionMenu/MemoActionMenu.tsx`.

### Diary

A diary entry is an ordinary memo that happens to carry a tag you chose for it.
Nothing about it is a special kind of record: it stays in the timeline, in
search, in the calendar and in its tag, and `/diary` is simply the page that
shows only those memos, laid out the way a moments feed is laid out rather than
as a wall of cards.

- **Which tags count is a setting**, not a constant. The diary's own settings
  dialog picks from the tags you already write with, and a tag can be typed in
  before it has ever been used. Choosing nothing does not mean "no diary": it
  falls back to `日记` and `diary`, the same defaults the server uses, and the
  page header always states which tags it is reading. Tag membership reaches
  nested children, so `diary` also brings in `diary/travel`.
- **The feed is grouped by local day.** Each day gets a sticky header naming it
  — today and yesterday by name, everything older by date — and its entries are
  rendered with the ordinary memo body, so attachments, references, reactions
  and the ⋯ menu all behave as they do everywhere else.
- Writing is seeded: the composer at the top of the page starts with the first
  configured tag, so a new entry lands in the diary you are looking at.

#### Emotion diary

A day can be read by an AI and given a mood: a label, an emoji, a score from
-100 to 100, a sentence addressed to the author, and up to five phrases naming
what the day turned on. The last two weeks are shown as a strip of one cell per
day above the feed, so the diary reads as a run of moods and not only as a list
of entries.

**Configuration is split in two,** because the two decisions belong to
different people. An admin points the feature at a provider, model and prompt
in Settings → AI (`InstanceAISetting.diary_mood`), which is where the API keys
already live. Each reader then keeps a switch of their own in the diary
settings, and a reader who turns it off is never read, however the instance is
configured. A client learns whether a reading is possible at all from
`ListDiaryMoods.available`, since the AI setting itself is admin-only.

**Nothing is read behind your back and nothing is paid for twice.**

- `ListDiaryMoods` only returns readings already stored; it never calls a
  provider. Rendering the diary therefore costs nothing.
- `AnalyzeDiaryMood` stores a `source_digest` over the day, the model and the
  prompt, plus each entry's id and update time. Asking for an unchanged day
  returns the stored reading untouched; `force` is how a reader deliberately
  asks for a second opinion. Editing the day, or an admin changing the model or
  the prompt, is what makes a day worth reading again.
- The web client reads a day automatically only within 31 days of today, one
  day at a time, and attempts a given date once per session — so a diary opened
  after a long absence, or a provider that is down, cannot turn scrolling into
  a burst of provider calls. Older days are read when asked for.
- Readings are rate limited per user (60/hour), and an empty day is answered
  without calling anything.

**The day is the writer's day.** The client sends its own UTC offset with the
request, so the window a reading covers is the author's midnight-to-midnight,
not the server's.

**Readings are stored in a user setting** (`UserSetting.DIARY_MOODS`), newest
first, pruned to the most recent 730 days, rather than in a new table. A
reading is derived data that can always be taken again, and the store carries
three SQL drivers whose migrations cannot all be exercised locally; the
refresh-token and memo-view settings set the same precedent.

**The model is asked for JSON** and its answer is bounded on every axis: the
label, emoji, summary and keywords are truncated, the score is clamped, and a
reply that is not usable JSON fails the request instead of storing something
that only looks like a reading. The built-in prompt asks for the diary's own
language, and it forbids advice and diagnosis — the point is to name what was
written, not to counsel the person who wrote it.

Files: `proto/store/user_setting.proto`, `proto/store/instance_setting.proto`,
`proto/api/v1/user_service.proto`, `proto/api/v1/instance_service.proto`,
`proto/api/v1/memo_service.proto` (`ListDiaryMoods`, `AnalyzeDiaryMood`),
`server/api/v1/user_diary_setting.go`, `server/api/v1/memo_service_diary.go`,
`server/api/v1/instance_ai_diary_mood.go`, `web/src/lib/diary.ts`,
`web/src/hooks/useDiaryQueries.ts`, `web/src/components/DiaryView/`,
`web/src/pages/Diary.tsx`,
`web/src/components/Settings/AISection.tsx`.

## Development

The backend needs Go (see `go.mod`) and the frontend needs Node and pnpm.

```bash
# Backend
go build ./...
go test ./...

# Frontend
cd web && pnpm install && pnpm lint && pnpm test

# Regenerate protobuf code after editing any .proto file
cd proto && buf format -w && buf lint && buf generate
```

`buf generate` writes both the Go types under `proto/gen/` and the TypeScript
types under `web/src/types/proto/`. Commit the generated files.
