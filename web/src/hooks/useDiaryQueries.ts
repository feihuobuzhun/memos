import { create } from "@bufbuild/protobuf";
import { FieldMaskSchema } from "@bufbuild/protobuf/wkt";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { memoServiceClient, userServiceClient } from "@/connect";
import { localUtcOffsetMinutes } from "@/lib/diary";
import { buildUserSettingName } from "@/lib/resource-names";
import type { DiaryMood, ListDiaryMoodsResponse } from "@/types/proto/api/v1/memo_service_pb";
import {
  type UserSetting_DiarySetting,
  UserSetting_DiarySettingSchema,
  UserSetting_Key,
  UserSettingSchema,
} from "@/types/proto/api/v1/user_service_pb";
import useCurrentUser from "./useCurrentUser";

/**
 * What a user who has never opened the diary settings gets. `moodAnalysis` is
 * deliberately left unset: absence means "on" on both sides, so the panel shows
 * the state the server is already acting on.
 */
export const DEFAULT_DIARY_SETTING: UserSetting_DiarySetting = create(UserSetting_DiarySettingSchema, {});

/** Mood analysis is on unless this reader turned it off. */
export const diaryMoodAnalysisEnabled = (setting?: UserSetting_DiarySetting): boolean => setting?.moodAnalysis ?? true;

const diaryKeys = {
  setting: (userName: string) => ["diary", "setting", userName] as const,
  moods: (userName: string, startDate: string, endDate: string) => ["diary", "moods", userName, startDate, endDate] as const,
  allMoods: ["diary", "moods"] as const,
};

export function useDiarySetting(options?: { enabled?: boolean }) {
  const currentUser = useCurrentUser();
  const userName = currentUser?.name ?? "";
  return useQuery({
    queryKey: diaryKeys.setting(userName),
    queryFn: async () => {
      const setting = await userServiceClient.getUserSetting({
        name: buildUserSettingName(userName, UserSetting_Key.DIARY),
      });
      return setting.value.case === "diarySetting" ? setting.value.value : DEFAULT_DIARY_SETTING;
    },
    enabled: Boolean(userName) && (options?.enabled ?? true),
  });
}

export function useUpdateDiarySetting() {
  const queryClient = useQueryClient();
  const currentUser = useCurrentUser();
  const userName = currentUser?.name ?? "";

  return useMutation({
    mutationFn: async (diarySetting: UserSetting_DiarySetting) => {
      const updated = await userServiceClient.updateUserSetting({
        setting: create(UserSettingSchema, {
          name: buildUserSettingName(userName, UserSetting_Key.DIARY),
          value: { case: "diarySetting", value: diarySetting },
        }),
        updateMask: create(FieldMaskSchema, { paths: ["diary"] }),
      });
      return updated.value.case === "diarySetting" ? updated.value.value : DEFAULT_DIARY_SETTING;
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(diaryKeys.setting(userName), saved);
      // Different tags mean a different diary, and the stored readings were
      // taken from the old one.
      queryClient.invalidateQueries({ queryKey: diaryKeys.allMoods });
    },
  });
}

/**
 * The readings already taken for a date range. This never calls a provider, so
 * the diary renders whatever is stored without spending anything.
 */
export function useDiaryMoods(startDate: string, endDate: string, options?: { enabled?: boolean }) {
  const currentUser = useCurrentUser();
  const userName = currentUser?.name ?? "";
  return useQuery({
    queryKey: diaryKeys.moods(userName, startDate, endDate),
    queryFn: () => memoServiceClient.listDiaryMoods({ startDate, endDate }),
    enabled: Boolean(userName) && Boolean(startDate) && Boolean(endDate) && (options?.enabled ?? true),
    staleTime: 1000 * 60,
  });
}

/**
 * Reads one day's mood. The server returns the stored reading untouched while
 * the day is unchanged, so asking for a day twice is cheap; `force` is how a
 * reader deliberately asks for a second opinion.
 */
export function useAnalyzeDiaryMood() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ date, force }: { date: string; force?: boolean }) => {
      const response = await memoServiceClient.analyzeDiaryMood({
        date,
        // The reader's own clock decides where their day starts and ends.
        utcOffsetMinutes: localUtcOffsetMinutes(),
        force,
      });
      return response.mood;
    },
    onSuccess: (mood) => {
      if (!mood) return;
      // Patch the ranges already on screen instead of refetching them: the
      // reading that just came back is the newest thing anyone knows.
      queryClient.setQueriesData<ListDiaryMoodsResponse>({ queryKey: diaryKeys.allMoods }, (current) => {
        if (!current) return current;
        const moods = [mood, ...current.moods.filter((stored: DiaryMood) => stored.date !== mood.date)].sort((a, b) =>
          b.date.localeCompare(a.date),
        );
        return { ...current, moods };
      });
    },
  });
}
