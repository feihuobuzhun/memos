import { create } from "@bufbuild/protobuf";
import { CheckIcon, LoaderCircleIcon, PlusIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "react-hot-toast";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import useCurrentUser from "@/hooks/useCurrentUser";
import { DEFAULT_DIARY_SETTING, diaryMoodAnalysisEnabled, useDiarySetting, useUpdateDiarySetting } from "@/hooks/useDiaryQueries";
import { useUserStats } from "@/hooks/useUserQueries";
import { DEFAULT_DIARY_TAGS } from "@/lib/diary";
import { cn } from "@/lib/utils";
import { type UserSetting_DiarySetting, UserSetting_DiarySettingSchema } from "@/types/proto/api/v1/user_service_pb";
import { useTranslate } from "@/utils/i18n";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Set when the instance is known to have no mood provider, so the row promises nothing it cannot do. */
  moodProviderMissing?: boolean;
}

const normalizeTag = (value: string): string =>
  value
    .trim()
    .replace(/^#/, "")
    .replace(/^\/+|\/+$/g, "");

/**
 * What counts as a diary entry, and whether the days are read for mood. The tag
 * list is the whole point of the dialog: a diary is whatever the author decided
 * to mark, so the tags are chosen here rather than fixed in the code.
 */
const DiarySettingsDialog = ({ open, onOpenChange, moodProviderMissing }: Props) => {
  const t = useTranslate();
  const currentUser = useCurrentUser();
  const { data: stored, isLoading } = useDiarySetting({ enabled: open });
  const { data: userStats } = useUserStats(currentUser?.name, { enabled: open });
  const updateDiarySetting = useUpdateDiarySetting();

  const [draft, setDraft] = useState<UserSetting_DiarySetting>(DEFAULT_DIARY_SETTING);
  const [newTag, setNewTag] = useState("");
  useEffect(() => {
    if (stored) setDraft(stored);
  }, [stored]);

  // The author's own tags, plus anything already selected. A tag can be chosen
  // before it has ever been written, so a brand-new diary is not a chicken and
  // egg problem.
  const allTags = useMemo(() => {
    const names = new Set<string>([...Object.keys(userStats?.tagCount ?? {}), ...draft.tags]);
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [userStats, draft.tags]);
  const selected = new Set(draft.tags);
  const moodEnabled = diaryMoodAnalysisEnabled(draft);

  const patch = (changes: Partial<UserSetting_DiarySetting>) =>
    setDraft((current) => create(UserSetting_DiarySettingSchema, { ...current, ...changes }));

  const toggleTag = (tag: string) =>
    patch({ tags: selected.has(tag) ? draft.tags.filter((value) => value !== tag) : [...draft.tags, tag] });

  const addTag = () => {
    const tag = normalizeTag(newTag);
    if (!tag || selected.has(tag)) {
      setNewTag("");
      return;
    }
    patch({ tags: [...draft.tags, tag] });
    setNewTag("");
  };

  const handleSave = async () => {
    try {
      await updateDiarySetting.mutateAsync(draft);
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{t("diary.settings")}</DialogTitle>
          <DialogDescription>{t("diary.settings-description")}</DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex h-40 items-center justify-center">
            <LoaderCircleIcon className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label className="px-1 text-muted-foreground">{t("diary.tags")}</Label>
              <div className="flex max-h-48 flex-wrap gap-1.5 overflow-y-auto rounded-lg border bg-card p-3">
                {allTags.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t("diary.tags-empty")}</p>
                ) : (
                  allTags.map((tag) => {
                    const active = selected.has(tag);
                    return (
                      <button
                        key={tag}
                        type="button"
                        aria-pressed={active}
                        onClick={() => toggleTag(tag)}
                        className={cn(
                          "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-sm transition-colors",
                          active ? "border-primary bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {active && <CheckIcon className="size-3.5" strokeWidth={2.2} />}#{tag}
                      </button>
                    );
                  })
                )}
              </div>
              <div className="flex items-center gap-2">
                <Input
                  value={newTag}
                  placeholder={t("diary.tag-add-placeholder")}
                  onChange={(event) => setNewTag(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addTag();
                    }
                  }}
                />
                <Button variant="outline" size="icon" aria-label={t("diary.tag-add")} onClick={addTag}>
                  <PlusIcon className="size-4" strokeWidth={1.8} />
                </Button>
              </div>
              {/* Choosing nothing is not "no diary": it falls back to the
                  defaults, and saying so beats an empty page nobody can explain. */}
              {draft.tags.length === 0 && (
                <p className="px-1 text-sm text-muted-foreground">
                  {t("diary.tags-default", { tags: DEFAULT_DIARY_TAGS.map((tag) => `#${tag}`).join(" ") })}
                </p>
              )}
            </div>

            <div className="flex items-start justify-between gap-3 rounded-lg border bg-card px-3 py-2.5">
              <div className="min-w-0">
                <p className="text-ui">{t("diary.mood-analysis")}</p>
                <p className="text-2xs text-muted-foreground">
                  {moodProviderMissing ? t("diary.mood-analysis-unconfigured") : t("diary.mood-analysis-description")}
                </p>
              </div>
              <Switch
                aria-label={t("diary.mood-analysis")}
                checked={moodEnabled}
                onCheckedChange={(checked) => patch({ moodAnalysis: checked })}
              />
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button onClick={handleSave} disabled={updateDiarySetting.isPending}>
            {updateDiarySetting.isPending && <LoaderCircleIcon className="size-4 animate-spin" />}
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default DiarySettingsDialog;
