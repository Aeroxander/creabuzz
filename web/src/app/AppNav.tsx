import { Link, useRouterState } from "@tanstack/react-router";
import {
  Compass,
  Home,
  LayoutGrid,
  type LucideIcon,
  MessagesSquare,
  Rocket,
} from "lucide-react";

import buzzAppIcon from "@/assets/app-icon@3x.png";
import { ProfileMenu } from "@/features/identity/ui/ProfileMenu";
import { APP_NAME } from "@/shared/constants/brand";
import { useMediaQuery } from "@/shared/hooks/use-media-query";

interface NavItem {
  to: "/" | "/c" | "/discover" | "/launchpad" | "/projects";
  label: string;
  icon: LucideIcon;
  /** Whether a pathname belongs to this section. */
  matches: (pathname: string) => boolean;
}

const NAV_ITEMS: readonly NavItem[] = [
  {
    to: "/",
    label: "Home",
    icon: Home,
    matches: (p) => p === "/" || p.startsWith("/u/"),
  },
  {
    to: "/c",
    label: "Communities",
    icon: MessagesSquare,
    matches: (p) => p === "/c" || p.startsWith("/c/") || p.startsWith("/repos"),
  },
  {
    to: "/discover",
    label: "Discover",
    icon: Compass,
    matches: (p) => p.startsWith("/discover"),
  },
  {
    to: "/launchpad",
    label: "Launches",
    icon: Rocket,
    matches: (p) => p.startsWith("/launchpad"),
  },
  {
    to: "/projects",
    label: "Projects",
    icon: LayoutGrid,
    matches: (p) => p.startsWith("/projects"),
  },
];

/** Pages people land on from outside the app, shown without app chrome. */
export function hidesAppNav(pathname: string): boolean {
  return pathname.startsWith("/invite/");
}

/**
 * The app's one navigation: a left rail on wide screens, a bottom tab bar on
 * phones. Exactly one is mounted (not both hidden by CSS), so there is one
 * profile menu, one set of landmarks and one tab stop per destination.
 */
export function AppNav() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const wide = useMediaQuery("(min-width: 768px)");

  if (wide) {
    return (
      <nav
        aria-label="Main"
        className="flex w-[4.5rem] shrink-0 flex-col items-center gap-1 border-r border-black/10 bg-[#F8F8F8] py-3 dark:border-white/10 dark:bg-[#1B1B1B]"
        data-testid="app-nav"
      >
        <Link
          aria-label={`${APP_NAME} home`}
          className="mb-2 h-9 w-9 overflow-hidden rounded-lg"
          to="/"
        >
          <img alt="" className="h-full w-full" src={buzzAppIcon} />
        </Link>
        {NAV_ITEMS.map((item) => (
          <NavLink active={item.matches(pathname)} item={item} key={item.to} />
        ))}
        <div className="mt-auto">
          <ProfileMenu placement="rail" />
        </div>
      </nav>
    );
  }

  return (
    <nav
      aria-label="Main"
      className="flex h-14 w-full shrink-0 items-stretch justify-around border-t border-black/10 bg-[#F8F8F8] px-1 dark:border-white/10 dark:bg-[#1B1B1B]"
      data-testid="app-nav"
    >
      {NAV_ITEMS.map((item) => (
        <NavLink active={item.matches(pathname)} item={item} key={item.to} />
      ))}
      <div className="flex items-center">
        <ProfileMenu placement="tabbar" />
      </div>
    </nav>
  );
}

function NavLink({ item, active }: { item: NavItem; active: boolean }) {
  const Icon = item.icon;
  return (
    <Link
      aria-current={active ? "page" : undefined}
      className={`flex min-w-14 flex-col items-center justify-center gap-0.5 rounded-lg px-1.5 py-1.5 text-2xs font-medium transition-colors ${
        active
          ? "bg-black/10 text-black dark:bg-white/15 dark:text-white"
          : "text-black/60 hover:bg-black/5 hover:text-black dark:text-white/60 dark:hover:bg-white/10 dark:hover:text-white"
      }`}
      data-testid={`app-nav-${item.label.toLowerCase()}`}
      to={item.to}
    >
      <Icon aria-hidden className="h-5 w-5" />
      {item.label}
    </Link>
  );
}
