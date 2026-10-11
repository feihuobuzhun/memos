import { autocompletion } from "@codemirror/autocomplete";
import type { Extension } from "@codemirror/state";
import { type MemoReferenceSearch, makeMemoCompletionSource } from "./memoAutocomplete";
import { makeTagCompletionSource } from "./tagAutocomplete";

export interface EditorCompletionOptions {
  getTags: () => string[];
  /** Tags from most to least recently used; a bare `#` offers the first few. */
  getRecentTags?: () => string[];
  searchMemos: MemoReferenceSearch;
}

/**
 * The editor's two completion triggers in one `autocompletion` instance: `#` for
 * tags and `@` for memo references. They must share it — CodeMirror's `override`
 * replaces the source list, so a second instance would silence the first.
 */
export function editorAutocomplete({ getTags, getRecentTags, searchMemos }: EditorCompletionOptions): Extension {
  return autocompletion({
    override: [makeTagCompletionSource(getTags, getRecentTags), makeMemoCompletionSource(searchMemos)],
    icons: false,
  });
}
