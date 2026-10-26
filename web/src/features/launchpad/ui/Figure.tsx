import type { LucideIcon } from "lucide-react";

/** One number with a label: the building block of the overview and the track record. */
export function Figure({
  label,
  value,
  note,
  icon: Icon,
  testId,
}: {
  label: string;
  value: string;
  note?: string;
  icon?: LucideIcon;
  testId: string;
}) {
  return (
    <div className="rounded-xl bg-secondary/60 px-4 py-3" data-testid={testId}>
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {Icon ? <Icon aria-hidden className="h-3.5 w-3.5" /> : null}
        {label}
      </p>
      <p className="mt-0.5 text-2xl font-bold tabular-nums">{value}</p>
      {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
    </div>
  );
}
