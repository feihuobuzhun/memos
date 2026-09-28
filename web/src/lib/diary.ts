import { timestampDate } from "@bufbuild/protobuf/wkt";
import type { Memo } from "@/types/proto/api/v1/memo_service_pb";
import type { UserSetting_DiarySetting } from "@/types/proto/api/v1/user_service_pb";

/**
 * Where a diary starts before anyone picks their own tags. Kept in step with
 * the server's own defaults so the page shows the entries the server would
 * read, and both spellings are here because a diary is usually kept in one
 * language.
 */
export const DEFAULT_DIARY_TAGS = ["日记", "diary"] as const;

/**
 * The tags a diary actually selects by. An empty configured list means "I never
 * chose", not "nothing", so it falls back to the defaults rather than matching
 * every memo ever written.
 */
export const effectiveDiaryTags = (setting?: UserSetting_DiarySetting): string[] =>
  setting && setting.tags.length > 0 ? setting.tags : [...DEFAULT_DIARY_TAGS];

/**
 * The CEL filter that selects the diary. Tag membership reaches nested
 * children server-side, so "diary" also brings in "diary/travel".
 */
export const buildDiaryFilter = (tags: string[]): string | undefined => {
  const usable = tags.map((tag) => tag.trim()).filter(Boolean);
  if (usable.length === 0) return undefined;
  return `tag in [${usable.map((tag) => JSON.stringify(tag)).join(", ")}]`;
};

/** A calendar day in the reader's own time zone, which is the only day a diary has. */
export const localDiaryDate = (date: Date): string => {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
};

/** The reader's current offset from UTC, in minutes east of it. */
export const localUtcOffsetMinutes = (date: Date = new Date()): number => -date.getTimezoneOffset();

/** How many days back a date is from another, counted in calendar days. */
export const diaryDayDistance = (date: string, from: string): number => {
  const parse = (value: string) => Date.parse(`${value}T00:00:00`);
  const days = (parse(from) - parse(date)) / (24 * 60 * 60 * 1000);
  return Number.isFinite(days) ? Math.round(days) : Number.POSITIVE_INFINITY;
};

export interface DiaryDay {
  /** The local calendar day, formatted "YYYY-MM-DD". */
  date: string;
  /** The day's entries, newest first, matching the feed's own order. */
  memos: Memo[];
}

/**
 * Splits a feed into days. The feed arrives newest first and stays that way, so
 * a day's section can be rendered as soon as its first entry is loaded, and a
 * later page that carries more of the same day appends to it.
 */
export const groupMemosByDay = (memos: Memo[]): DiaryDay[] => {
  const days: DiaryDay[] = [];
  for (const memo of memos) {
    const createTime = memo.createTime ? timestampDate(memo.createTime) : undefined;
    if (!createTime) continue;
    const date = localDiaryDate(createTime);
    const current = days.at(-1);
    if (current?.date === date) {
      current.memos.push(memo);
    } else {
      days.push({ date, memos: [memo] });
    }
  }
  return days;
};

/** How a mood's score reads: the three bands the badge colours by. */
export type DiaryMoodTone = "bright" | "even" | "heavy";

export const diaryMoodTone = (score: number): DiaryMoodTone => {
  if (score >= 25) return "bright";
  if (score <= -25) return "heavy";
  return "even";
};
