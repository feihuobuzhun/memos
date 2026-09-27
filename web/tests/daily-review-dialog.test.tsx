import { create } from "@bufbuild/protobuf";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import DailyReviewDialog from "@/components/DailyReview/DailyReviewDialog";
import { AppSidebarProvider, useAppSidebar } from "@/contexts/AppSidebarContext";
import { MemoSchema } from "@/types/proto/api/v1/memo_service_pb";

const state = vi.hoisted(() => ({
  memos: [] as Array<{ name: string; content: string }>,
  refresh: vi.fn(),
  editorProps: undefined as { defaultContent?: string; cacheKey?: string } | undefined,
}));

vi.mock("@/hooks/useReviewQueries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/useReviewQueries")>();
  return {
    ...actual,
    useReviewMemos: () => ({ data: { memos: state.memos, eligibleCount: state.memos.length }, isLoading: false }),
    useRefreshReviewMemos: () => state.refresh,
  };
});

vi.mock("@/components/DailyReview/ReviewSettingsPanel", () => ({
  default: ({ onDone }: { onDone: () => void }) => (
    <button type="button" onClick={onDone}>
      settings-panel
    </button>
  ),
}));

vi.mock("@/components/MemoView", () => ({
  default: ({ memo }: { memo: { name: string; content: string } }) => <article data-testid="memo-card">{memo.content}</article>,
}));

vi.mock("@/components/MemoEditor", () => ({
  default: (props: { defaultContent?: string; cacheKey?: string }) => {
    state.editorProps = props;
    return <div data-testid="annotation-editor">{props.defaultContent}</div>;
  },
}));

vi.mock("@/utils/i18n", () => ({
  useTranslate: () => (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key),
}));

const Harness = () => {
  const { setDailyReviewOpen } = useAppSidebar();
  return (
    <>
      <button type="button" onClick={() => setDailyReviewOpen(true)}>
        open-review
      </button>
      <DailyReviewDialog />
    </>
  );
};

const renderReview = async () => {
  render(
    <MemoryRouter>
      <AppSidebarProvider>
        <Harness />
      </AppSidebarProvider>
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByText("open-review"));
  await waitFor(() => expect(screen.getByText("review.title")).toBeTruthy());
};

const memo = (name: string, content: string) => create(MemoSchema, { name, content });

describe("DailyReviewDialog", () => {
  beforeEach(() => {
    state.memos = [memo("memos/aaa", "first card"), memo("memos/bbb", "second card"), memo("memos/ccc", "third card")];
    state.refresh.mockClear();
    state.editorProps = undefined;
  });

  it("walks the day's stack and reports where the reader is in it", async () => {
    await renderReview();

    expect(screen.getByText('review.progress:{"current":1,"total":3}')).toBeTruthy();
    // The whole stack is mounted as one sliding track, so every card is present.
    expect(screen.getAllByTestId("memo-card")).toHaveLength(3);

    const previous = screen.getByLabelText("review.previous") as HTMLButtonElement;
    const next = screen.getByLabelText("review.next") as HTMLButtonElement;
    expect(previous.disabled).toBe(true);

    fireEvent.click(next);
    expect(screen.getByText('review.progress:{"current":2,"total":3}')).toBeTruthy();
    expect(previous.disabled).toBe(false);

    fireEvent.click(next);
    expect(screen.getByText('review.progress:{"current":3,"total":3}')).toBeTruthy();
    expect(next.disabled).toBe(true);

    fireEvent.click(previous);
    expect(screen.getByText('review.progress:{"current":2,"total":3}')).toBeTruthy();
  });

  it("opens an annotation on the card in view with a reference to it already in place", async () => {
    await renderReview();

    fireEvent.click(screen.getByLabelText("review.next"));
    fireEvent.click(screen.getByText("review.annotate"));

    await waitFor(() => expect(screen.getByTestId("annotation-editor")).toBeTruthy());
    // An annotation references the reviewed memo rather than commenting on it,
    // so it is a thought of its own that happens to be anchored.
    expect(state.editorProps?.defaultContent).toBe("\n\n[Memos](/memos/bbb)");
    expect(state.editorProps?.cacheKey).toBe("memos/bbb-annotation");
  });

  it("offers the scope when the day's conditions match nothing", async () => {
    state.memos = [];
    await renderReview();

    expect(screen.getByText("review.empty")).toBeTruthy();
    expect(screen.queryByTestId("memo-card")).toBeNull();

    fireEvent.click(screen.getByText("review.adjust-scope"));
    await waitFor(() => expect(screen.getByText("settings-panel")).toBeTruthy());
  });
});
