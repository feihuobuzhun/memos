import { create } from "@bufbuild/protobuf";
import {
  type UserSetting_ReviewSetting,
  UserSetting_ReviewSetting_Condition,
  UserSetting_ReviewSettingSchema,
} from "@/types/proto/api/v1/user_service_pb";

/** Whether a review condition reads the tag list at all. */
export const conditionUsesTags = (condition: UserSetting_ReviewSetting_Condition): boolean =>
  condition === UserSetting_ReviewSetting_Condition.INCLUDE_TAGS || condition === UserSetting_ReviewSetting_Condition.EXCLUDE_TAGS;

/**
 * The draft after picking a condition. A condition that ignores tags drops the
 * list, matching what the server stores, so switching away and back never
 * resurrects a stale selection the reader can no longer see.
 */
export const withReviewCondition = (
  draft: UserSetting_ReviewSetting,
  condition: UserSetting_ReviewSetting_Condition,
): UserSetting_ReviewSetting =>
  create(UserSetting_ReviewSettingSchema, { ...draft, condition, tags: conditionUsesTags(condition) ? draft.tags : [] });

/** A tag condition with no tag would quietly match everything, so the server rejects it. */
export const isReviewScopeSavable = (draft: UserSetting_ReviewSetting): boolean =>
  !conditionUsesTags(draft.condition) || draft.tags.length > 0;
