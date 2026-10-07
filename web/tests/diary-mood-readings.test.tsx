import { create } from "@bufbuild/protobuf";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AUTO_DIARY_MOOD_WINDOW_DAYS, useDiaryMoodReadings } from "@/components/DiaryView/useDiaryMoodReadings";
import type { DiaryDay } from "@/lib/diary";
import { DiaryMoodSchema, MemoSchema } from "@/types/proto/api/v1/memo_service_pb";

const analyze = vi.fn();
const moodsQuery = vi.fn();

vi.mock("@/hooks/useDiaryQueries", () => ({
  useDiaryMoods: (startDate: string, endDate: string, options?: { enabled?: boolean }) => moodsQuery(startDate, endDate, options),
  useAnalyzeDiaryMood: () => ({ mutateAsync: analyze }),
}));

const TODAY = "2026-03-14";
const dayBefore = (offset: number) => {
  const date = new Date(`${TODAY}T00:00:00`);
  date.setDate(date.getDate() - offset);
  return date.toISOString().slice(0, 10);
};
const buildDays = (...offsets: number[]): DiaryDay[] => offsets.map((offset) => ({ date: dayBefore(offset), memos: [] }));

const setStoredMoods = (dates: string[], available = true) => {
  moodsQuery.mockReturnValue({
    data: { moods: dates.map((date) => create(DiaryMoodSchema, { date, label: "平静" })), available },
  });
};

const renderReadings = (days: DiaryDay[], options?: { enabled?: boolean }) =>
  renderHook(() =>
    useDiaryMoodReadings({
      days,
      today: TODAY,
      trendStartDate: dayBefore(13),
      enabled: options?.enabled ?? true,
    }),
  );

describe("useDiaryMoodReadings", () => {
  beforeEach(() => {
    analyze.mockReset();
    analyze.mockResolvedValue(undefined);
    moodsQuery.mockReset();
    setStoredMoods([]);
  });

  it("asks for the stored range without reaching for a provider", async () => {
    setStoredMoods([TODAY]);
    const { result } = renderReadings([]);

    expect(moodsQuery).toHaveBeenCalledWith(dayBefore(13), TODAY, { enabled: true });
    expect(result.current.moodByDate.get(TODAY)?.label).toBe("平静");
    await waitFor(() => expect(analyze).not.toHaveBeenCalled());
  });

  it("covers every loaded day once the feed reaches past the trend window", () => {
    renderReadings(buildDays(0, 40));

    expect(moodsQuery).toHaveBeenCalledWith(dayBefore(40), TODAY, { enabled: true });
  });

  it("reads one recent unread day at a time", async () => {
    renderReadings(buildDays(0, 1));

    await waitFor(() => expect(analyze).toHaveBeenCalledTimes(1));
    expect(analyze).toHaveBeenCalledWith({ date: TODAY, force: undefined });
  });

  it("leaves days outside the automatic window to be asked for", async () => {
    renderReadings(buildDays(AUTO_DIARY_MOOD_WINDOW_DAYS + 1));

    await waitFor(() => expect(analyze).not.toHaveBeenCalled());
  });

  it("never reads a day twice in one session, even when the reading failed", async () => {
    analyze.mockRejectedValue(new Error("provider down"));
    const { rerender } = renderReadings(buildDays(0));

    await waitFor(() => expect(analyze).toHaveBeenCalledTimes(1));
    rerender();
    await waitFor(() => expect(analyze).toHaveBeenCalledTimes(1));
  });

  it("takes no reading while the instance or the reader has them off", async () => {
    setStoredMoods([], false);
    renderReadings(buildDays(0));
    await waitFor(() => expect(analyze).not.toHaveBeenCalled());

    setStoredMoods([]);
    renderReadings(buildDays(0), { enabled: false });
    await waitFor(() => expect(analyze).not.toHaveBeenCalled());
  });

  it("asks again for a day the reader deliberately re-reads", async () => {
    setStoredMoods([TODAY]);
    const { result } = renderReadings(buildDays(0));

    await act(async () => {
      result.current.readDay(TODAY, true);
    });

    expect(analyze).toHaveBeenCalledWith({ date: TODAY, force: true });
  });

  it("re-reads a day automatically once a new entry is added after an earlier reading", async () => {
    setStoredMoods([]);
    moodsQuery.mockReturnValue({
      data: { moods: [create(DiaryMoodSchema, { date: TODAY, label: "平静", memoCount: 1 })], available: true },
    });
    const oneEntry: DiaryDay[] = [{ date: TODAY, memos: [create(MemoSchema, {})] }];
    const twoEntries: DiaryDay[] = [{ date: TODAY, memos: [create(MemoSchema, {}), create(MemoSchema, {})] }];

    const { rerender } = renderHook(
      (days: DiaryDay[]) => useDiaryMoodReadings({ days, today: TODAY, trendStartDate: dayBefore(13), enabled: true }),
      { initialProps: oneEntry },
    );

    // The stored reading already covers the day's single entry, so it is
    // left alone.
    await waitFor(() => expect(analyze).not.toHaveBeenCalled());

    rerender(twoEntries);

    await waitFor(() => expect(analyze).toHaveBeenCalledWith({ date: TODAY, force: undefined }));
  });
});
