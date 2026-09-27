import { ArrowUpRightIcon, LoaderCircleIcon, MinusIcon, PlusIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { VisuallyHidden } from "@/components/ui/visually-hidden";
import { useAppSidebar } from "@/contexts/AppSidebarContext";
import { useReferenceGraph } from "@/hooks/useReferenceGraphQuery";
import { GRAPH_NODE_HEIGHT, GRAPH_NODE_WIDTH, layoutReferenceGraph } from "@/lib/reference-graph-layout";
import { extractMemoIdFromName } from "@/lib/resource-names";
import { cn } from "@/lib/utils";
import { GetMemoReferenceGraphRequest_Direction } from "@/types/proto/api/v1/memo_service_pb";
import { useTranslate } from "@/utils/i18n";

/** The depths worth offering: past this the picture stops being readable. */
const DEPTH_OPTIONS = [1, 2, 3, 4, 5];
const DEFAULT_DEPTH = 3;

const DIRECTION_OPTIONS = [
  { value: GetMemoReferenceGraphRequest_Direction.OUTGOING, labelKey: "graph.direction-outgoing" },
  { value: GetMemoReferenceGraphRequest_Direction.INCOMING, labelKey: "graph.direction-incoming" },
  { value: GetMemoReferenceGraphRequest_Direction.BOTH, labelKey: "graph.direction-both" },
] as const;

/**
 * The reference graph around one memo, drawn as a tidy tree growing to the
 * right: the root on the left, what it references beside it, and so on.
 *
 * Clicking a card re-roots the graph there and pushes a trail entry, which is
 * how a reader follows a thought outward without ever leaving the dialog.
 */
const ReferenceGraphContent = ({ rootName, onClose }: { rootName: string; onClose: () => void }) => {
  const t = useTranslate();
  const navigate = useNavigate();
  const [direction, setDirection] = useState(GetMemoReferenceGraphRequest_Direction.OUTGOING);
  const [depth, setDepth] = useState(DEFAULT_DEPTH);
  // Where the reader came from, so following a card outward is reversible.
  const [trail, setTrail] = useState<string[]>([rootName]);
  const current = trail[trail.length - 1];

  useEffect(() => setTrail([rootName]), [rootName]);

  const { data, isLoading, error } = useReferenceGraph(current, direction, depth);
  const nodes = useMemo(() => data?.nodes ?? [], [data]);
  const layout = useMemo(() => layoutReferenceGraph(nodes, data?.edges ?? [], direction), [nodes, data, direction]);
  const nodeByName = useMemo(() => new Map(nodes.map((node) => [node.name, node])), [nodes]);

  const openMemo = (name: string) => {
    onClose();
    navigate(`/memos/${extractMemoIdFromName(name)}`);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="full" className="h-[calc(100vh-4rem)]" showCloseButton={false}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <DialogTitle className="truncate">{t("graph.title")}</DialogTitle>
            {trail.length > 1 && (
              <Button variant="ghost" size="sm" onClick={() => setTrail((entries) => entries.slice(0, -1))}>
                {t("graph.back")}
              </Button>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Select value={String(direction)} onValueChange={(value) => setDirection(Number(value))}>
              <SelectTrigger className="w-36" aria-label={t("graph.direction")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DIRECTION_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={String(option.value)}>
                    {t(option.labelKey)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={String(depth)} onValueChange={(value) => setDepth(Number(value))}>
              <SelectTrigger className="w-28" aria-label={t("graph.depth")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DEPTH_OPTIONS.map((option) => (
                  <SelectItem key={option} value={String(option)}>
                    {t("graph.depth-value", { count: option })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="ghost" size="sm" onClick={onClose}>
              {t("common.close")}
            </Button>
          </div>
        </div>
        <VisuallyHidden>
          <DialogDescription>{t("graph.description")}</DialogDescription>
        </VisuallyHidden>

        {isLoading ? (
          <div className="flex flex-1 items-center justify-center">
            <LoaderCircleIcon className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <div className="flex flex-1 items-center justify-center">
            <p className="text-muted-foreground">{error instanceof Error ? error.message : String(error)}</p>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-2">
            {/* One scroll surface for both axes: a graph is wider than it is
                tall, and panning it is how a reader reads it. */}
            <div className="min-h-0 flex-1 overflow-auto rounded-lg border bg-muted/20 p-6">
              <div className="relative" style={{ width: layout.width, height: layout.height }}>
                <svg
                  data-testid="graph-edges"
                  className="absolute inset-0 overflow-visible"
                  width={layout.width}
                  height={layout.height}
                  aria-hidden="true"
                  focusable="false"
                >
                  {layout.edges.map((edge) => (
                    <path
                      key={`${edge.source}->${edge.target}`}
                      d={edge.path}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={edge.tree ? 1.5 : 1}
                      // An edge that did not place its target is a real
                      // reference that happens to point somewhere already on
                      // screen; dashed says "also connected", not "lesser".
                      strokeDasharray={edge.tree ? undefined : "4 4"}
                      className={edge.tree ? "text-border" : "text-border/60"}
                    />
                  ))}
                </svg>
                {layout.nodes.map((positioned) => {
                  const node = nodeByName.get(positioned.name);
                  if (!node) return null;
                  const isRoot = positioned.depth === 0;
                  return (
                    <div
                      key={positioned.name}
                      className="absolute"
                      style={{ left: positioned.x, top: positioned.y, width: GRAPH_NODE_WIDTH, height: GRAPH_NODE_HEIGHT }}
                    >
                      <div
                        className={cn(
                          "flex h-full flex-col justify-between rounded-lg border bg-card p-2.5 text-start shadow-xs transition-colors",
                          isRoot ? "border-primary" : "hover:border-primary/60",
                        )}
                      >
                        <button
                          type="button"
                          // Following a card re-roots the graph on it, which is
                          // the only way to see past the requested depth.
                          onClick={() => setTrail((entries) => [...entries, positioned.name])}
                          disabled={isRoot}
                          className="line-clamp-3 min-w-0 text-start text-sm leading-snug disabled:cursor-default"
                          title={node.snippet}
                        >
                          {node.snippet || t("graph.empty-memo")}
                        </button>
                        <div className="flex items-center justify-between gap-1 text-xs text-muted-foreground">
                          <span>{node.createTime ? new Date(Number(node.createTime.seconds) * 1000).toLocaleDateString() : ""}</span>
                          <span className="flex items-center gap-0.5">
                            {node.hasMore && <PlusIcon className="size-3.5" strokeWidth={2} aria-label={t("graph.has-more")} />}
                            <button
                              type="button"
                              onClick={() => openMemo(positioned.name)}
                              aria-label={t("graph.open-memo")}
                              className="rounded p-0.5 hover:bg-accent hover:text-accent-foreground"
                            >
                              <ArrowUpRightIcon className="size-3.5" strokeWidth={2} />
                            </button>
                          </span>
                        </div>
                      </div>
                    </div>
                  );
                })}
                {layout.nodes.length <= 1 && (
                  <p className="absolute top-1/2 left-0 -translate-y-1/2 ps-2 text-muted-foreground">{t("graph.no-references")}</p>
                )}
              </div>
            </div>
            <p className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
              <MinusIcon className="size-3.5 shrink-0" strokeWidth={2} />
              {t("graph.legend")}
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};

/** Mounted once by the layout; runs nothing until a memo asks to be graphed. */
const ReferenceGraphDialog = () => {
  const { referenceGraphMemo, setReferenceGraphMemo } = useAppSidebar();
  if (!referenceGraphMemo) return null;
  return <ReferenceGraphContent rootName={referenceGraphMemo} onClose={() => setReferenceGraphMemo(undefined)} />;
};

export default ReferenceGraphDialog;
