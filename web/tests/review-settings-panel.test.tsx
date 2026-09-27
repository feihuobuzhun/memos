import { create } from "@bufbuild/protobuf";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ReviewSettingsPanel from "@/components/DailyReview/ReviewSettingsPanel";
import {
  UserSetting_ReviewSetting_Condition,
  UserSetting_ReviewSetting_TimeRange,
  UserSetting_ReviewSettingSchema,
} from "@/types/proto/api/v1/user_service_pb";

const state = vi.hoisted(() => ({
  stored: undefined as unknown,
  tagCount: {} as Record<string, number>,
  save: vi.fn(),
  onDone: vi.fn(),
}));

vi.mock("@/hooks/useCurrentUser", () => ({ default: () => ({ name: "users/alice" }) }));

vi.mock("@/hooks/useUserQueries", () => ({
  useUserStats: () => ({ data: { tagCount: state.tagCount } }),
}));

vi.mock("@/hooks/useReviewQueries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/useReviewQueries")>();
  return {
    ...actual,
    useReviewSetting: () => ({ data: state.stored, isLoading: false }),
    useUpdateReviewSetting: () => ({ mutateAsync: state.save, isPending: false }),
  };
});

vi.mock("@/utils/i18n", () => ({
  useTranslate: () => (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key),
}));

const setting = (condition: UserSetting_ReviewSetting_Condition, tags: string[] = []) =>
  create(UserSetting_ReviewSettingSchema, {
    condition,
    tags,
    timeRange: UserSetting_ReviewSetting_TimeRange.ALL_TIME,
    dailyCount: 16,
  });

describe("ReviewSettingsPanel", () => {
  beforeEach(() => {
    state.stored = setting(UserSetting_ReviewSetting_Condition.INCLUDE_TAGS, ["book"]);
    state.tagCount = { book: 3, idea: 1 };
    state.save.mockReset();
    state.save.mockResolvedValue(state.stored);
    state.onDone.mockClear();
  });

  it("shows the reader's own tags, marking the ones the review is scoped to", () => {
    render(<ReviewSettingsPanel onDone={state.onDone} />);

    const book = screen.getByRole("button", { name: "#book" });
    const idea = screen.getByRole("button", { name: "#idea" });
    expect(book.getAttribute("aria-pressed")).toBe("true");
    expect(idea.getAttribute("aria-pressed")).toBe("false");
  });

  it("saves the tags the reader picked", async () => {
    render(<ReviewSettingsPanel onDone={state.onDone} />);

    fireEvent.click(screen.getByRole("button", { name: "#idea" }));
    fireEvent.click(screen.getByText("common.save"));

    await waitFor(() => expect(state.save).toHaveBeenCalledTimes(1));
    expect(state.save.mock.calls[0][0].tags).toEqual(["book", "idea"]);
    await waitFor(() => expect(state.onDone).toHaveBeenCalled());
  });

  it("explains why a tag condition with no tag cannot be saved, instead of failing on save", () => {
    render(<ReviewSettingsPanel onDone={state.onDone} />);

    fireEvent.click(screen.getByRole("button", { name: "#book" }));

    expect(screen.getByText("review.tags-required")).toBeTruthy();
    expect((screen.getByText("common.save").closest("button") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText("common.save"));
    expect(state.save).not.toHaveBeenCalled();
  });

  it("hides the tag list for a condition that does not read tags", () => {
    state.stored = setting(UserSetting_ReviewSetting_Condition.ALL_MEMOS);
    render(<ReviewSettingsPanel onDone={state.onDone} />);

    expect(screen.queryByRole("button", { name: "#book" })).toBeNull();
    expect(screen.getByText("review.daily-count")).toBeTruthy();
  });

  it("says so when the reader has no tags to scope the review to", () => {
    state.tagCount = {};
    render(<ReviewSettingsPanel onDone={state.onDone} />);

    expect(screen.getByText("review.tags-empty")).toBeTruthy();
  });
});
