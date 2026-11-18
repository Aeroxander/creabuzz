/**
 * "More to set up": the chat rooms, the announcement step and the listing choice, put away under the project's tabs
 * for a founder, so the first screen holds the next step and nothing else. Nothing is lost: it is a button with
 * `aria-expanded`, reachable by keyboard, and what it opens is the same cards the page showed above the fold before.
 */

import { ChevronDown } from "lucide-react";
import { type ReactNode, useId, useState } from "react";

import { cn } from "@/shared/lib/cn";

export function MoreToSetUp({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <section aria-label="More to set up" data-testid="more-to-set-up">
      <button
        aria-controls={id}
        aria-expanded={open}
        className="inline-flex min-h-8 items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground max-sm:min-h-11"
        data-testid="more-to-set-up-toggle"
        onClick={() => setOpen((was) => !was)}
        type="button"
      >
        <ChevronDown
          aria-hidden
          className={cn("h-4 w-4 transition-transform", open && "rotate-180")}
        />
        More to set up
      </button>
      {open ? (
        <div className="mt-3 flex flex-col gap-6" id={id}>
          {children}
        </div>
      ) : null}
    </section>
  );
}
