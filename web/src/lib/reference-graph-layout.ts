import { GetMemoReferenceGraphRequest_Direction, type GetMemoReferenceGraphResponse_Edge } from "@/types/proto/api/v1/memo_service_pb";

/**
 * Geometry of one card in the graph. Fixed rather than content-driven: a column
 * of cards that are all the same size reads as a level, and a level is the
 * whole point of the picture.
 */
export const GRAPH_NODE_WIDTH = 208;
export const GRAPH_NODE_HEIGHT = 84;
export const GRAPH_COLUMN_GAP = 72;
export const GRAPH_ROW_GAP = 16;

const COLUMN_STRIDE = GRAPH_NODE_WIDTH + GRAPH_COLUMN_GAP;
const ROW_STRIDE = GRAPH_NODE_HEIGHT + GRAPH_ROW_GAP;

export interface ReferenceGraphInputNode {
  name: string;
  depth: number;
}

export interface PositionedNode {
  name: string;
  /** Hops from the root, which is also the column. */
  depth: number;
  x: number;
  y: number;
}

export interface PositionedEdge {
  source: string;
  target: string;
  /** SVG cubic path from the source card's edge to the target card's edge. */
  path: string;
  /**
   * Whether this edge is the one that placed its target. The rest are real
   * references too, but drawing them the same way would suggest the target
   * lives in two places at once.
   */
  tree: boolean;
}

export interface ReferenceGraphLayout {
  nodes: PositionedNode[];
  edges: PositionedEdge[];
  width: number;
  height: number;
}

/**
 * Which end of an edge counts as "the next card" depends on what the reader
 * asked to see: what this memo points at, what points at it, or both.
 */
const followEdge = (
  edge: GetMemoReferenceGraphResponse_Edge,
  from: string,
  direction: GetMemoReferenceGraphRequest_Direction,
): string | undefined => {
  if (edge.source === from && direction !== GetMemoReferenceGraphRequest_Direction.INCOMING) return edge.target;
  if (edge.target === from && direction !== GetMemoReferenceGraphRequest_Direction.OUTGOING) return edge.source;
  return undefined;
};

/**
 * Lays the reference graph out as a tidy tree growing to the right: the root on
 * the left, every card in the column of its distance from the root, and a
 * parent centred on the children it introduced.
 *
 * The response is a graph, not a tree — references form cycles and skip levels.
 * Each memo is therefore drawn once, in the column the server put it in, under
 * the first card that reached it; every other edge is still drawn, just marked
 * as not having placed anything. That keeps the picture readable without
 * quietly hiding a real connection.
 */
export const layoutReferenceGraph = (
  nodes: readonly ReferenceGraphInputNode[],
  edges: readonly GetMemoReferenceGraphResponse_Edge[],
  direction: GetMemoReferenceGraphRequest_Direction,
): ReferenceGraphLayout => {
  if (nodes.length === 0) {
    return { nodes: [], edges: [], width: 0, height: 0 };
  }

  const byName = new Map(nodes.map((node) => [node.name, node]));
  const root = nodes[0];

  // Children in the order their parent's column was walked, so the picture is
  // stable across renders and matches the server's breadth-first order.
  const children = new Map<string, string[]>();
  const placedBy = new Map<string, string>();
  const treeEdgeKeys = new Set<string>();
  const queue = [root.name];
  const visited = new Set([root.name]);
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const edge of edges) {
      const next = followEdge(edge, current, direction);
      if (next === undefined || visited.has(next) || !byName.has(next)) continue;
      visited.add(next);
      placedBy.set(next, current);
      treeEdgeKeys.add(`${edge.source}\u0000${edge.target}`);
      children.set(current, [...(children.get(current) ?? []), next]);
      queue.push(next);
    }
  }

  // A card the walk never reached — possible when the server's node budget cut
  // the edge that would have introduced it — still belongs on screen.
  const orphans = nodes.filter((node) => !visited.has(node.name));

  const rows = new Map<string, number>();
  let nextRow = 0;
  const assignRows = (name: string) => {
    const kids = children.get(name) ?? [];
    if (kids.length === 0) {
      rows.set(name, nextRow);
      nextRow += 1;
      return;
    }
    for (const kid of kids) assignRows(kid);
    const first = rows.get(kids[0]) ?? 0;
    const last = rows.get(kids[kids.length - 1]) ?? first;
    rows.set(name, (first + last) / 2);
  };
  assignRows(root.name);
  for (const orphan of orphans) {
    rows.set(orphan.name, nextRow);
    nextRow += 1;
  }

  const positioned = new Map<string, PositionedNode>();
  for (const node of nodes) {
    const row = rows.get(node.name) ?? 0;
    positioned.set(node.name, {
      name: node.name,
      depth: node.depth,
      x: node.depth * COLUMN_STRIDE,
      y: row * ROW_STRIDE,
    });
  }

  const laidOutEdges: PositionedEdge[] = [];
  for (const edge of edges) {
    const source = positioned.get(edge.source);
    const target = positioned.get(edge.target);
    if (!source || !target) continue;
    laidOutEdges.push({
      source: edge.source,
      target: edge.target,
      path: edgePath(source, target),
      tree: treeEdgeKeys.has(`${edge.source}\u0000${edge.target}`),
    });
  }

  const maxDepth = Math.max(...nodes.map((node) => node.depth));
  return {
    nodes: nodes.map((node) => positioned.get(node.name) as PositionedNode),
    edges: laidOutEdges,
    width: maxDepth * COLUMN_STRIDE + GRAPH_NODE_WIDTH,
    height: Math.max(nextRow, 1) * ROW_STRIDE - GRAPH_ROW_GAP,
  };
};

/**
 * A cubic curve leaving the source card horizontally and arriving at the target
 * the same way, which is what makes a fan-out read as one hand-drawn bracket.
 * An edge that points back to an earlier column leaves and arrives on the same
 * sides, so it visibly loops instead of cutting through the cards.
 */
const edgePath = (source: PositionedNode, target: PositionedNode): string => {
  const forward = target.x > source.x;
  const startX = forward ? source.x + GRAPH_NODE_WIDTH : source.x;
  const endX = forward ? target.x : target.x + GRAPH_NODE_WIDTH;
  const startY = source.y + GRAPH_NODE_HEIGHT / 2;
  const endY = target.y + GRAPH_NODE_HEIGHT / 2;
  const reach = forward ? Math.max((endX - startX) / 2, 24) : GRAPH_COLUMN_GAP / 2;
  const controlStartX = forward ? startX + reach : startX - reach;
  const controlEndX = forward ? endX - reach : endX + reach;
  return `M ${startX} ${startY} C ${controlStartX} ${startY}, ${controlEndX} ${endY}, ${endX} ${endY}`;
};
