import { LoaderCircleIcon, SparklesIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { diaryMoodTone } from "@/lib/diary";
import { cn } from "@/lib/utils";
import type { DiaryMood } from "@/types/proto/api/v1/memo_service_pb";
import { useTranslate } from "@/utils/i18n";

const TONE_CLASSES: Record<ReturnType<typeof diaryMoodTone>, string> = {
  bright: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  even: "border-border bg-muted/60 text-muted-foreground",
  heavy: "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300",
};

interface Props {
  mood?: DiaryMood;
  /** A reading is being taken for this day right now. */
  pending?: boolean;
  /** Whether a reading could be taken at all: provider configured, reader opted in. */
  available?: boolean;
  onAnalyze?: (options: { force: boolean }) => void;
}

/**
 * The day's mood as a chip beside its date. Reading it is the point, so the
 * chip carries the emoji and the label; the sentence and what the day turned on
 * are one click away rather than in the way of the entries.
 */
const DiaryMoodBadge = ({ mood, pending, available, onAnalyze }: Props) => {
  const t = useTranslate();

  if (pending) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/60 px-2 py-0.5 text-2xs text-muted-foreground">
        <LoaderCircleIcon className="size-3 animate-spin" />
        {t("diary.mood-reading")}
      </span>
    );
  }

  if (!mood) {
    // Without a provider there is nothing to offer, so the day's header stays
    // clean rather than advertising a button that could only fail.
    if (!available) return null;
    return (
      <Button
        variant="ghost"
        size="sm"
        className="h-6 gap-1 px-1.5 text-2xs text-muted-foreground"
        onClick={() => onAnalyze?.({ force: false })}
      >
        <SparklesIcon className="size-3" strokeWidth={1.8} />
        {t("diary.mood-read-day")}
      </Button>
    );
  }

  const tone = diaryMoodTone(mood.score);
  const count = mood.memoCount;
  const entryCount = count === 1 ? t("diary.mood-entries_one", { count }) : t("diary.mood-entries_other", { count });
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            className={cn(
              "inline-flex max-w-[12rem] items-center gap-1 rounded-full border px-2 py-0.5 text-2xs transition-colors",
              TONE_CLASSES[tone],
            )}
          />
        }
      >
        {mood.emoji && <span aria-hidden="true">{mood.emoji}</span>}
        <span className="min-w-0 truncate">{mood.label || t("diary.mood")}</span>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-3">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            {mood.emoji && <span className="text-xl leading-none">{mood.emoji}</span>}
            <div className="min-w-0">
              <p className="truncate text-ui font-medium">{mood.label}</p>
              <p className="text-2xs text-muted-foreground">
                {t("diary.mood-score", { score: mood.score })} · {entryCount}
              </p>
            </div>
          </div>
          {mood.summary && <p className="text-sm text-foreground/90">{mood.summary}</p>}
          {mood.keywords.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {mood.keywords.map((keyword) => (
                <span key={keyword} className="rounded-full bg-muted px-2 py-0.5 text-2xs text-muted-foreground">
                  {keyword}
                </span>
              ))}
            </div>
          )}
          {available && (
            <div className="flex items-center justify-between gap-2 pt-1">
              <span className="text-2xs text-muted-foreground">{t("diary.mood-ai-note")}</span>
              <Button variant="ghost" size="sm" className="h-6 px-1.5 text-2xs" onClick={() => onAnalyze?.({ force: true })}>
                {t("diary.mood-read-again")}
              </Button>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
};

export default DiaryMoodBadge;
