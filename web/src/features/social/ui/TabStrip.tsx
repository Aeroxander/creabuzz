import { useId, useRef, type KeyboardEvent } from "react";

import { cn } from "@/shared/lib/cn";

import { tabKeyTarget } from "./tab-strip-keys";

/** The ids that tie a tab to the panel it shows; the page renders the panel with {@link tabPanelProps}. */
function tabIds(idBase: string, tabId: string) {
  return { tab: `${idBase}-tab-${tabId}`, panel: `${idBase}-panel` };
}

/** Props for the element that shows the selected tab's content, so it is announced as that tab's panel. */
export function tabPanelProps(idBase: string, selected: string) {
  const ids = tabIds(idBase, selected);
  return {
    "aria-labelledby": ids.tab,
    id: ids.panel,
    role: "tabpanel" as const,
    tabIndex: 0,
  };
}

/**
 * Underlined tabs along the top of a timeline, as a tab row: one tab stop (the selected tab), Left/Right move between
 * tabs and select them, Home/End go to the ends. A page that passes `idBase` and renders its content with
 * {@link tabPanelProps} gets the tabs tied to that panel; without it the tabs carry no reference to a panel that
 * would not exist.
 */
export function TabStrip<T extends string>({
  tabs,
  value,
  onChange,
  label,
  idBase,
}: {
  /** `testId` keeps a renamed tab's old test id. */
  tabs: readonly { id: T; label: string; testId?: string }[];
  value: T;
  onChange: (tab: T) => void;
  label: string;
  /** Shared with {@link tabPanelProps} on the page's panel. */
  idBase?: string;
}) {
  const ownId = useId();
  const base = idBase ?? ownId;
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  // A value that names no tab still leaves one tab reachable by Tab.
  const selectedIndex = Math.max(
    0,
    tabs.findIndex((tab) => tab.id === value),
  );

  const onKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    const target = tabKeyTarget(event.key, index, tabs.length);
    if (target === null) return;
    event.preventDefault();
    buttons.current[target]?.focus();
    onChange(tabs[target].id);
  };

  return (
    <div aria-label={label} className="flex" role="tablist">
      {tabs.map((tab, index) => {
        const ids = tabIds(base, tab.id);
        const selected = value === tab.id;
        return (
          <button
            aria-controls={idBase && selected ? ids.panel : undefined}
            aria-selected={selected}
            className="relative flex h-12 flex-1 items-center justify-center text-sm transition-colors hover:bg-black/5 dark:hover:bg-white/10"
            data-testid={tab.testId ?? `social-tab-${tab.id}`}
            id={ids.tab}
            key={tab.id}
            onClick={() => onChange(tab.id)}
            onKeyDown={(event) => onKeyDown(event, index)}
            ref={(element) => {
              buttons.current[index] = element;
            }}
            role="tab"
            tabIndex={index === selectedIndex ? 0 : -1}
            type="button"
          >
            <span
              className={cn(
                "relative flex h-full items-center",
                selected
                  ? "font-bold text-black dark:text-white"
                  : "font-medium text-black/60 dark:text-white/60",
              )}
            >
              {tab.label}
              {selected ? (
                <span className="absolute inset-x-0 bottom-0 h-1 rounded-full bg-primary" />
              ) : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}
