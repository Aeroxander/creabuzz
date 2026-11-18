import type * as React from "react";

import { cn } from "@/shared/lib/cn";

export type EmptyStateProps = {
  /** Decorative glyph (aria-hidden); the title carries the meaning. */
  icon?: React.ReactNode;
  title: string;
  description?: React.ReactNode;
  /**
   * The ONE first action this empty state names (reference rule: every empty
   * state names the first action). Pass a rendered Button.
   */
  action?: React.ReactNode;
  /** "error" renders the title in the destructive color. */
  variant?: "default" | "error";
  className?: string;
  testId?: string;
};

/**
 * One empty/loading/error placeholder for every surface: icon + title + one
 * action (docs/paperclip-ux-reference.md §4). A state that offers no action
 * still says what is happening and what to check next in `description`.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  variant = "default",
  className,
  testId,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-1.5 p-8 text-center",
        className,
      )}
      data-testid={testId}
    >
      {icon && (
        <div
          aria-hidden="true"
          className="mb-1 flex h-10 w-10 items-center justify-center rounded-full bg-muted text-muted-foreground"
        >
          {icon}
        </div>
      )}
      <p
        className={cn(
          "text-sm font-medium",
          variant === "error" ? "text-destructive" : "text-foreground",
        )}
      >
        {title}
      </p>
      {description && (
        <p className="max-w-sm text-xs text-muted-foreground">{description}</p>
      )}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
