import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { GRAPH_COLUMN_GAP, GRAPH_NODE_HEIGHT, GRAPH_NODE_WIDTH, GRAPH_ROW_GAP, layoutReferenceGraph } from "@/lib/reference-graph-layout";
import { GetMemoReferenceGraphRequest_Direction, GetMemoReferenceGraphResponse_EdgeSchema } from "@/types/proto/api/v1/memo_service_pb";

const COLUMN_STRIDE = GRAPH_NODE_WIDTH + GRAPH_COLUMN_GAP;
const ROW_STRIDE = GRAPH_NODE_HEIGHT + GRAPH_ROW_GAP;

const node = (name: string, depth: number) => ({ name, depth });
const edge = (source: string, target: string) => create(GetMemoReferenceGraphResponse_EdgeSchema, { source, target });

const { OUTGOING, INCOMING, BOTH } = GetMemoReferenceGraphRequest_Direction;

/** The shape the feature was designed around: A → (B, C), B → (D, E), C → (F, G). */
const fanOut = {
  nodes: [node("a", 0), node("b", 1), node("c", 1), node("d", 2), node("e", 2), node("f", 2), node("g", 2)],
  edges: [edge("a", "b"), edge("a", "c"), edge("b", "d"), edge("b", "e"), edge("c", "f"), edge("c", "g")],
};

const positionOf = (layout: ReturnType<typeof layoutReferenceGraph>, name: string) =>
  layout.nodes.find((candidate) => candidate.name === name);

describe("layoutReferenceGraph", () => {
  it("puts each card in the column of its distance from the root", () => {
    const layout = layoutReferenceGraph(fanOut.nodes, fanOut.edges, OUTGOING);

    expect(positionOf(layout, "a")?.x).toBe(0);
    expect(positionOf(layout, "b")?.x).toBe(COLUMN_STRIDE);
    expect(positionOf(layout, "g")?.x).toBe(2 * COLUMN_STRIDE);
    expect(layout.width).toBe(2 * COLUMN_STRIDE + GRAPH_NODE_WIDTH);
  });

  it("gives every leaf its own row and centres a parent on its children", () => {
    const layout = layoutReferenceGraph(fanOut.nodes, fanOut.edges, OUTGOING);

    // Four leaves, one row each, top to bottom in breadth-first order.
    expect(["d", "e", "f", "g"].map((name) => positionOf(layout, name)?.y)).toEqual([0, ROW_STRIDE, 2 * ROW_STRIDE, 3 * ROW_STRIDE]);
    // B sits between D and E, C between F and G, A between B and C.
    expect(positionOf(layout, "b")?.y).toBe(0.5 * ROW_STRIDE);
    expect(positionOf(layout, "c")?.y).toBe(2.5 * ROW_STRIDE);
    expect(positionOf(layout, "a")?.y).toBe(1.5 * ROW_STRIDE);
    expect(layout.height).toBe(4 * ROW_STRIDE - GRAPH_ROW_GAP);
  });

  it("uses measured card heights so long content cannot overlap another row", () => {
    const tallHeight = 180;
    const layout = layoutReferenceGraph(
      [node("a", 0), { ...node("b", 1), height: tallHeight }, node("c", 1)],
      [edge("a", "b"), edge("a", "c")],
      OUTGOING,
    );
    const root = positionOf(layout, "a");
    const tall = positionOf(layout, "b");
    const short = positionOf(layout, "c");

    expect(tall?.height).toBe(tallHeight);
    expect(short?.y).toBe(tallHeight + GRAPH_ROW_GAP + (tallHeight - GRAPH_NODE_HEIGHT) / 2);
    expect((tall?.y ?? 0) + (tall?.height ?? 0) + GRAPH_ROW_GAP).toBeLessThanOrEqual(short?.y ?? 0);
    expect(root?.y).toBe((tallHeight + GRAPH_ROW_GAP) / 2 + (tallHeight - GRAPH_NODE_HEIGHT) / 2);
    expect(layout.height).toBe(2 * (tallHeight + GRAPH_ROW_GAP) - GRAPH_ROW_GAP);
  });

  it("draws every edge, marking the ones that placed their target", () => {
    const layout = layoutReferenceGraph(fanOut.nodes, fanOut.edges, OUTGOING);

    expect(layout.edges).toHaveLength(6);
    expect(layout.edges.every((laidOut) => laidOut.tree)).toBe(true);
    expect(layout.edges[0].path).toMatch(/^M \d/);
  });

  it("keeps a card in one place and dashes the edge that closes a cycle", () => {
    const layout = layoutReferenceGraph(
      [node("a", 0), node("b", 1), node("c", 2)],
      [edge("a", "b"), edge("b", "c"), edge("c", "a")],
      OUTGOING,
    );

    expect(layout.nodes).toHaveLength(3);
    const closing = layout.edges.find((laidOut) => laidOut.source === "c" && laidOut.target === "a");
    expect(closing?.tree).toBe(false);
    // Pointing back to an earlier column, so it leaves from C's start edge and
    // arrives at A's end edge rather than cutting across the cards.
    expect(closing?.path.startsWith(`M ${2 * COLUMN_STRIDE} `)).toBe(true);
    expect(closing?.path.endsWith(`${GRAPH_NODE_WIDTH} ${GRAPH_NODE_HEIGHT / 2}`)).toBe(true);
  });

  it("follows edges backwards when the reader asked who points here", () => {
    const nodes = [node("b", 0), node("a", 1), node("h", 1)];
    const edges = [edge("a", "b"), edge("h", "b")];

    const incoming = layoutReferenceGraph(nodes, edges, INCOMING);
    expect(incoming.edges.filter((laidOut) => laidOut.tree)).toHaveLength(2);

    // In the outgoing reading, nothing leads away from B, so neither edge places
    // a card and both rows fall through to the orphan pass.
    const outgoing = layoutReferenceGraph(nodes, edges, OUTGOING);
    expect(outgoing.edges.every((laidOut) => !laidOut.tree)).toBe(true);
    expect(outgoing.nodes).toHaveLength(3);
  });

  it("walks either way when the reader asked for both", () => {
    const layout = layoutReferenceGraph([node("b", 0), node("a", 1), node("d", 1)], [edge("a", "b"), edge("b", "d")], BOTH);

    expect(layout.edges.filter((laidOut) => laidOut.tree)).toHaveLength(2);
    expect(positionOf(layout, "a")?.x).toBe(COLUMN_STRIDE);
    expect(positionOf(layout, "d")?.x).toBe(COLUMN_STRIDE);
  });

  it("still places a card the walk never reached, so the budget cannot hide one", () => {
    const layout = layoutReferenceGraph([node("a", 0), node("b", 1), node("stray", 2)], [edge("a", "b")], OUTGOING);

    expect(layout.nodes.map((laidOut) => laidOut.name)).toEqual(["a", "b", "stray"]);
    expect(positionOf(layout, "stray")?.x).toBe(2 * COLUMN_STRIDE);
  });

  it("handles an empty graph", () => {
    expect(layoutReferenceGraph([], [], OUTGOING)).toEqual({ nodes: [], edges: [], width: 0, height: 0 });
  });
});
