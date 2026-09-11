import { AlertTriangle, RefreshCw } from "lucide-react";

/**
 * A failed query must read as a failure, not as an empty result.
 *
 * Every surface used to fall through to its own empty state when a relay query
 * failed — "no work items", "no agents", "no launches" — which is
 * indistinguishable from a genuinely empty workspace and offers no recovery.
 */
export function QueryError({
  title,
  description,
  message,
  onRetry,
  testId = "query-error",
}: {
  title: string;
  description: string;
  message?: string;
  onRetry?: () => void;
  testId?: string;
}) {
  return (
    <div
      className="flex flex-col items-center justify-center gap-2 px-4 py-10 text-center"
      data-testid={testId}
      role="alert"
    >
      <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-400" />
      <p className="text-sm font-medium text-black dark:text-white">{title}</p>
      <p className="max-w-md text-sm text-black/60 dark:text-white/60">
        {description}
      </p>
      {message ? (
        <p className="max-w-md break-words text-xs text-black/45 dark:text-white/45">
          {message}
        </p>
      ) : null}
      {onRetry ? (
        <button
          className="mt-1 inline-flex items-center gap-1.5 rounded-md border border-black/15 px-3 py-1.5 text-sm font-medium dark:border-white/15"
          data-testid={`${testId}-retry`}
          onClick={onRetry}
          type="button"
        >
          <RefreshCw className="h-3.5 w-3.5" /> Try again
        </button>
      ) : null}
    </div>
  );
}

/** Message text for an unknown thrown value. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error ?? "unknown error");
}
