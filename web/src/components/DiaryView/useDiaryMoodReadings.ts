import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "react-hot-toast";
import { useAnalyzeDiaryMood, useDiaryMoods } from "@/hooks/useDiaryQueries";
import { type DiaryDay, diaryDayDistance } from "@/lib/diary";
import type { DiaryMood } from "@/types/proto/api/v1/memo_service_pb";

/**
 * How far back a day is read without being asked. A reading is a paid provider
 * call, so scrolling years of diary must not quietly spend a year of them;
 * recent days are read on sight and older ones on request.
 */
export const AUTO_DIARY_MOOD_WINDOW_DAYS = 31;

interface Options {
  /** The days currently on screen, newest first. */
  days: DiaryDay[];
  /** The reader's own today, which bounds the range worth asking about. */
  today: string;
  /** The earliest day the mood range should cover, e.g. for the recent-mood strip. */
  trendStartDate: string;
  enabled: boolean;
}

/**
 * Owns every mood reading the diary shows: the stored ones for the range on
 * screen, the automatic reading of recent days that have none, and the manual
 * one behind each day's chip.
 */
export const useDiaryMoodReadings = ({ days, today, trendStartDate, enabled }: Options) => {
  // The range only ever grows as pages load, and it is floored by the trend's
  // own window so the strip is never missing days the feed has not reached.
  const startDate = useMemo(() => {
    const earliestLoaded = days.at(-1)?.date;
    return earliestLoaded && earliestLoaded < trendStartDate ? earliestLoaded : trendStartDate;
  }, [days, trendStartDate]);

  const { data } = useDiaryMoods(startDate, today, { enabled });
  const analyze = useAnalyzeDiaryMood();
  const [readingDate, setReadingDate] = useState<string>();
  // Keyed by date, value is the day's entry count at the time it was last
  // asked about in this session. A day is not asked again for the same count,
  // whether the answer was a mood or an error, so a failing provider cannot
  // turn the feed into a retry loop — but a new entry changes the count, so
  // writing more for the day does ask again instead of staying stuck on the
  // first answer.
  const attempted = useRef(new Map<string, number>());

  const moodByDate = useMemo(() => {
    const entries = new Map<string, DiaryMood>();
    for (const mood of data?.moods ?? []) {
      entries.set(mood.date, mood);
    }
    return entries;
  }, [data]);
  const available = Boolean(data?.available);

  const read = useCallback(
    (date: string, options?: { force?: boolean; silent?: boolean }) => {
      if (readingDate) return;
      const entryCount = days.find((day) => day.date === date)?.memos.length ?? 0;
      attempted.current.set(date, entryCount);
      setReadingDate(date);
      analyze
        .mutateAsync({ date, force: options?.force })
        .catch((error: unknown) => {
          if (options?.silent) return;
          toast.error(error instanceof Error ? error.message : String(error));
        })
        .finally(() => setReadingDate(undefined));
    },
    [analyze, readingDate, days],
  );

  // One day at a time, so a diary opened after a long absence does not fire a
  // burst of provider calls. A day whose stored reading already covers every
  // entry it currently has is left alone; one whose entry count has moved on
  // — including past days that gained a new entry after an earlier reading —
  // is read again, as long as it has not already been asked about at this
  // same count this session.
  useEffect(() => {
    if (!enabled || !available || readingDate) return;
    const next = days.find((day) => {
      if (diaryDayDistance(day.date, today) > AUTO_DIARY_MOOD_WINDOW_DAYS) return false;
      const mood = moodByDate.get(day.date);
      if (mood && mood.memoCount === day.memos.length) return false;
      return attempted.current.get(day.date) !== day.memos.length;
    });
    if (!next) return;
    read(next.date, { silent: true });
  }, [enabled, available, readingDate, days, moodByDate, today, read]);

  return {
    moodByDate,
    available,
    readingDate,
    /** Reads one day on request, surfacing failures the reader asked for. */
    readDay: (date: string, force: boolean) => read(date, { force }),
  };
};
