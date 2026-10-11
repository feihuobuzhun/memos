import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import DiaryEntryDate from "@/components/DiaryView/DiaryEntryDate";
import { diaryEntryCreateTime, shiftDiaryDate } from "@/lib/diary";

vi.mock("@/utils/i18n", () => ({ useTranslate: () => (key: string) => key }));

describe("diary entry date", () => {
  it("shifts across month and year boundaries", () => {
    expect(shiftDiaryDate("2025-03-01", -1)).toBe("2025-02-28");
    expect(shiftDiaryDate("2025-01-01", -1)).toBe("2024-12-31");
    expect(shiftDiaryDate("2024-12-31", 1)).toBe("2025-01-01");
  });

  it("stamps nothing for today and keeps the clock time for a past day", () => {
    const now = new Date(2025, 5, 10, 9, 30, 15);
    expect(diaryEntryCreateTime("2025-06-10", "2025-06-10", now)).toBeUndefined();
    const created = diaryEntryCreateTime("2025-06-09", "2025-06-10", now);
    expect(created).toEqual(new Date(2025, 5, 9, 9, 30, 15));
  });

  it("steps back a day, cannot go past today, and can return to today", () => {
    const onChange = vi.fn();
    const { rerender } = render(<DiaryEntryDate value="2025-06-10" today="2025-06-10" onChange={onChange} />);
    expect(screen.getByLabelText("diary.next-day")).toBeDisabled();
    expect(screen.queryByText("diary.today")).toBeNull();
    fireEvent.click(screen.getByLabelText("diary.previous-day"));
    expect(onChange).toHaveBeenLastCalledWith("2025-06-09");

    rerender(<DiaryEntryDate value="2025-06-09" today="2025-06-10" onChange={onChange} />);
    fireEvent.click(screen.getByLabelText("diary.next-day"));
    expect(onChange).toHaveBeenLastCalledWith("2025-06-10");
    fireEvent.click(screen.getByText("diary.today"));
    expect(onChange).toHaveBeenLastCalledWith("2025-06-10");

    onChange.mockClear();
    fireEvent.change(document.querySelector('input[type="date"]')!, { target: { value: "2025-06-20" } });
    expect(onChange).not.toHaveBeenCalled();
  });
});
