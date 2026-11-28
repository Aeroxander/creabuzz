import { cn } from "./cn";

/** One label and its figure, in a row of a `dl`: the one helper every money list uses. */
export function Row({
  label,
  value,
  testId,
  strong,
}: {
  label: string;
  value: string;
  testId: string;
  strong?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <dt className="text-sm text-muted">{label}</dt>
      <dd
        className={cn("num text-right", strong && "font-semibold")}
        data-testid={testId}
      >
        {value}
      </dd>
    </div>
  );
}
