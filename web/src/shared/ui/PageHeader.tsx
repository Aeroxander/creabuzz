import type { ReactNode } from "react";

import { cn } from "@/shared/lib/cn";

type HeaderProps = {
  /** Optional trailing content (buttons, menus) aligned to the header's end. */
  action?: ReactNode;
  className?: string;
  /** Muted supporting line rendered beneath the title. */
  description?: ReactNode;
  title: ReactNode;
};

/**
 * Level 1 of the shared header ramp: one per page (a Settings card, the Agents
 * page). Renders the page's single `h1`. Pair with {@link SectionHeader} for
 * peer sections within the page and {@link SubsectionLabel} for the smallest
 * grouping labels.
 */
export function PageHeader({
  action,
  className,
  description,
  title,
}: HeaderProps) {
  const copy = (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      {description ? (
        <p className="text-base font-normal text-muted-foreground">
          {description}
        </p>
      ) : null}
    </>
  );

  if (action) {
    return (
      <div
        className={cn(
          "flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-2",
          className,
        )}
      >
        <div className="min-w-0 flex-1 basis-56 space-y-1">{copy}</div>
        {/* Capped to the row so a wide set of buttons wraps inside it instead of running off a phone's edge. */}
        <div className="max-w-full shrink-0">{action}</div>
      </div>
    );
  }

  return <div className={cn("min-w-0 space-y-1", className)}>{copy}</div>;
}

/**
 * Level 2 of the shared header ramp: a peer section within a page (Agent
 * defaults, Teams, Profile info). Renders an `h2` one step down from
 * {@link PageHeader}.
 */
export function SectionHeader({
  action,
  className,
  description,
  title,
}: HeaderProps) {
  const copy = (
    <>
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      {description ? (
        <p className="text-sm font-normal text-muted-foreground">
          {description}
        </p>
      ) : null}
    </>
  );

  if (action) {
    return (
      <div
        className={cn(
          "flex min-w-0 flex-wrap items-start justify-between gap-x-3 gap-y-2",
          className,
        )}
      >
        <div className="min-w-0 flex-1 basis-56 space-y-0.5">{copy}</div>
        <div className="shrink-0">{action}</div>
      </div>
    );
  }

  return <div className={cn("min-w-0 space-y-0.5", className)}>{copy}</div>;
}
