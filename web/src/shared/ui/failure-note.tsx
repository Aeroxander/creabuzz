import type { FailureWords } from "@/shared/lib/readable-error";
import { cn } from "@/shared/lib/cn";
import { TechnicalDetails } from "@/shared/ui/technical-details";

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
      <TechnicalDetails
        className="mt-1"
        detail={failure.detail}
        testId={testId ? `${testId}-details` : undefined}
      />
    </div>
  );
}
