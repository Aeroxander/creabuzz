/** One number with a label: the building block of the overview and the track record. */
export function Figure({
  label,
  value,
  note,
  testId,
}: {
  label: string;
  value: string;
  note?: string;
  testId: string;
}) {
  return (
    <div
      className="rounded-xl border border-border/60 p-3"
      data-testid={testId}
    >
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-lg font-bold tabular-nums">{value}</p>
      {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
    </div>
  );
}
