import { create } from "@bufbuild/protobuf";
import { CheckIcon, LoaderCircleIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "react-hot-toast";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import useCurrentUser from "@/hooks/useCurrentUser";
import { DEFAULT_REVIEW_SETTING, useReviewSetting, useUpdateReviewSetting } from "@/hooks/useReviewQueries";
import { useUserStats } from "@/hooks/useUserQueries";
import { conditionUsesTags, isReviewScopeSavable, withReviewCondition } from "@/lib/review-scope";
import { cn } from "@/lib/utils";
import {
  type UserSetting_ReviewSetting,
  UserSetting_ReviewSetting_Condition,
  UserSetting_ReviewSetting_TimeRange,
  UserSetting_ReviewSettingSchema,
} from "@/types/proto/api/v1/user_service_pb";
import { useTranslate } from "@/utils/i18n";

/** The counts offered; the server accepts anything up to 50. */
const DAILY_COUNT_OPTIONS = [5, 10, 16, 20, 30];

const CONDITION_OPTIONS = [
  { value: UserSetting_ReviewSetting_Condition.ALL_MEMOS, labelKey: "review.condition-all" },
  { value: UserSetting_ReviewSetting_Condition.INCLUDE_TAGS, labelKey: "review.condition-include-tags" },
  { value: UserSetting_ReviewSetting_Condition.EXCLUDE_TAGS, labelKey: "review.condition-exclude-tags" },
  { value: UserSetting_ReviewSetting_Condition.UNTAGGED, labelKey: "review.condition-untagged" },
] as const;

const TIME_RANGE_OPTIONS = [
  { value: UserSetting_ReviewSetting_TimeRange.ALL_TIME, labelKey: "review.time-range-all" },
  { value: UserSetting_ReviewSetting_TimeRange.LAST_MONTH, labelKey: "review.time-range-last-month" },
  { value: UserSetting_ReviewSetting_TimeRange.LAST_3_MONTHS, labelKey: "review.time-range-last-3-months" },
  { value: UserSetting_ReviewSetting_TimeRange.LAST_6_MONTHS, labelKey: "review.time-range-last-6-months" },
  { value: UserSetting_ReviewSetting_TimeRange.LAST_YEAR, labelKey: "review.time-range-last-year" },
] as const;

/**
 * One row of the scope card: the setting's name on the start edge, its current
 * value on the other. The whole row is the control, which is why the label is
 * not a `<label>` bound to it.
 */
const SettingRow = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex items-center justify-between gap-3 px-3 py-2.5">
    <span className="shrink-0 text-ui">{label}</span>
    <div className="min-w-0">{children}</div>
  </div>
);

const ReviewSettingsPanel = ({ onDone }: { onDone: () => void }) => {
  const t = useTranslate();
  const currentUser = useCurrentUser();
  const { data: stored, isLoading } = useReviewSetting();
  const updateReviewSetting = useUpdateReviewSetting();
  const { data: userStats } = useUserStats(currentUser?.name);

  const [draft, setDraft] = useState<UserSetting_ReviewSetting>(DEFAULT_REVIEW_SETTING);
  useEffect(() => {
    if (stored) setDraft(stored);
  }, [stored]);

  const allTags = useMemo(() => Object.keys(userStats?.tagCount ?? {}).sort((a, b) => a.localeCompare(b)), [userStats]);
  const selectedTags = new Set(draft.tags);
  const tagsRequired = conditionUsesTags(draft.condition);
  const canSave = isReviewScopeSavable(draft);

  const patch = (changes: Partial<UserSetting_ReviewSetting>) =>
    setDraft((current) => create(UserSetting_ReviewSettingSchema, { ...current, ...changes }));

  const toggleTag = (tag: string) => {
    const next = selectedTags.has(tag) ? draft.tags.filter((value) => value !== tag) : [...draft.tags, tag];
    patch({ tags: next });
  };

  const handleSave = async () => {
    if (!canSave) return;
    try {
      await updateReviewSetting.mutateAsync(draft);
      onDone();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  if (isLoading) {
    return (
      <div className="flex h-48 items-center justify-center">
        <LoaderCircleIcon className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label className="px-1 text-muted-foreground">{t("review.scope")}</Label>
        <div className="divide-y rounded-lg border bg-card">
          <SettingRow label={t("review.condition")}>
            <Select
              value={String(draft.condition)}
              onValueChange={(value) =>
                setDraft((current) => withReviewCondition(current, Number(value) as UserSetting_ReviewSetting_Condition))
              }
            >
              <SelectTrigger className="w-44 border-none bg-transparent shadow-none">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CONDITION_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={String(option.value)}>
                    {t(option.labelKey)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingRow>

          <SettingRow label={t("review.time-range")}>
            <Select
              value={String(draft.timeRange)}
              onValueChange={(value) => patch({ timeRange: Number(value) as UserSetting_ReviewSetting_TimeRange })}
            >
              <SelectTrigger className="w-44 border-none bg-transparent shadow-none">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TIME_RANGE_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={String(option.value)}>
                    {t(option.labelKey)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingRow>

          <SettingRow label={t("review.daily-count")}>
            <Select value={String(draft.dailyCount)} onValueChange={(value) => patch({ dailyCount: Number(value) })}>
              <SelectTrigger className="w-44 border-none bg-transparent shadow-none">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DAILY_COUNT_OPTIONS.map((option) => (
                  <SelectItem key={option} value={String(option)}>
                    {t("review.daily-count-value", { count: option })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingRow>
        </div>
      </div>

      {tagsRequired && (
        <div className="flex flex-col gap-1.5">
          <Label className="px-1 text-muted-foreground">{t("common.tags")}</Label>
          {allTags.length === 0 ? (
            <p className="px-1 text-sm text-muted-foreground">{t("review.tags-empty")}</p>
          ) : (
            <div className="flex max-h-48 flex-wrap gap-1.5 overflow-y-auto rounded-lg border bg-card p-3">
              {allTags.map((tag) => {
                const selected = selectedTags.has(tag);
                return (
                  <button
                    key={tag}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => toggleTag(tag)}
                    className={cn(
                      "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-sm transition-colors",
                      selected ? "border-primary bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {selected && <CheckIcon className="size-3.5" strokeWidth={2.2} />}#{tag}
                  </button>
                );
              })}
            </div>
          )}
          {/* A tag condition with no tag would quietly match everything, so the
              server rejects it; say so here instead of failing on save. */}
          {!canSave && <p className="px-1 text-sm text-destructive">{t("review.tags-required")}</p>}
        </div>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>
          {t("common.cancel")}
        </Button>
        <Button onClick={handleSave} disabled={!canSave || updateReviewSetting.isPending}>
          {updateReviewSetting.isPending && <LoaderCircleIcon className="size-4 animate-spin" />}
          {t("common.save")}
        </Button>
      </div>
    </div>
  );
};

export default ReviewSettingsPanel;
