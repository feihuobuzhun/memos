import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { conditionUsesTags, isReviewScopeSavable, withReviewCondition } from "@/lib/review-scope";
import {
  UserSetting_ReviewSetting_Condition,
  UserSetting_ReviewSetting_TimeRange,
  UserSetting_ReviewSettingSchema,
} from "@/types/proto/api/v1/user_service_pb";

const draft = (condition: UserSetting_ReviewSetting_Condition, tags: string[] = []) =>
  create(UserSetting_ReviewSettingSchema, {
    condition,
    tags,
    timeRange: UserSetting_ReviewSetting_TimeRange.LAST_YEAR,
    dailyCount: 16,
  });

describe("review scope", () => {
  it("only reads tags for the two tag conditions", () => {
    expect(conditionUsesTags(UserSetting_ReviewSetting_Condition.INCLUDE_TAGS)).toBe(true);
    expect(conditionUsesTags(UserSetting_ReviewSetting_Condition.EXCLUDE_TAGS)).toBe(true);
    expect(conditionUsesTags(UserSetting_ReviewSetting_Condition.ALL_MEMOS)).toBe(false);
    expect(conditionUsesTags(UserSetting_ReviewSetting_Condition.UNTAGGED)).toBe(false);
  });

  it("drops the tag list when switching to a condition that ignores tags", () => {
    const tagged = draft(UserSetting_ReviewSetting_Condition.INCLUDE_TAGS, ["book", "idea"]);
    expect(withReviewCondition(tagged, UserSetting_ReviewSetting_Condition.UNTAGGED).tags).toEqual([]);
    expect(withReviewCondition(tagged, UserSetting_ReviewSetting_Condition.ALL_MEMOS).tags).toEqual([]);
  });

  it("keeps the tag list and the rest of the scope when switching between tag conditions", () => {
    const tagged = draft(UserSetting_ReviewSetting_Condition.INCLUDE_TAGS, ["book"]);
    const switched = withReviewCondition(tagged, UserSetting_ReviewSetting_Condition.EXCLUDE_TAGS);
    expect(switched.tags).toEqual(["book"]);
    expect(switched.timeRange).toBe(UserSetting_ReviewSetting_TimeRange.LAST_YEAR);
    expect(switched.dailyCount).toBe(16);
  });

  it("refuses to save a tag condition with no tag, since it would match everything", () => {
    expect(isReviewScopeSavable(draft(UserSetting_ReviewSetting_Condition.INCLUDE_TAGS))).toBe(false);
    expect(isReviewScopeSavable(draft(UserSetting_ReviewSetting_Condition.INCLUDE_TAGS, ["book"]))).toBe(true);
    expect(isReviewScopeSavable(draft(UserSetting_ReviewSetting_Condition.UNTAGGED))).toBe(true);
  });
});
