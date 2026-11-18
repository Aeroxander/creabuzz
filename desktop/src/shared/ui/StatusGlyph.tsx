import { cn } from "@/shared/lib/cn";

import { STATUS_TONE_CLASSES, type StatusTone } from "./statusTone";

/**
 * Status dot/glyph for the semantic status tier. Decorative color alone never
 * carries meaning: the element is `role="img"` with a required accessible
 * name, so screen readers announce the state the color encodes.
 */
export function StatusGlyph({
  "aria-label": ariaLabel,
  className,
  tone,
}: {
  /** Accessible name for the state this glyph encodes (e.g. "Pending"). */
  "aria-label": string;
  className?: string;
  tone: StatusTone;
}) {
  return (
    <span
      aria-label={ariaLabel}
      className={cn(
        "inline-block h-2 w-2 shrink-0 rounded-full",
        STATUS_TONE_CLASSES[tone].dot,
        className,
      )}
      data-status-tone={tone}
      role="img"
    />
  );
}
