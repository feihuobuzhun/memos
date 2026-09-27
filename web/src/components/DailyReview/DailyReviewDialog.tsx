import { ChevronLeftIcon, ChevronRightIcon, LoaderCircleIcon, PenLineIcon, SettingsIcon } from "lucide-react";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "react-hot-toast";
import MemoView from "@/components/MemoView";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { VisuallyHidden } from "@/components/ui/visually-hidden";
import { useAppSidebar } from "@/contexts/AppSidebarContext";
import { localReviewDate, useRefreshReviewMemos, useReviewMemos } from "@/hooks/useReviewQueries";
import { buildMemoReferenceMarkdown } from "@/lib/memo-reference";
import { extractMemoIdFromName } from "@/lib/resource-names";
import { cn } from "@/lib/utils";
import { useTranslate } from "@/utils/i18n";
import { lazyWithReload } from "@/utils/lazy";
import ReviewSettingsPanel from "./ReviewSettingsPanel";

const MemoEditorLazy = lazyWithReload(() => import("../MemoEditor"));

/**
 * The daily review: a fixed stack of the reader's own memos, one per screen,
 * with somewhere to write down what meeting them again made them think.
 *
 * An annotation is a new top-level memo that references the memo under review —
 * the same inline reference the editor's `@` picker inserts — rather than a
 * comment. That is what makes it a thought of its own that happens to be
 * anchored, instead of a footnote buried under an old card.
 */
const DailyReviewDialogContent = ({ onClose }: { onClose: () => void }) => {
  const t = useTranslate();
  const [view, setView] = useState<"review" | "settings">("review");
  const [index, setIndex] = useState(0);
  const [annotating, setAnnotating] = useState(false);
  const refreshReviewMemos = useRefreshReviewMemos();

  // Resolved on mount, which is when the dialog opens, so a browser left open
  // overnight still draws the reader's new day the next time they come back.
  const [localDate] = useState(() => localReviewDate());
  const { data, isLoading } = useReviewMemos(localDate);
  const memos = useMemo(() => data?.memos ?? [], [data]);
  const total = memos.length;
  const current = memos[Math.min(index, Math.max(total - 1, 0))];

  const go = useCallback(
    (delta: number) => {
      setAnnotating(false);
      setIndex((value) => Math.min(Math.max(value + delta, 0), Math.max(total - 1, 0)));
    },
    [total],
  );

  // Arrow keys are how a stack of cards is expected to work. Suppressed while
  // annotating, where the arrows belong to the editor.
  useEffect(() => {
    if (view !== "review" || annotating) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft") go(-1);
      if (event.key === "ArrowRight") go(1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [view, annotating, go]);

  const handleAnnotated = () => {
    setAnnotating(false);
    toast.success(t("review.annotation-saved"));
    // The reviewed memo gains a backlink, which is the visible proof the
    // annotation landed on the right card. The draw is seeded, so refetching
    // returns the same stack in the same order.
    refreshReviewMemos();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="2xl" className="md:max-w-3xl" showCloseButton={false}>
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <DialogTitle className="truncate">{t(view === "settings" ? "review.scope" : "review.title")}</DialogTitle>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {view === "review" && (
              <Button variant="ghost" size="sm" onClick={() => setView("settings")}>
                <SettingsIcon className="size-4" strokeWidth={1.8} />
                {t("common.settings")}
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={onClose} aria-label={t("common.close")}>
              {t("common.close")}
            </Button>
          </div>
        </div>
        <VisuallyHidden>
          <DialogDescription>{t("review.description")}</DialogDescription>
        </VisuallyHidden>

        {view === "settings" ? (
          <ReviewSettingsPanel onDone={() => setView("review")} />
        ) : isLoading ? (
          <div className="flex h-64 items-center justify-center">
            <LoaderCircleIcon className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : !current ? (
          <div className="flex h-64 flex-col items-center justify-center gap-3 text-center">
            <p className="text-muted-foreground">{t("review.empty")}</p>
            <Button variant="outline" size="sm" onClick={() => setView("settings")}>
              {t("review.adjust-scope")}
            </Button>
          </div>
        ) : (
          <div className="flex min-h-0 flex-col gap-3">
            {/* The stack slides as one track, so a card never reflows on its way
                in or out and the reader's place is never re-laid-out. */}
            <div className="overflow-hidden">
              <div
                className="flex transition-transform duration-300 ease-out motion-reduce:transition-none"
                style={{ transform: `translateX(-${index * 100}%)` }}
              >
                {memos.map((memo) => (
                  <div key={memo.name} className="min-h-[18rem] w-full shrink-0 px-0.5">
                    <MemoView memo={memo} className="h-full" />
                  </div>
                ))}
              </div>
            </div>

            {annotating ? (
              <Suspense fallback={<div className="h-24 rounded-lg border bg-muted/40" />}>
                <MemoEditorLazy
                  cacheKey={`${current.name}-annotation`}
                  placeholder={t("review.annotation-placeholder")}
                  // Seeded below the cursor, so the author writes their thought
                  // first and the reference to the old card trails it.
                  defaultContent={`\n\n${buildMemoReferenceMarkdown(extractMemoIdFromName(current.name))}`}
                  autoFocus
                  onConfirm={handleAnnotated}
                  onCancel={() => setAnnotating(false)}
                />
              </Suspense>
            ) : (
              <div className="flex justify-center">
                <Button variant="outline" size="sm" onClick={() => setAnnotating(true)}>
                  <PenLineIcon className="size-4" strokeWidth={1.8} />
                  {t("review.annotate")}
                </Button>
              </div>
            )}

            <div className="flex items-center justify-between gap-4">
              <Button
                variant="ghost"
                size="icon"
                className="rounded-full"
                aria-label={t("review.previous")}
                disabled={index === 0}
                onClick={() => go(-1)}
              >
                <ChevronLeftIcon className="size-5" strokeWidth={1.8} />
              </Button>
              <span className={cn("text-sm text-muted-foreground", "tabular-nums")}>
                {t("review.progress", { current: index + 1, total })}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="rounded-full"
                aria-label={t("review.next")}
                disabled={index >= total - 1}
                onClick={() => go(1)}
              >
                <ChevronRightIcon className="size-5" strokeWidth={1.8} />
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};

/**
 * Mounted once by the layout. The review is only mounted while it is open, so a
 * user who never reviews never runs its queries.
 */
const DailyReviewDialog = () => {
  const { dailyReviewOpen, setDailyReviewOpen } = useAppSidebar();
  if (!dailyReviewOpen) return null;
  return <DailyReviewDialogContent onClose={() => setDailyReviewOpen(false)} />;
};

export default DailyReviewDialog;
