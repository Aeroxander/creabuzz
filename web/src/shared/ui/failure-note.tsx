import type { FailureWords } from "@/shared/lib/readable-error";
import { cn } from "@/shared/lib/cn";
import { TechnicalDetails } from "@/shared/ui/technical-details";

type FailureNoteProps =
  | {
      /** A failed action from `failureWords`: its plain words, with the raw words under Technical details. */
      failure: FailureWords;
      message?: never;
      /** The plain words' test id; the disclosure is `${testId}-details`. */
      testId?: string;
      className?: string;
    }
  | {
      /**
       * A panel's failure already said in plain words (a money panel's send failure, `actingErrorMessage`), shown as
       * a boxed alert below the panel's buttons.
       */
      message: string;
      failure?: never;
      testId: string;
      className?: string;
    };

/**
 * The app's one note for a failed action (an alert: the person needs to act on it).
 *
 * With `failure` (built with `failureWords`), the plain words show and the raw words behind them sit under a collapsed
 * "Technical details" for whoever helps (the same disclosure `QueryError` uses for a failed read). With `message`, a
 * panel's own plain sentence shows in a box.
 */
export function FailureNote(props: FailureNoteProps) {
  const { testId, className } = props;
  if (props.message !== undefined) {
    return (
      <p
        className={cn(
          "mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-800 [overflow-wrap:anywhere] dark:bg-red-950 dark:text-red-200",
          className,
        )}
        data-testid={testId}
        role="alert"
      >
        {props.message}
      </p>
    );
  }
  return (
    <div
      className={cn("text-sm text-red-700 dark:text-red-300", className)}
      role="alert"
    >
      <p data-testid={testId}>{props.failure.text}</p>
      <TechnicalDetails
        className="mt-1"
        detail={props.failure.detail}
        testId={testId ? `${testId}-details` : undefined}
      />
    </div>
  );
}
