import type { ComponentProps } from "react";
import { cn } from "./cn";

/**
 * A pane on the gradient. `glass` is the frosted pane for short things (a project, a stat, a form); `plain` is the
 * calmer, darker surface for reading (a post, a thread, a message).
 */
export function Card({
  tone = "glass",
  className,
  ...rest
}: ComponentProps<"div"> & { tone?: "glass" | "plain" }) {
  return (
    <div
      {...rest}
      className={cn(
        tone === "glass" ? "glass" : "plain",
        "rounded-2xl p-4",
        className,
      )}
    />
  );
}
