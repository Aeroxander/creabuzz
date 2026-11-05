import { Info } from "lucide-react";
import { type ReactNode, useId, useState } from "react";

const STEPS = [
  "Do open work and submit it",
  "Reviewers check it; others can object",
  "Agreed work pays fixed Shares; other work is voted on",
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
        says what done looks like. Its reviewers check what you submit, and for
        a few days after they approve it anyone can object. When a reward was
        agreed before you started, that exact number of Shares is already set
        aside, and you receive it once the wait is over. Work nobody agreed a
        reward for goes to the project&apos;s holders, who vote on whether to
        award Shares. Approval alone gives you none. Shares are your votes in
        what the project does next.
      </p>
    </div>
  );
}
