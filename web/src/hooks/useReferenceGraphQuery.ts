import { useQuery } from "@tanstack/react-query";
import { memoServiceClient } from "@/connect";
import type { GetMemoReferenceGraphRequest_Direction } from "@/types/proto/api/v1/memo_service_pb";

/**
 * The reference neighbourhood around one memo. The server does the walk, so
 * opening the graph costs one request rather than one per card.
 */
export function useReferenceGraph(memoName: string | undefined, direction: GetMemoReferenceGraphRequest_Direction, depth: number) {
  return useQuery({
    queryKey: ["memo-reference-graph", memoName, direction, depth],
    queryFn: () => memoServiceClient.getMemoReferenceGraph({ name: memoName as string, direction, depth }),
    enabled: Boolean(memoName),
  });
}
