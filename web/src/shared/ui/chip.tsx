import type { LucideIcon } from "lucide-react";
import type * as React from "react";

import { cn } from "@/shared/lib/cn";

const tones = {
  neutral: "bg-muted text-muted-foreground",
  success: "bg-emerald-500/15 text-emerald-800 dark:text-emerald-300",
  warning: "bg-amber-500/15 text-amber-800 dark:text-amber-300",
  info: "bg-blue-500/15 text-blue-800 dark:text-blue-300",
  danger: "bg-red-500/15 text-red-800 dark:text-red-300",
} as const;

export type ChipTone = keyof typeof tones;

/**
 * A short fact in a pill: a rule, a status, an amount or a date. One line, sentence case, no full stop. Use it where a
 * sentence would say one thing; a sentence that needs a reason stays a sentence.
 */
export function Chip({
  icon: Icon,
  tone = "neutral",
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & {
  icon?: LucideIcon;
  tone?: ChipTone;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium",
        tones[tone],
        className,
      )}
      {...props}
    >
      {Icon ? <Icon aria-hidden className="h-3.5 w-3.5 shrink-0" /> : null}
      {children}
    </span>
  );
}
