import { LoaderCircleIcon, NotebookPenIcon, SettingsIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { MentionResolutionProvider } from "@/components/MemoContent/MentionResolutionContext";
import MemoEditor from "@/components/MemoEditor";
import MemoListError from "@/components/PagedMemoList/MemoListError";
import Placeholder from "@/components/Placeholder";
import { Button } from "@/components/ui/button";
import useCurrentUser from "@/hooks/useCurrentUser";
import { useDelayedFlag } from "@/hooks/useDelayedFlag";
import { diaryMoodAnalysisEnabled, useDiarySetting } from "@/hooks/useDiaryQueries";
import { useInfiniteMemos } from "@/hooks/useMemoQueries";
import { combineCELFilters } from "@/lib/cel-filter";
import { LOADING_INDICATOR_DELAY_MS } from "@/lib/constants";
import { buildDiaryFilter, effectiveDiaryTags, groupMemosByDay, localDiaryDate } from "@/lib/diary";
import { buildMemoCreatorFilter } from "@/lib/resource-names";
import { ROUTES } from "@/router/routes";
import { State } from "@/types/proto/api/v1/common_pb";
import { useTranslate } from "@/utils/i18n";
import DiaryDaySection from "./DiaryDaySection";
import DiaryMoodTrend, { diaryTrendStartDate } from "./DiaryMoodTrend";
import DiarySettingsDialog from "./DiarySettingsDialog";
import { useDiaryMoodReadings } from "./useDiaryMoodReadings";

/**
 * Days are long: a page of entries is bigger than a page of cards, so the diary
 * asks for more at a time than the timeline does and crosses fewer day
 * boundaries per request.
 */
const DIARY_PAGE_SIZE = 24;

const DiaryView = () => {
  const t = useTranslate();
  const currentUser = useCurrentUser();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { data: diarySetting, isLoading: isSettingLoading } = useDiarySetting();

  const tags = useMemo(() => effectiveDiaryTags(diarySetting), [diarySetting]);
  const filter = useMemo(
    () => combineCELFilters(currentUser ? buildMemoCreatorFilter(currentUser.name) : undefined, buildDiaryFilter(tags)),
    [currentUser, tags],
  );

  // Waiting for the setting avoids fetching the default diary and then the real
  // one the moment it arrives.
  const enabled = Boolean(currentUser) && !isSettingLoading;
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading, isError, error, refetch } = useInfiniteMemos(
    { state: State.NORMAL, orderBy: "create_time desc", filter, pageSize: DIARY_PAGE_SIZE },
    { enabled },
  );

  const memos = useMemo(() => data?.pages.flatMap((page) => page.memos) ?? [], [data]);
  const days = useMemo(() => groupMemosByDay(memos), [memos]);
  // The reader's today is fixed for the visit: a diary left open overnight is
  // not worth a timer, and the next navigation gets the new day.
  const today = useMemo(() => localDiaryDate(new Date()), []);
  const moodEnabled = diaryMoodAnalysisEnabled(diarySetting);
  const { moodByDate, available, readingDate, readDay } = useDiaryMoodReadings({
    days,
    today,
    trendStartDate: diaryTrendStartDate(today),
    enabled: enabled && moodEnabled,
  });

  // Fetch the next page as the reader approaches the end of what is loaded.
  useEffect(() => {
    if (!hasNextPage || isError) return;
    const onScroll = () => {
      if (isFetchingNextPage) return;
      if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 300) {
        void fetchNextPage();
      }
    };
    window.addEventListener("scroll", onScroll);
    return () => window.removeEventListener("scroll", onScroll);
  }, [hasNextPage, isError, isFetchingNextPage, fetchNextPage]);

  const contents = useMemo(() => memos.map((memo) => memo.content), [memos]);
  const isPending = isLoading || isSettingLoading;
  const showLoader = useDelayedFlag(isPending, LOADING_INDICATOR_DELAY_MS);
  // The tag the diary writes with: the first configured one, so a new entry
  // lands in the diary the reader is looking at.
  const seedContent = `#${tags[0]} `;

  return (
    <div className="w-full min-h-full bg-background text-foreground">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-3">
        <header className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 text-lg font-medium">
              <NotebookPenIcon className="size-5 text-muted-foreground" strokeWidth={1.8} />
              {t("diary.title")}
            </h1>
            {/* Which tags are being read is the one thing about this page that
                is not self-evident, so it is stated rather than hidden in the
                settings dialog. */}
            <p className="mt-0.5 truncate text-2xs text-muted-foreground">
              {t("diary.selected-tags", { tags: tags.map((tag) => `#${tag}`).join(" ") })}
            </p>
          </div>
          <Button variant="ghost" size="icon" aria-label={t("diary.settings")} onClick={() => setSettingsOpen(true)}>
            <SettingsIcon className="size-4" strokeWidth={1.8} />
          </Button>
        </header>

        <DiaryMoodTrend today={today} moodByDate={moodByDate} />

        {/* The editor is keyed on the tag it seeds, so it waits for the setting
            rather than remounting under a reader who already started writing. */}
        {currentUser && !isSettingLoading && (
          <MemoEditor
            key={seedContent}
            cacheKey="diary-memo-editor"
            placeholder={t("diary.editor-placeholder")}
            defaultContent={seedContent}
          />
        )}

        {isPending ? (
          showLoader && (
            <div className="flex justify-center py-8">
              <LoaderCircleIcon className="size-6 animate-spin text-muted-foreground" />
            </div>
          )
        ) : isError ? (
          <MemoListError error={error} onRetry={refetch} />
        ) : days.length === 0 ? (
          <Placeholder scene="memo" message={t("diary.empty")} className="w-full" />
        ) : (
          <MentionResolutionProvider contents={contents} userNames={[]}>
            <div className="flex flex-col">
              {days.map((day) => (
                <DiaryDaySection
                  key={day.date}
                  date={day.date}
                  memos={day.memos}
                  today={today}
                  mood={moodByDate.get(day.date)}
                  moodPending={readingDate === day.date}
                  moodAvailable={available}
                  onAnalyzeMood={({ force }) => readDay(day.date, force)}
                  parentPage={ROUTES.DIARY}
                />
              ))}
            </div>
          </MentionResolutionProvider>
        )}

        {isFetchingNextPage && (
          <div className="flex justify-center py-6">
            <LoaderCircleIcon className="size-5 animate-spin text-muted-foreground" />
          </div>
        )}
      </div>

      <DiarySettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        // Only a reader who asked for readings and still cannot get them tells
        // us the instance has no provider; a reader who opted out proves nothing.
        moodProviderMissing={moodEnabled && !available}
      />
    </div>
  );
};

export default DiaryView;
