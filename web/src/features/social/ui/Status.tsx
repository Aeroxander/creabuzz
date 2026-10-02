import type { ReactNode } from "react";

/** An empty timeline or page: what is missing and what to do about it. */
export function EmptyState({
  title,
  children,
  testId,
}: {
  title: string;
  children?: ReactNode;
  testId?: string;
}) {
  return (
    <div
      className="mx-auto max-w-sm px-6 py-14 text-center"
      data-testid={testId}
    >
      <h2 className="text-xl font-bold text-black dark:text-white">{title}</h2>
      {children ? (
        <p className="mt-2 text-sm text-black/60 dark:text-white/60">
          {children}
        </p>
      ) : null}
    </div>
  );
}

function SkeletonRow() {
  return (
    <div className="flex gap-3 border-b border-black/10 px-4 py-3 dark:border-white/10">
      <div className="h-10 w-10 shrink-0 animate-pulse rounded-full bg-black/10 dark:bg-white/10" />
      <div className="flex-1 space-y-2 pt-1">
        <div className="h-3 w-40 animate-pulse rounded bg-black/10 dark:bg-white/10" />
        <div className="h-3 w-full animate-pulse rounded bg-black/10 dark:bg-white/10" />
        <div className="h-3 w-2/3 animate-pulse rounded bg-black/10 dark:bg-white/10" />
      </div>
    </div>
  );
}

export function TimelineSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading posts" role="status">
      {["a", "b", "c", "d"].map((k) => (
        <SkeletonRow key={k} />
      ))}
    </div>
  );
}
