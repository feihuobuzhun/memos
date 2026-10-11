import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { shiftDiaryDate } from "@/lib/diary";
import { useTranslate } from "@/utils/i18n";

interface Props {
  /** The day the next entry is written for, "YYYY-MM-DD". */
  value: string;
  /** The reader's today; a diary cannot be written for a day that has not happened. */
  today: string;
  onChange: (date: string) => void;
}

/**
 * Which day the new entry belongs to. It starts at today, and steps back for
 * the common case of writing up yesterday the next morning.
 */
const DiaryEntryDate = ({ value, today, onChange }: Props) => {
  const t = useTranslate();
  const isToday = value >= today;
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-ui text-muted-foreground">
      <span>{t("diary.entry-date")}</span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7"
        aria-label={t("diary.previous-day")}
        onClick={() => onChange(shiftDiaryDate(value, -1))}
      >
        <ChevronLeftIcon className="size-4" />
      </Button>
      <input
        type="date"
        aria-label={t("diary.entry-date")}
        className="rounded-md border border-border bg-background px-2 py-0.5 text-sm text-foreground"
        value={value}
        max={today}
        onChange={(event) => {
          // Clearing the field or typing past today keeps the current day.
          const next = event.target.value;
          if (next && next <= today) onChange(next);
        }}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7"
        aria-label={t("diary.next-day")}
        disabled={isToday}
        onClick={() => onChange(shiftDiaryDate(value, 1))}
      >
        <ChevronRightIcon className="size-4" />
      </Button>
      {!isToday && (
        <Button type="button" variant="ghost" size="sm" className="h-7 px-2" onClick={() => onChange(today)}>
          {t("diary.today")}
        </Button>
      )}
    </div>
  );
};

export default DiaryEntryDate;
