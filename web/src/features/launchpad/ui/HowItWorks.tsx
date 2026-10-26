import { Info } from "lucide-react";
import { type ReactNode, useId, useState } from "react";

const STEPS = [
  "Pick open work",
  "Reviewers check it",
  "Earn Shares, a say in the project",
] as const;

/**
 * How a contributor project works, as three steps instead of a paragraph. The one paragraph that explains it is behind
 * "How it works", for whoever wants it; actions for the place it is shown go on the right.
 */
export function HowItWorks({ children }: { children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div data-testid="how-it-works">
      <ol className="grid gap-2 sm:grid-cols-3">
        {STEPS.map((step, i) => (
          <li
            className="flex items-center gap-2 text-sm font-medium"
            key={step}
          >
            <span
              aria-hidden
              className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-primary/15 text-xs font-bold text-primary-ink"
            >
              {i + 1}
            </span>
            {step}
          </li>
        ))}
      </ol>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <button
          aria-controls={id}
          aria-expanded={open}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:underline"
          data-testid="how-it-works-toggle"
          onClick={() => setOpen((was) => !was)}
          type="button"
        >
          <Info aria-hidden className="h-3.5 w-3.5" />
          How it works
        </button>
        {children ? (
          <span className="flex flex-wrap gap-2">{children}</span>
        ) : null}
      </div>
      <p
        className="mt-2 max-w-2xl text-sm text-muted-foreground"
        hidden={!open}
        id={id}
      >
        Anyone can do open work: you need no Shares to start. Each work area
        says what done looks like. When its reviewers approve your work, the
        project's holders vote to award you Shares, and Shares are your votes in
        what the project does next.
      </p>
    </div>
  );
}
