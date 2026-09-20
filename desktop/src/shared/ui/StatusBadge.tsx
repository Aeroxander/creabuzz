import { cn } from "@/shared/lib/cn";

import { statusBadgeClasses, type StatusBadgeVariant } from "./statusTone";

/**
 * Status pill for the semantic status tier: glyph + capitalized label, one
 * variant per state, identical everywhere a status is named (badge, row,
 * card). Rem-based text only — follows the virtual typography ramp and Cmd +/-
 * zoom (AGENTS.md text-sizing rule).
 */
export function StatusBadge({
  className,
  variant,
  testId,
}: {
  className?: string;
  testId?: string;
  variant: StatusBadgeVariant;
}) {
  const { dot, label, pill } = statusBadgeClasses(variant);
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-semibold leading-3",
        pill,
        className,
      )}
      data-status-variant={variant}
      data-testid={testId}
    >
      <span
        aria-hidden="true"
        className={cn("h-1.5 w-1.5 rounded-full", dot)}
      />
      {label}
    </span>
  );
}
