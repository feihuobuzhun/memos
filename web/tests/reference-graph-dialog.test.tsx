import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ReferenceGraphDialog from "@/components/ReferenceGraph/ReferenceGraphDialog";
import { AppSidebarProvider, useAppSidebar } from "@/contexts/AppSidebarContext";
import {
  GetMemoReferenceGraphRequest_Direction,
  GetMemoReferenceGraphResponse_EdgeSchema,
  GetMemoReferenceGraphResponse_NodeSchema,
} from "@/types/proto/api/v1/memo_service_pb";

const state = vi.hoisted(() => ({
  calls: [] as Array<{ name?: string; direction?: number; depth?: number }>,
}));

const node = (name: string, snippet: string, depth: number, hasMore = false) =>
  create(GetMemoReferenceGraphResponse_NodeSchema, {
    name,
    snippet,
    depth,
    hasMore,
    createTime: timestampFromDate(new Date("2026-01-02T03:04:05Z")),
  });

const edge = (source: string, target: string) => create(GetMemoReferenceGraphResponse_EdgeSchema, { source, target });

// The graph of whichever memo was asked for, so re-rooting is observable.
const graphs: Record<string, { nodes: ReturnType<typeof node>[]; edges: ReturnType<typeof edge>[] }> = {
  "memos/a": {
    nodes: [node("memos/a", "card A", 0), node("memos/b", "card B", 1, true), node("memos/c", "card C", 1)],
    edges: [edge("memos/a", "memos/b"), edge("memos/a", "memos/c")],
  },
  "memos/b": {
    nodes: [node("memos/b", "card B", 0), node("memos/d", "card D", 1)],
    edges: [edge("memos/b", "memos/d")],
  },
  "memos/lonely": { nodes: [node("memos/lonely", "all alone", 0)], edges: [] },
};

vi.mock("@/hooks/useReferenceGraphQuery", () => ({
  useReferenceGraph: (name: string | undefined, direction: number, depth: number) => {
    state.calls.push({ name, direction, depth });
    return { data: name ? graphs[name] : undefined, isLoading: false, error: null };
  },
}));

vi.mock("@/utils/i18n", () => ({
  useTranslate: () => (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key),
}));

const Harness = ({ root }: { root: string }) => {
  const location = useLocation();
  const { setReferenceGraphMemo } = useAppSidebar();
  return (
    <>
      <output data-testid="path">{location.pathname}</output>
      <button type="button" onClick={() => setReferenceGraphMemo(root)}>
        open-graph
      </button>
      <ReferenceGraphDialog />
    </>
  );
};

const openGraph = async (root = "memos/a") => {
  render(
    <MemoryRouter>
      <AppSidebarProvider>
        <Harness root={root} />
      </AppSidebarProvider>
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByText("open-graph"));
  await waitFor(() => expect(screen.getByText("graph.title")).toBeTruthy());
};

const lastCall = () => state.calls[state.calls.length - 1];

describe("ReferenceGraphDialog", () => {
  beforeEach(() => {
    state.calls = [];
  });

  it("stays out of the way until a memo asks to be graphed", () => {
    render(
      <MemoryRouter>
        <AppSidebarProvider>
          <Harness root="memos/a" />
        </AppSidebarProvider>
      </MemoryRouter>,
    );

    expect(screen.queryByText("graph.title")).toBeNull();
    // Nothing is fetched while the graph is closed.
    expect(state.calls).toHaveLength(0);
  });

  it("draws the root and what it references, one card per memo", async () => {
    await openGraph();

    expect(screen.getByText("card A")).toBeTruthy();
    expect(screen.getByText("card B")).toBeTruthy();
    expect(screen.getByText("card C")).toBeTruthy();
    // Two references from the root, each drawn once.
    expect(screen.getByTestId("graph-edges").querySelectorAll("path")).toHaveLength(2);
    // A card with references past the requested depth invites a further look.
    expect(screen.getByLabelText("graph.has-more")).toBeTruthy();
  });

  it("shows full card text in naturally sized cards and names the selected direction", async () => {
    await openGraph();

    const textButton = screen.getByText("card A").closest("button") as HTMLButtonElement;
    const cardPositioner = textButton.parentElement?.parentElement as HTMLDivElement;
    expect(textButton.className).not.toContain("line-clamp");
    expect(cardPositioner.style.height).toBe("");
    expect(screen.getByLabelText("graph.direction").textContent).toContain("graph.direction-outgoing");
    expect(screen.getByLabelText("graph.direction").textContent).not.toContain("1");
  });

  it("continues from a card the reader clicks, and back again", async () => {
    await openGraph();
    expect(lastCall().name).toBe("memos/a");

    fireEvent.click(screen.getByText("card B"));
    await waitFor(() => expect(lastCall().name).toBe("memos/b"));
    expect(screen.getByText("card D")).toBeTruthy();

    fireEvent.click(screen.getByText("graph.back"));
    await waitFor(() => expect(lastCall().name).toBe("memos/a"));
    expect(screen.queryByText("graph.back")).toBeNull();
  });

  it("does not offer to continue from the card already at the centre", async () => {
    await openGraph();

    expect((screen.getByText("card A").closest("button") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText("card B").closest("button") as HTMLButtonElement).disabled).toBe(false);
  });

  it("opens a memo and closes the graph, rather than leaving it stacked over the page", async () => {
    await openGraph();

    fireEvent.click(screen.getAllByLabelText("graph.open-memo")[1]);

    await waitFor(() => expect(screen.getByTestId("path").textContent).toBe("/memos/b"));
    expect(screen.queryByText("graph.title")).toBeNull();
  });

  it("says so when a memo connects to nothing", async () => {
    await openGraph("memos/lonely");

    expect(screen.getByText("graph.no-references")).toBeTruthy();
    expect(screen.getByTestId("graph-edges").querySelectorAll("path")).toHaveLength(0);
  });

  it("asks the server again when the direction or the depth changes", async () => {
    await openGraph();

    expect(lastCall()).toMatchObject({
      direction: GetMemoReferenceGraphRequest_Direction.OUTGOING,
      depth: 3,
    });
  });
});
