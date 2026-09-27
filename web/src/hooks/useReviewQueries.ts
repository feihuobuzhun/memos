import { create } from "@bufbuild/protobuf";
import { FieldMaskSchema } from "@bufbuild/protobuf/wkt";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { memoServiceClient, userServiceClient } from "@/connect";
import { buildUserSettingName } from "@/lib/resource-names";
import {
  UserSetting_Key,
  type UserSetting_ReviewSetting,
  UserSetting_ReviewSetting_Condition,
  UserSetting_ReviewSetting_TimeRange,
  UserSetting_ReviewSettingSchema,
  UserSettingSchema,
} from "@/types/proto/api/v1/user_service_pb";
import useCurrentUser from "./useCurrentUser";

/**
 * What a user who has never opened the review settings gets. Kept in step with
 * the server's own defaults so the panel renders the same values the review is
 * already using, rather than briefly showing something else.
 */
export const DEFAULT_REVIEW_SETTING: UserSetting_ReviewSetting = create(UserSetting_ReviewSettingSchema, {
  condition: UserSetting_ReviewSetting_Condition.ALL_MEMOS,
  timeRange: UserSetting_ReviewSetting_TimeRange.ALL_TIME,
  dailyCount: 16,
});

/** The reader's own calendar date, which is what makes a day's review a day. */
export const localReviewDate = (now: Date = new Date()): string => {
  const year = now.getFullYear();
  const month = `${now.getMonth() + 1}`.padStart(2, "0");
  const day = `${now.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const reviewKeys = {
  all: ["review"] as const,
  memos: (localDate: string) => ["review", "memos", localDate] as const,
  setting: (userName: string) => ["review", "setting", userName] as const,
};

/**
 * Today's review. Disabled until the dialog opens, so a user who never reviews
 * never pays for the query.
 */
export function useReviewMemos(localDate: string, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: reviewKeys.memos(localDate),
    queryFn: () => memoServiceClient.listReviewMemos({ localDate }),
    enabled: options?.enabled ?? true,
    // The selection is fixed for the day, so refetching on every focus change
    // would only cost requests without ever changing the answer.
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
  });
}

export function useReviewSetting(options?: { enabled?: boolean }) {
  const currentUser = useCurrentUser();
  const userName = currentUser?.name ?? "";
  return useQuery({
    queryKey: reviewKeys.setting(userName),
    queryFn: async () => {
      const setting = await userServiceClient.getUserSetting({
        name: buildUserSettingName(userName, UserSetting_Key.REVIEW),
      });
      return setting.value.case === "reviewSetting" ? setting.value.value : DEFAULT_REVIEW_SETTING;
    },
    enabled: Boolean(userName) && (options?.enabled ?? true),
  });
}

export function useUpdateReviewSetting() {
  const queryClient = useQueryClient();
  const currentUser = useCurrentUser();
  const userName = currentUser?.name ?? "";

  return useMutation({
    mutationFn: async (reviewSetting: UserSetting_ReviewSetting) => {
      const updated = await userServiceClient.updateUserSetting({
        setting: create(UserSettingSchema, {
          name: buildUserSettingName(userName, UserSetting_Key.REVIEW),
          value: { case: "reviewSetting", value: reviewSetting },
        }),
        updateMask: create(FieldMaskSchema, { paths: ["review"] }),
      });
      return updated.value.case === "reviewSetting" ? updated.value.value : DEFAULT_REVIEW_SETTING;
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(reviewKeys.setting(userName), saved);
      // A new condition means a different pool, so today's draw is no longer
      // the right one and has to be taken again.
      queryClient.invalidateQueries({ queryKey: ["review", "memos"] });
    },
  });
}

/** Drops today's selection so a newly written annotation shows up under its card. */
export function useRefreshReviewMemos() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ["review", "memos"] });
}
