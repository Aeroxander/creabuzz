import { cn } from "@/shared/lib/cn";
import { STATUS_TONE_CLASSES, type StatusTone } from "@/shared/ui/statusTone";

import type { AgentLivenessStatus } from "../lib/nodeLiveness";

const BADGE_TONE: Record<AgentLivenessStatus, StatusTone> = {
  live: "live",
  waiting: "waiting",
  // Gray = neutral/terminal in the status tier: an agent that has been gone
  // is not failing, it is absent.
  gone: "neutral",
};

const BADGE_LABEL: Record<AgentLivenessStatus, string> = {
  live: "Live",
  waiting: "Waiting",
  gone: "Gone",
};

/**
 * Liveness pill for org surfaces (canvas cards take the bare StatusGlyph dot;
 * list rows, the drill-in panel, and the dashboard take the pill). Same
 * pill-and-dot recipe as shared StatusBadge, routed through the status-*
 * tokens — no hardcoded status colors (reference §5 + cross-cutting rule).
 */
export function LivenessBadge({
  status,
  className,
  testId,
}: {
  status: AgentLivenessStatus;
  className?: string;
  testId?: string;
}) {
  const tone = STATUS_TONE_CLASSES[BADGE_TONE[status]];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-semibold leading-3",
        tone.pill,
        className,
      )}
      data-liveness={status}
      data-testid={testId}
    >
      <span
        aria-hidden="true"
        className={cn("h-1.5 w-1.5 rounded-full", tone.dot)}
      />
      {BADGE_LABEL[status]}
    </span>
  );
}
