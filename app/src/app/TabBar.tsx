import { Link, useRouterState } from "@tanstack/react-router";
import { CalendarCheck, House, Plus, UserRound } from "lucide-react";
import type { ComponentType } from "react";
import { cn } from "../ui/cn";

interface Tab {
  to: string;
  label: string;
  icon: ComponentType<{ size?: number; "aria-hidden"?: boolean }>;
  /** Paths that belong to this tab besides its own (a project is reached from Home). */
  owns: (path: string) => boolean;
}

const TABS: readonly Tab[] = [
  {
    to: "/",
    label: "Home",
    icon: House,
    owns: (p) =>
      p === "/" ||
      p.startsWith("/p/") ||
      p.startsWith("/post/") ||
      p.startsWith("/u/") ||
      p.startsWith("/tag/"),
  },
  { to: "/start", label: "Start", icon: Plus, owns: (p) => p === "/start" },
  {
    to: "/week",
    label: "This week",
    icon: CalendarCheck,
    owns: (p) => p === "/week",
  },
  {
    to: "/you",
    label: "You",
    icon: UserRound,
    owns: (p) => p.startsWith("/you"),
  },
];

/** The four tabs at the bottom of every screen: Home (and the projects reached from it), Start, This week, You. */
export function TabBar() {
  const path = useRouterState({ select: (s) => s.location.pathname });
  return (
    <nav
      aria-label="Main"
      className="tabbar fixed inset-x-0 bottom-0 z-30"
      data-testid="tab-bar"
    >
      <ul className="mx-auto grid h-16 max-w-lg grid-cols-4">
        {TABS.map((tab) => {
          const active = tab.owns(path);
          const Icon = tab.icon;
          return (
            <li key={tab.to}>
              <Link
                aria-current={active ? "page" : undefined}
                className={cn(
                  "relative flex h-full flex-col items-center justify-center gap-0.5 text-2xs font-semibold transition-colors",
                  active ? "text-mint-ink" : "text-muted hover:text-ink",
                )}
                data-testid={`tab-link-${tab.label.toLowerCase().replace(" ", "-")}`}
                to={tab.to}
              >
                <Icon aria-hidden size={22} />
                <span>{tab.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
