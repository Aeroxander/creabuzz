import { type ComponentProps, type ReactNode, useId } from "react";
import { cn } from "./cn";

interface FieldShellProps {
  label: ReactNode;
  /** Shown under the box while there is no problem. */
  hint?: ReactNode;
  /** What is wrong with what was typed; replaces the hint and marks the box. */
  problem?: string | null;
  /** Characters typed of the most allowed, shown in the label's row. */
  count?: { used: number; max: number };
}

function useFieldIds() {
  const id = useId();
  return { input: `${id}-input`, note: `${id}-note` };
}

function Shell({
  ids,
  label,
  hint,
  problem,
  count,
  children,
}: FieldShellProps & {
  ids: ReturnType<typeof useFieldIds>;
  children: ReactNode;
}) {
  const note = problem ?? hint;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <label className="text-sm font-semibold text-ink" htmlFor={ids.input}>
          {label}
        </label>
        {count ? (
          <span
            className={cn(
              "num text-2xs",
              count.used > count.max ? "text-danger" : "text-muted",
            )}
          >
            {count.used}/{count.max}
          </span>
        ) : null}
      </div>
      {children}
      {note ? (
        <p
          className={cn("text-xs", problem ? "text-danger" : "text-muted")}
          id={ids.note}
          role={problem ? "alert" : undefined}
        >
          {note}
        </p>
      ) : null}
    </div>
  );
}

/** A labelled one-line box: a glass pane, 48px tall, 16px text so a phone does not zoom in. */
export function Field({
  label,
  hint,
  problem,
  count,
  className,
  ...input
}: FieldShellProps & ComponentProps<"input">) {
  const ids = useFieldIds();
  return (
    <Shell count={count} hint={hint} ids={ids} label={label} problem={problem}>
      <input
        {...input}
        aria-describedby={problem || hint ? ids.note : undefined}
        aria-invalid={problem ? true : undefined}
        className={cn("field glass", className)}
        id={ids.input}
      />
    </Shell>
  );
}

/** A labelled box for a few lines of text. */
export function TextArea({
  label,
  hint,
  problem,
  count,
  className,
  ...input
}: FieldShellProps & ComponentProps<"textarea">) {
  const ids = useFieldIds();
  return (
    <Shell count={count} hint={hint} ids={ids} label={label} problem={problem}>
      <textarea
        {...input}
        aria-describedby={problem || hint ? ids.note : undefined}
        aria-invalid={problem ? true : undefined}
        className={cn("field glass", className)}
        id={ids.input}
      />
    </Shell>
  );
}
