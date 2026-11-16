/**
 * The row of tabs under a project's header. On a narrow screen the row scrolls: the chosen tab is kept in view, and a
 * fade with an arrow says more tabs are off to a side. The tabs themselves stay buttons, reachable by keyboard and
 * screen reader whatever is scrolled. One tab is no choice: the row shows once there is a second one.
 */

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { cn } from "@/shared/lib/cn";

import type { LaunchTab } from "../lib/launch-tabs";

export function LaunchTabRow({
  tabs,
  shown,
  label,
  onPick,
}: {
  tabs: ReadonlyArray<{ id: LaunchTab; label: string }>;
  shown: LaunchTab;
  label: string;
  onPick: (tab: LaunchTab) => void;
}) {
  const row = useRef<HTMLDivElement | null>(null);
  const [overflow, setOverflow] = useState({ left: false, right: false });
  const measure = useCallback(() => {
    const el = row.current;
    if (!el) return;
    const left = el.scrollLeft > 2;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
    setOverflow((was) =>
      was.left === left && was.right === right ? was : { left, right },
    );
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run when the tab changes or the row first appears
  useEffect(() => {
    const el = row.current;
    const chosen = el?.querySelector<HTMLElement>('[aria-selected="true"]');
    // Sideways only: scrolling the page to the tab row would move someone who is reading further down.
    if (el && chosen) {
      const start = chosen.offsetLeft;
      const end = start + chosen.offsetWidth;
      if (start < el.scrollLeft) el.scrollLeft = Math.max(0, start - 16);
      else if (end > el.scrollLeft + el.clientWidth)
        el.scrollLeft = end - el.clientWidth + 16;
    }
    measure();
  }, [shown, tabs.length, measure]);
  useEffect(() => {
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure]);

  return (
    <div className={cn("relative", tabs.length < 2 && "hidden")}>
      <div
        aria-label={label}
        className="flex gap-x-5 overflow-x-auto border-b border-border [scrollbar-width:none]"
        onScroll={measure}
        ref={row}
        role="tablist"
      >
        {tabs.map((t) => (
          <button
            aria-selected={shown === t.id}
            className={cn(
              "-mb-px shrink-0 whitespace-nowrap border-b-[3px] px-1 pb-2 text-sm font-semibold transition-colors",
              shown === t.id
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
            key={t.id}
            onClick={() => onPick(t.id)}
            role="tab"
            type="button"
          >
            {t.label}
          </button>
        ))}
      </div>
      {/* Decorative: the tabs themselves stay reachable by keyboard and screen reader whatever is scrolled. */}
      {overflow.left ? (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 flex w-8 items-center bg-gradient-to-r from-background to-transparent"
          data-testid="tabs-more-left"
        >
          <ChevronLeft className="h-4 w-4 text-muted-foreground" />
        </span>
      ) : null}
      {overflow.right ? (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 right-0 flex w-8 items-center justify-end bg-gradient-to-l from-background to-transparent"
          data-testid="tabs-more-right"
        >
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        </span>
      ) : null}
    </div>
  );
}
