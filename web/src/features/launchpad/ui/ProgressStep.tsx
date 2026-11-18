import { Check } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/shared/lib/cn";

/** One row of a founder checklist: a tick, a title, and what to do about it. */
export function ProgressStep({
  done,
  title,
  children,
}: {
  done: boolean;
  title: string;
  children?: ReactNode;
}) {
  return (
    <li className="flex items-start gap-3 py-2.5">
      <span
        aria-hidden
        className={cn(
          "mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border text-primary-ink",
          done ? "border-primary bg-primary/20" : "border-border",
        )}
      >
        {done ? <Check className="h-3 w-3" /> : null}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">{title}</p>
        {children}
      </div>
    </li>
  );
}
