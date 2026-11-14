import { ChevronRight, type LucideIcon } from "lucide-react";

/**
 * One number with a label: the building block of the overview and the track record. With `onOpen` the whole tile is a
 * button to the place the number counts (open votes to Decisions), so a figure leads somewhere instead of only saying.
 */
export function Figure({
  label,
  value,
  note,
  icon: Icon,
  testId,
  valueTestId,
  onOpen,
}: {
  label: string;
  value: string;
  note?: string;
  icon?: LucideIcon;
  testId: string;
  /** For a test that reads the number alone. */
  valueTestId?: string;
  onOpen?: () => void;
}) {
  const body = (
    <>
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {Icon ? <Icon aria-hidden className="h-3.5 w-3.5" /> : null}
        {label}
        {onOpen ? (
          <ChevronRight aria-hidden className="ml-auto h-3.5 w-3.5" />
        ) : null}
      </p>
      <p
        className="mt-0.5 text-2xl font-bold tabular-nums"
        data-testid={valueTestId}
      >
        {value}
      </p>
      {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
    </>
  );
  if (onOpen) {
    return (
      <button
        className="rounded-xl bg-secondary/60 px-4 py-3 text-left transition-colors hover:bg-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        data-testid={testId}
        onClick={onOpen}
        type="button"
      >
        {body}
      </button>
    );
  }
  return (
    <div className="rounded-xl bg-secondary/60 px-4 py-3" data-testid={testId}>
      {body}
    </div>
  );
}
