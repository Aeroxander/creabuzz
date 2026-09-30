/**
 * Small shared controls for the create wizard.
 *
 * Deliberately thin: native `<select>` and `<button>` elements with one label
 * owner each (Review-Proven Rule 7 — an actionable control has exactly one
 * accessible name, and no duplicate screen-reader stops). Everything is
 * rem-token typography so the text follows the reader's font size and zoom;
 * there is a CI guard for that (`pnpm check:px-text`).
 */

import type { ReactNode, SelectHTMLAttributes } from "react";

/** One labelled block. The label owns its control — no wrapping duplicates. */
export function Field({
  id,
  label,
  hint,
  children,
  testId,
}: {
  id: string;
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <div data-testid={testId}>
      <label
        className="text-sm font-medium text-black dark:text-white"
        htmlFor={id}
      >
        {label}
      </label>
      <div className="mt-1">{children}</div>
      {hint ? (
        <p className="mt-1 text-xs text-black/60 dark:text-white/60">{hint}</p>
      ) : null}
    </div>
  );
}

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

/** A native dropdown: keyboard, screen reader and mobile for free. */
export function Select({
  id,
  label,
  hint,
  options,
  testId,
  ...props
}: {
  id: string;
  label: string;
  hint?: ReactNode;
  options: readonly SelectOption[];
  testId?: string;
} & SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <Field id={id} label={label} hint={hint} testId={testId}>
      <select
        {...props}
        className="h-9 w-full rounded-md border border-black/15 bg-transparent px-2 text-sm text-black focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring dark:border-white/15 dark:text-white"
        id={id}
      >
        {options.map((option) => (
          <option
            disabled={option.disabled}
            key={option.value}
            value={option.value}
          >
            {option.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

/**
 * Two or more mutually exclusive choices rendered as toggles.
 *
 * A `role="group"` with a visible name, and `aria-pressed` on each option, so
 * the state of the choice is announced rather than implied by a shade of grey.
 */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  testId,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
  testId?: string;
}) {
  return (
    <fieldset data-testid={testId}>
      <legend className="text-sm font-medium text-black dark:text-white">
        {label}
      </legend>
      <div className="mt-1 flex gap-1 rounded-lg bg-black/5 p-1 dark:bg-white/10">
        {options.map((option) => (
          <button
            aria-pressed={value === option.value}
            className={`flex-1 rounded-md px-2 py-1 text-sm ${
              value === option.value
                ? "bg-white shadow-sm dark:bg-black"
                : "text-black/60 dark:text-white/60"
            }`}
            key={option.value}
            onClick={() => onChange(option.value)}
            type="button"
          >
            {option.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

export interface StepperStep {
  key: string;
  label: string;
}

/**
 * Where the founder is in the four steps. Static text, not links: navigating
 * is what "Continue" does, so the progress list can never disagree with the
 * validation that gates it.
 */
export function Stepper({
  steps,
  current,
  currentTitle,
}: {
  steps: readonly StepperStep[];
  current: string;
  currentTitle: string;
}) {
  const index = steps.findIndex((step) => step.key === current);
  return (
    <nav aria-label="Create launch steps" data-testid="wizard-stepper">
      <ol className="flex flex-wrap items-center gap-1.5">
        {steps.map((step, position) => {
          const done = position < index;
          const isCurrent = position === index;
          return (
            <li className="flex items-center gap-1.5" key={step.key}>
              <span
                aria-current={isCurrent ? "step" : undefined}
                className={`text-xs ${
                  isCurrent
                    ? "font-semibold text-black dark:text-white"
                    : done
                      ? "text-black/70 dark:text-white/70"
                      : "text-black/40 dark:text-white/40"
                }`}
                data-testid={`wizard-step-${step.key}`}
              >
                {position + 1}. {step.label}
              </span>
              {position < steps.length - 1 ? (
                <span
                  aria-hidden
                  className="text-xs text-black/30 dark:text-white/30"
                >
                  ›
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
      <p className="mt-1 text-base font-semibold text-black dark:text-white">
        {currentTitle}
      </p>
    </nav>
  );
}
