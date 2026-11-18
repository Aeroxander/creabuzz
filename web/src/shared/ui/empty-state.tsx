import type { ReactNode } from "react";

import { cn } from "@/shared/lib/cn";

/**
 * Where there is nothing yet: one title, one muted line that says what to do, and at most one action (pass a `Button`,
 * outline unless it is the page's next step). It says what the person can do alone; it is not an apology.
 */
export function EmptyState({
  title,
  line,
  action,
  className,
  testId,
}: {
  title: string;
  line?: string;
  /** The one thing to do next, as a button or a link. */
  action?: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <div
      className={cn("flex flex-col items-start gap-1", className)}
      data-testid={testId}
    >
      <p className="text-base font-medium">{title}</p>
      {line ? <p className="text-sm text-muted-foreground">{line}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
