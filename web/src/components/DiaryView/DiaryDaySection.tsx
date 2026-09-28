import i18n from "@/i18n";
import { diaryDayDistance } from "@/lib/diary";
import type { DiaryMood, Memo } from "@/types/proto/api/v1/memo_service_pb";
import { useTranslate } from "@/utils/i18n";
import DiaryMomentCard from "./DiaryMomentCard";
import DiaryMoodBadge from "./DiaryMoodBadge";

interface Props {
  date: string;
  memos: Memo[];
  today: string;
  mood?: DiaryMood;
  moodPending?: boolean;
  moodAvailable?: boolean;
  onAnalyzeMood?: (options: { force: boolean }) => void;
  parentPage: string;
}

/**
 * The day's own name. "Today" and "yesterday" are how a diary's most recent
 * days are actually referred to; everything older gets its date.
 */
const formatDiaryDay = (date: string, today: string, t: ReturnType<typeof useTranslate>): string => {
  const distance = diaryDayDistance(date, today);
  if (distance === 0) return t("diary.today");
  if (distance === 1) return t("diary.yesterday");
  const parsed = new Date(`${date}T00:00:00`);
  const sameYear = parsed.getFullYear() === new Date(`${today}T00:00:00`).getFullYear();
  return parsed.toLocaleDateString(i18n.language, {
    year: sameYear ? undefined : "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
  });
};

/** One day of the diary: its name and mood, then the entries written in it. */
const DiaryDaySection = ({ date, memos, today, mood, moodPending, moodAvailable, onAnalyzeMood, parentPage }: Props) => {
  const t = useTranslate();
  const count = memos.length;
  const entryCount = count === 1 ? t("diary.entry-count_one", { count }) : t("diary.entry-count_other", { count });

  return (
    <section className="w-full" aria-labelledby={`diary-day-${date}`}>
      {/* The header sticks while its own day scrolls past, so a long day never
          leaves the reader wondering which day they are still in. On mobile it
          parks below the app bar, which is sticky at the same edge. */}
      <div className="sticky top-12 z-10 flex items-center gap-2 bg-background/95 py-2 backdrop-blur md:top-0">
        <h2 id={`diary-day-${date}`} className="text-ui font-medium text-foreground">
          {formatDiaryDay(date, today, t)}
        </h2>
        <span className="text-2xs text-muted-foreground">{entryCount}</span>
        <DiaryMoodBadge mood={mood} pending={moodPending} available={moodAvailable} onAnalyze={onAnalyzeMood} />
      </div>
      <div className="divide-y divide-border/60 border-t border-border/60">
        {memos.map((memo) => (
          <DiaryMomentCard key={memo.name} memo={memo} parentPage={parentPage} />
        ))}
      </div>
    </section>
  );
};

export default DiaryDaySection;
