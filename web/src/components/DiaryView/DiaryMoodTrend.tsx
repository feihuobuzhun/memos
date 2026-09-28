import { diaryDayDistance, diaryMoodTone, localDiaryDate } from "@/lib/diary";
import { cn } from "@/lib/utils";
import type { DiaryMood } from "@/types/proto/api/v1/memo_service_pb";
import { useTranslate } from "@/utils/i18n";

const TONE_CLASSES: Record<ReturnType<typeof diaryMoodTone>, string> = {
  bright: "bg-amber-500/20 text-amber-700 dark:text-amber-300",
  even: "bg-muted text-muted-foreground",
  heavy: "bg-blue-500/20 text-blue-700 dark:text-blue-300",
};

/** How many days the strip shows, oldest on the start edge. */
export const DIARY_TREND_DAYS = 14;

/** The first day the strip covers, which is also the floor of the mood range. */
export const diaryTrendStartDate = (today: string): string => {
  const start = new Date(`${today}T00:00:00`);
  start.setDate(start.getDate() - (DIARY_TREND_DAYS - 1));
  return localDiaryDate(start);
};

/**
 * The last two weeks at a glance: one cell per day, carrying its emoji when the
 * day was read and standing empty when it was not. It is the part that makes a
 * diary of moods rather than a list of entries with moods attached.
 */
const DiaryMoodTrend = ({ today, moodByDate }: { today: string; moodByDate: ReadonlyMap<string, DiaryMood> }) => {
  const t = useTranslate();
  const days = Array.from({ length: DIARY_TREND_DAYS }, (_, index) => {
    const date = new Date(`${today}T00:00:00`);
    date.setDate(date.getDate() - (DIARY_TREND_DAYS - 1 - index));
    return localDiaryDate(date);
  });
  if (days.every((date) => !moodByDate.has(date))) return null;

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-2xs text-muted-foreground">{t("diary.mood-trend")}</span>
      <div className="flex items-end gap-1">
        {days.map((date) => {
          const mood = moodByDate.get(date);
          const distance = diaryDayDistance(date, today);
          const label = mood ? `${date} · ${mood.label}` : date;
          return (
            <span
              key={date}
              title={label}
              aria-label={label}
              className={cn(
                "flex size-6 items-center justify-center rounded-md text-2xs",
                mood ? TONE_CLASSES[diaryMoodTone(mood.score)] : "bg-muted/40 text-muted-foreground/50",
                distance === 0 && "ring-1 ring-primary/40",
              )}
            >
              {mood?.emoji || ""}
            </span>
          );
        })}
      </div>
    </div>
  );
};

export default DiaryMoodTrend;
