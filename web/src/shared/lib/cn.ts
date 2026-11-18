import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * tailwind-merge decides conflicts from its own tables, and `text-message` /
 * `text-message-timestamp` are *sizes* here while looking like colours to it: a
 * plain `twMerge("text-message", "text-muted-foreground")` dropped the size
 * silently, so conversation text did not apply whenever a colour followed. Both
 * tokens are registered in the font-size group, as the desktop client does.
 */
const mergeClassNames = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [
        {
          text: ["message", "message-timestamp"],
        },
      ],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return mergeClassNames(clsx(inputs));
}
