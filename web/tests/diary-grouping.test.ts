import { create, create as createSetting, type MessageInitShape } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { describe, expect, it } from "vitest";
import {
  buildDiaryFilter,
  DEFAULT_DIARY_TAGS,
  diaryDayDistance,
  diaryMoodTone,
  effectiveDiaryTags,
  groupMemosByDay,
  localDiaryDate,
  localUtcOffsetMinutes,
} from "@/lib/diary";
import { MemoSchema } from "@/types/proto/api/v1/memo_service_pb";
import { UserSetting_DiarySettingSchema } from "@/types/proto/api/v1/user_service_pb";

const buildMemo = (name: string, createTime: Date, overrides: MessageInitShape<typeof MemoSchema> = {}) =>
  create(MemoSchema, { name, content: name, createTime: timestampFromDate(createTime), ...overrides });

describe("diary tag selection", () => {
  it("falls back to the defaults when nobody chose any tags", () => {
    expect(effectiveDiaryTags(undefined)).toEqual([...DEFAULT_DIARY_TAGS]);
    expect(effectiveDiaryTags(createSetting(UserSetting_DiarySettingSchema, { tags: [] }))).toEqual([...DEFAULT_DIARY_TAGS]);
  });

  it("uses the chosen tags instead of the defaults", () => {
    const setting = createSetting(UserSetting_DiarySettingSchema, { tags: ["journal", "日记"] });

    expect(effectiveDiaryTags(setting)).toEqual(["journal", "日记"]);
    expect(buildDiaryFilter(effectiveDiaryTags(setting))).toBe('tag in ["journal", "日记"]');
  });

  it("quotes every tag and drops blank ones", () => {
    expect(buildDiaryFilter([" diary ", "", "  "])).toBe('tag in ["diary"]');
    expect(buildDiaryFilter(['say "hi"'])).toBe('tag in ["say \\"hi\\""]');
  });

  it("selects nothing rather than everything when no tag is usable", () => {
    expect(buildDiaryFilter([])).toBeUndefined();
    expect(buildDiaryFilter([" "])).toBeUndefined();
  });
});

describe("groupMemosByDay", () => {
  it("keeps the feed's order and starts a section per local day", () => {
    const days = groupMemosByDay([
      buildMemo("memos/1", new Date(2026, 2, 14, 22, 30)),
      buildMemo("memos/2", new Date(2026, 2, 14, 8, 5)),
      buildMemo("memos/3", new Date(2026, 2, 13, 23, 59)),
    ]);

    expect(days.map((day) => day.date)).toEqual(["2026-03-14", "2026-03-13"]);
    expect(days[0].memos.map((memo) => memo.name)).toEqual(["memos/1", "memos/2"]);
    expect(days[1].memos.map((memo) => memo.name)).toEqual(["memos/3"]);
  });

  it("appends a later page to the day it continues", () => {
    const firstPage = [buildMemo("memos/1", new Date(2026, 2, 14, 22, 0))];
    const secondPage = [buildMemo("memos/2", new Date(2026, 2, 14, 1, 0))];

    expect(groupMemosByDay([...firstPage, ...secondPage])).toHaveLength(1);
  });

  it("skips memos that carry no creation time", () => {
    expect(groupMemosByDay([create(MemoSchema, { name: "memos/unset" })])).toEqual([]);
  });
});

describe("diary day arithmetic", () => {
  it("names the day the writer was in, not the UTC one", () => {
    expect(localDiaryDate(new Date(2026, 0, 1, 0, 30))).toBe("2026-01-01");
    expect(localDiaryDate(new Date(2026, 11, 31, 23, 45))).toBe("2026-12-31");
  });

  it("reports a day's distance in calendar days", () => {
    expect(diaryDayDistance("2026-03-14", "2026-03-14")).toBe(0);
    expect(diaryDayDistance("2026-03-13", "2026-03-14")).toBe(1);
    // 2026 is not a leap year, so February ends the day before March starts.
    expect(diaryDayDistance("2026-02-28", "2026-03-01")).toBe(1);
    expect(diaryDayDistance("2024-02-28", "2024-03-01")).toBe(2);
    expect(diaryDayDistance("2026-03-15", "2026-03-14")).toBe(-1);
  });

  it("survives a daylight saving jump inside the range", () => {
    // Whatever the local zone, a month apart is a whole number of days.
    expect(Number.isInteger(diaryDayDistance("2026-03-01", "2026-04-01"))).toBe(true);
  });

  it("offers the reader's own UTC offset in minutes east", () => {
    const date = new Date(2026, 2, 14, 12);

    expect(localUtcOffsetMinutes(date)).toBe(-date.getTimezoneOffset());
  });
});

describe("diaryMoodTone", () => {
  it("bands a score into how the day reads", () => {
    expect(diaryMoodTone(80)).toBe("bright");
    expect(diaryMoodTone(25)).toBe("bright");
    expect(diaryMoodTone(0)).toBe("even");
    expect(diaryMoodTone(-24)).toBe("even");
    expect(diaryMoodTone(-25)).toBe("heavy");
    expect(diaryMoodTone(-100)).toBe("heavy");
  });
});
