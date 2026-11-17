import * as RadixTabs from "@radix-ui/react-tabs";
import type { ReactNode } from "react";
import { cn } from "./cn";

export interface TabItem {
  value: string;
  label: string;
  /** Marks a tab whose content is not built yet, so it is never mistaken for an empty list. */
  soon?: boolean;
  content: ReactNode;
}

/** Tabs on a glass rail. Arrow keys move between them (Radix); the selected one is white with a green line. */
export function Tabs({
  items,
  value,
  onValueChange,
  label,
  className,
}: {
  items: readonly TabItem[];
  value: string;
  onValueChange: (value: string) => void;
  /** What the set of tabs is, for a screen reader. */
  label: string;
  className?: string;
}) {
  return (
    <RadixTabs.Root
      className={cn("flex flex-col gap-4", className)}
      onValueChange={onValueChange}
      value={value}
    >
      <RadixTabs.List
        aria-label={label}
        className="glass flex gap-1 overflow-x-auto rounded-xl p-1"
      >
        {items.map((item) => (
          <RadixTabs.Trigger
            className="relative min-h-10 flex-1 whitespace-nowrap rounded-lg px-3 text-sm font-semibold text-muted transition-colors data-[state=active]:bg-white/18 data-[state=active]:text-ink focus-visible:outline-2 focus-visible:outline-mint-ink"
            data-testid={`tab-${item.value}`}
            key={item.value}
            value={item.value}
          >
            {item.label}
            {item.soon ? (
              <span className="ml-1.5 align-middle text-2xs font-medium text-muted">
                soon
              </span>
            ) : null}
          </RadixTabs.Trigger>
        ))}
      </RadixTabs.List>
      {items.map((item) => (
        <RadixTabs.Content
          className="outline-none"
          key={item.value}
          value={item.value}
        >
          {item.content}
        </RadixTabs.Content>
      ))}
    </RadixTabs.Root>
  );
}
