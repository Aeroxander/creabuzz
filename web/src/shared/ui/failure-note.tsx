import type { FailureWords } from "@/shared/lib/readable-error";
import { cn } from "@/shared/lib/cn";

/**
 * A failed action, said in plain words, with the raw words behind it under a collapsed "Technical details" for whoever
 * helps (the same disclosure `QueryError` uses for a failed read). Build `failure` with `failureWords`.
 */
export function FailureNote({
  failure,
  testId,
  className,
}: {
  failure: FailureWords;
  /** The plain words' test id; the disclosure is `${testId}-details`. */
  testId?: string;
  className?: string;
}) {
  return (
    <div
      className={cn("text-sm text-red-700 dark:text-red-300", className)}
      role="alert"
    >
      <p data-testid={testId}>{failure.text}</p>
      {failure.detail ? (
        <details
          className="mt-1 text-xs text-black/60 dark:text-white/60"
          data-testid={testId ? `${testId}-details` : undefined}
        >
          <summary className="cursor-pointer select-none font-medium">
            Technical details
          </summary>
          <p className="mt-1 break-words">{failure.detail}</p>
        </details>
      ) : null}
    </div>
  );
}
