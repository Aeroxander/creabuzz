import { cn } from "@/shared/lib/cn";

import {
  UTILIZATION_TONE_BAR_CLASS,
  utilizationPercentage,
  utilizationTone,
} from "./utilizationThresholds";

/** Default floor reported when a caller does not pass its fetch cap. */
export const DEFAULT_UTILIZATION_FLOOR = 500;

export type UtilizationBarProps = {
  /**
   * Accessible name for what is being measured (e.g. "Agent turn usage for
   * <subject>"). Also the label shown above the bar.
   */
  label: string;
  /** Units consumed inside the window. */
  consumed: number;
  /** Ceiling for the window; null/undefined = no ceiling (advisory only). */
  limit?: number | null;
  /**
   * Honesty rule (reference §2.5): when the underlying count hit a fetch cap
   * it is a floor — render the floor note, never a percentage computed from
   * a truncated set.
   */
  truncated?: boolean;
  /** Fetch-cap value for the floor note (default 500). */
  floor?: number;
  /** Mono readout right of the label, e.g. "32 / 50 runs used". */
  readout?: string;
  /** Secondary line under the bar (e.g. "resets monthly"). */
  caption?: string;
  className?: string;
  testId?: string;
};

/**
 * Budget utilization bar with the shared 70/90 threshold vocabulary
 * (utilizationBar.ts). Numbers are monospace/tabular; the fill color routes
 * through the semantic status tokens. When `truncated` is set (or there is
 * no ceiling to compare against) no bar is rendered — a bar would imply a
 * percentage the data cannot support.
 */
export function UtilizationBar({
  label,
  consumed,
  limit = null,
  truncated = false,
  floor = DEFAULT_UTILIZATION_FLOOR,
  readout,
  caption,
  className,
  testId,
}: UtilizationBarProps) {
  const percentage = utilizationPercentage(consumed, limit);
  const showBar = !truncated && percentage !== null;
  const tone = utilizationTone(percentage);

  return (
    <div className={cn("space-y-1", className)} data-testid={testId}>
      {(readout || truncated) && (
        <div className="flex items-baseline justify-between gap-2">
          <span className="min-w-0 truncate text-2xs text-muted-foreground">
            {label}
          </span>
          {truncated ? (
            <span className="shrink-0 text-2xs font-medium text-status-waiting">
              {`>${floor} in window — count is a floor`}
            </span>
          ) : (
            readout && (
              <span className="shrink-0 font-mono text-2xs tabular-nums text-muted-foreground">
                {readout}
              </span>
            )
          )}
        </div>
      )}
      {showBar && (
        <div
          aria-label={label}
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={Math.round(Math.min(100, Math.max(0, percentage)))}
          className="h-2 w-full overflow-hidden rounded-full bg-muted"
          role="progressbar"
        >
          <div
            className={cn(
              "h-full rounded-full transition-[width] duration-200",
              UTILIZATION_TONE_BAR_CLASS[tone],
            )}
            style={{
              width: `${Math.min(100, Math.max(0, percentage))}%`,
            }}
          />
        </div>
      )}
      {caption && <p className="text-2xs text-muted-foreground">{caption}</p>}
    </div>
  );
}
