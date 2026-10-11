import { useQuery } from "@tanstack/react-query";
import { memoServiceClient } from "@/connect";
import useCurrentUser from "@/hooks/useCurrentUser";
import { memoKeys } from "@/hooks/useMemoQueries";
import { buildMemoCreatorFilter } from "@/lib/resource-names";
import { State } from "@/types/proto/api/v1/common_pb";

/** Enough recent memos to find a handful of distinct tags. */
const RECENT_MEMO_COUNT = 30;

/**
 * The current user's tags from most to least recently used, ranked by the last
 * memo that carries each one. Lives under the memo list keys, so creating or
 * editing a memo refreshes it.
 */
export const useRecentTags = (): string[] => {
  const user = useCurrentUser();
  const creatorFilter = buildMemoCreatorFilter(user?.name ?? "");

  const { data } = useQuery({
    queryKey: [...memoKeys.lists(), "recent-tags", creatorFilter],
    enabled: Boolean(creatorFilter),
    staleTime: 1000 * 60,
    queryFn: async (): Promise<string[]> => {
      const { memos } = await memoServiceClient.listMemos({
        state: State.NORMAL,
        orderBy: "update_time desc",
        filter: creatorFilter,
        pageSize: RECENT_MEMO_COUNT,
      });
      return [...new Set(memos.flatMap((memo) => memo.tags))];
    },
  });
  return data ?? [];
};
