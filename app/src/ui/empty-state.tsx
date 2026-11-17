import type { ReactNode } from "react";
import { cn } from "./cn";

/** What a screen or a list says when there is nothing in it yet, and the one thing to do about it. */
export function EmptyState({
  icon,
  title,
  children,
  action,
  className,
  testId,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <div
      className={cn(
        "glass glass-text flex flex-col items-center gap-3 rounded-2xl px-5 py-8 text-center",
        className,
      )}
      data-testid={testId}
    >
      {icon ? (
        <div aria-hidden="true" className="text-mint-ink">
          {icon}
        </div>
      ) : null}
      <h2 className="headline text-lg">{title}</h2>
      {children ? (
        <div className="max-w-prose text-sm text-muted">{children}</div>
      ) : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}
