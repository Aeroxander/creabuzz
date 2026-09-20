import type * as React from "react";

import { cn } from "@/shared/lib/cn";
import { Card } from "./card";

export type MetricCardProps = {
  /** Headline number (pass preformatted text for machine values). */
  value: React.ReactNode;
  /** Uppercase eyebrow label. */
  label: string;
  /** One line that decomposes or contextualizes the number. */
  description?: React.ReactNode;
  /**
   * Paperclip contract: a metric card links to its owning page. When set the
   * whole card acts as one button (scroll/focus — never a fake navigation).
   */
  onClick?: () => void;
  /** Slot under the value: UtilizationBar, StatusBadge, etc. */
  children?: React.ReactNode;
  className?: string;
  testId?: string;
};

/**
 * Metric card (reference §2.1/§2.5): big tabular-nums value, uppercase micro
 * label, optional decomposition line, optional action slot. The value is
 * never invented without a decomposition path (`description`/`children`).
 */
export function MetricCard({
  value,
  label,
  description,
  onClick,
  children,
  className,
  testId,
}: MetricCardProps) {
  const body = (
    <>
      <p className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="mt-0.5 text-2xl font-semibold tabular-nums tracking-tight">
        {value}
      </p>
      {description && (
        <p className="mt-0.5 text-2xs text-muted-foreground">{description}</p>
      )}
      {children}
    </>
  );

  if (onClick) {
    return (
      <Card className={cn("p-3", className)} data-testid={testId}>
        <button
          className="-m-1 w-[calc(100%+0.5rem)] rounded-lg p-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={onClick}
          type="button"
        >
          {body}
        </button>
      </Card>
    );
  }

  return (
    <Card className={cn("p-3", className)} data-testid={testId}>
      {body}
    </Card>
  );
}
