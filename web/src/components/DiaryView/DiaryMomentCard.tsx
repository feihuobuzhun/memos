import { timestampDate } from "@bufbuild/protobuf/wkt";
import { MessageCircleIcon } from "lucide-react";
import { type ComponentType, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { loadMemoEditor } from "@/components/MemoEditor/loader";
import type { MemoEditorProps } from "@/components/MemoEditor/types";
import { MemoBody } from "@/components/MemoView/components";
import { useImagePreview } from "@/components/MemoView/hooks";
import { computeCommentAmount, MemoViewContext } from "@/components/MemoView/MemoViewContext";
import { useAuth } from "@/contexts/AuthContext";
import useCurrentUser from "@/hooks/useCurrentUser";
import i18n from "@/i18n";
import { isMemoBlurred } from "@/lib/tag";
import { cn } from "@/lib/utils";
import { State } from "@/types/proto/api/v1/common_pb";
import { type Memo, Visibility } from "@/types/proto/api/v1/memo_service_pb";
import { lazyWithReload } from "@/utils/lazy";
import { canManageMemo } from "@/utils/user";
import MemoActionMenu from "../MemoActionMenu";
import UserAvatar from "../UserAvatar";
import VisibilityIcon from "../VisibilityIcon";

const PreviewImageDialog = lazyWithReload(() => import("../PreviewImageDialog"));

/**
 * One diary entry, laid out the way a timeline app lays out a post: the author
 * beside the entry rather than above it, the day's clock time and the quiet
 * actions underneath. The entry body itself is the ordinary memo body — content,
 * attachments, referenced memos, reactions — so a diary entry stays a memo and
 * keeps everything a memo can do.
 */
const DiaryMomentCard = ({ memo, parentPage }: { memo: Memo; parentPage: string }) => {
  const currentUser = useCurrentUser();
  const { userTagsSetting } = useAuth();
  const [showEditor, setShowEditor] = useState(false);
  const [EditorComponent, setEditorComponent] = useState<ComponentType<MemoEditorProps>>();
  const [showBlurredContent, setShowBlurredContent] = useState(false);
  const { previewState, openPreview, setPreviewOpen } = useImagePreview();

  const blurred = isMemoBlurred(memo, userTagsSetting);
  const readonly = !canManageMemo(memo, currentUser);
  const isArchived = memo.state === State.ARCHIVED;
  const createTime = memo.createTime ? timestampDate(memo.createTime) : undefined;
  const commentAmount = computeCommentAmount(memo);

  const openEditor = useCallback(() => {
    void loadMemoEditor()
      .then(({ default: MemoEditor }) => {
        setEditorComponent(() => MemoEditor);
        setShowEditor(true);
      })
      .catch(() => undefined);
  }, []);
  const closeEditor = useCallback(() => setShowEditor(false), []);
  // A card that scrolls out of the feed and back must not come back mid-edit.
  useEffect(() => () => setShowEditor(false), []);

  const contextValue = useMemo(
    () => ({
      memo,
      creator: currentUser,
      currentUser,
      parentPage,
      cardWidth: 0,
      isArchived,
      readonly,
      showBlurredContent,
      blurred,
      openEditor,
      toggleBlurVisibility: () => setShowBlurredContent((value) => !value),
      openPreview,
    }),
    [memo, currentUser, parentPage, isArchived, readonly, showBlurredContent, blurred, openEditor, openPreview],
  );

  return (
    <MemoViewContext.Provider value={contextValue}>
      {showEditor && EditorComponent ? (
        <div className="w-full py-3">
          <EditorComponent
            autoFocus
            cacheKey={`diary-memo-editor-${memo.name}`}
            memo={memo}
            onConfirm={closeEditor}
            onCancel={closeEditor}
          />
        </div>
      ) : (
        <article className="group/moment flex w-full items-start gap-3 py-4">
          <UserAvatar className="size-10 shrink-0 rounded-full" avatarUrl={currentUser?.avatarUrl} />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <header className="flex h-6 items-center justify-between gap-2">
              <span className="min-w-0 truncate text-ui font-medium text-foreground">
                {currentUser?.displayName || currentUser?.username}
              </span>
              {/* The menu is the card's only permanent control, and it keeps out
                  of the way until the entry is engaged. */}
              <span className="opacity-0 transition-opacity focus-within:opacity-100 group-hover/moment:opacity-100 sm:opacity-0">
                <MemoActionMenu memo={memo} parentPage={parentPage} readonly={readonly} onEdit={openEditor} />
              </span>
            </header>

            <MemoBody />

            <footer className="flex items-center gap-2 pt-1 text-2xs text-muted-foreground">
              <span>{createTime?.toLocaleTimeString(i18n.language, { hour: "numeric", minute: "2-digit" })}</span>
              {memo.visibility !== Visibility.PRIVATE && (
                <VisibilityIcon visibility={memo.visibility} className={cn("size-3 text-current")} />
              )}
              {commentAmount > 0 && (
                <Link className="flex items-center gap-1 hover:text-foreground" to={`/${memo.name}`} viewTransition>
                  <MessageCircleIcon className="size-3" strokeWidth={1.8} />
                  {commentAmount}
                </Link>
              )}
            </footer>
          </div>
        </article>
      )}

      {previewState.items.length > 0 && (
        <Suspense fallback={null}>
          <PreviewImageDialog
            open={previewState.open}
            onOpenChange={setPreviewOpen}
            items={previewState.items}
            initialIndex={previewState.index}
          />
        </Suspense>
      )}
    </MemoViewContext.Provider>
  );
};

export default DiaryMomentCard;
