import { cn } from "@/shared/lib/cn";
import { meterPercent } from "@/shared/lib/meter-percent";

const fills = {
  success: "bg-emerald-500",
  info: "bg-blue-500",
  warning: "bg-amber-500",
} as const;

/**
 * A thin bar for how much of something is used or reached: Shares awarded of a work area's budget, support for a vote.
 * Bigints in, so token amounts never pass through floating point. `label` names it for screen readers; the figure itself
 * is said in text next to it.
 */
export function Meter({
  value,
  max,
  label,
  tone = "success",
  className,
  testId,
}: {
  value: bigint;
  max: bigint;
  label: string;
  tone?: keyof typeof fills;
  className?: string;
  testId?: string;
}) {
  const percent = meterPercent(value, max);
  return (
    <div
      aria-label={label}
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={percent}
      className={cn(
        "h-1.5 w-full overflow-hidden rounded-full bg-muted",
        className,
      )}
      data-testid={testId}
      role="progressbar"
    >
      <div
        className={cn("h-full rounded-full", fills[tone])}
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}
