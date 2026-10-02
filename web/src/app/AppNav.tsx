import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  Briefcase,
  Compass,
  Home,
  LayoutGrid,
  Feather,
  type LucideIcon,
  MessagesSquare,
  Rocket,
  Search,
} from "lucide-react";

import { useState } from "react";

import { ProfileMenu } from "@/features/identity/ui/ProfileMenu";
import { APP_NAME } from "@/shared/constants/brand";
import { useMediaQuery } from "@/shared/hooks/use-media-query";
import { CreatonMark } from "@/shared/ui/CreatonMark";

interface NavItem {
  to:
    | "/"
    | "/social"
    | "/c"
    | "/discover"
    | "/launchpad"
    | "/projects"
    | "/portfolio";
  label: string;
  icon: LucideIcon;
  /** Whether a pathname belongs to this section. */
  matches: (pathname: string) => boolean;
  /**
   * Top bar only. The phone tab bar keeps to five tabs so its labels stay
   * readable at 360px; phones reach these from a page instead.
   */
  wideOnly?: boolean;
}

const NAV_ITEMS: readonly NavItem[] = [
  {
    to: "/",
    label: "Home",
    icon: Home,
    matches: (p) => p === "/",
  },
  {
    to: "/social",
    label: "Social",
    icon: Feather,
    // Profiles (`/u/…`) are part of the social section.
    matches: (p) => p.startsWith("/social") || p.startsWith("/u/"),
    // On phones: the link beside Home's title (the tab bar keeps five tabs).
    wideOnly: true,
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
  {
    to: "/portfolio",
    label: "Portfolio",
    icon: Briefcase,
    matches: (p) => p.startsWith("/portfolio"),
    // On phones: the link beside Home's title.
    wideOnly: true,
  },
];

/** Pages people land on from outside the app, shown without app chrome. */
export function hidesAppNav(pathname: string): boolean {
  return pathname.startsWith("/invite/");
}

/**
 * The app's one navigation: a top bar on wide screens (logo, search, sections,
 * account), a bottom tab bar on phones. Exactly one is mounted (not both
 * hidden by CSS), so there is one profile menu, one set of landmarks and one
 * tab stop per destination.
 */
export function AppNav() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const wide = useMediaQuery("(min-width: 768px)");

  if (wide) {
    return (
      <nav
        aria-label="Main"
        className="flex h-16 w-full shrink-0 items-center gap-3 border-b border-border/60 bg-background/70 px-4 backdrop-blur-md lg:gap-6 lg:px-8"
        data-testid="app-nav"
      >
        <Link
          aria-label={`${APP_NAME} home`}
          className="flex shrink-0 items-center gap-2 rounded-lg"
          to="/"
        >
          <CreatonMark className="h-9 w-9" />
          <span className="hidden text-lg font-extrabold tracking-tight lg:inline">
            {APP_NAME.toLowerCase()}
          </span>
        </Link>
        <HeaderSearch />
        <div className="ml-auto flex items-center gap-0.5">
          {NAV_ITEMS.map((item) => (
            <NavLink
              active={item.matches(pathname)}
              item={item}
              key={item.to}
              variant="top"
            />
          ))}
        </div>
        <ProfileMenu placement="header" />
      </nav>
    );
  }

  return (
    <nav
      aria-label="Main"
      className="flex h-14 w-full shrink-0 items-stretch justify-around border-t border-border/60 bg-sidebar px-1"
      data-testid="app-nav"
    >
      {NAV_ITEMS.filter((item) => !item.wideOnly).map((item) => (
        <NavLink
          active={item.matches(pathname)}
          item={item}
          key={item.to}
          variant="tab"
        />
      ))}
      <div className="flex items-center">
        <ProfileMenu placement="tabbar" />
      </div>
    </nav>
  );
}

/** One search box for the whole app; it opens the people-and-posts search. */
function HeaderSearch() {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  return (
    <search className="hidden min-w-0 flex-1 md:block lg:max-w-xl">
      <form
        className="relative"
        onSubmit={(event) => {
          event.preventDefault();
          const q = query.trim();
          if (!q) return;
          void navigate({ to: "/social/search", search: { q } });
        }}
      >
        <Search
          aria-hidden
          className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
        />
        <input
          aria-label="Search people and posts"
          className="h-10 w-full rounded-lg border border-transparent bg-foreground/[0.07] pl-4 pr-10 text-sm placeholder:text-muted-foreground focus:border-ring focus:outline-none"
          data-testid="app-search"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search"
          type="search"
          value={query}
        />
      </form>
    </search>
  );
}

function NavLink({
  item,
  active,
  variant,
}: {
  item: NavItem;
  active: boolean;
  variant: "top" | "tab";
}) {
  const Icon = item.icon;
  if (variant === "top") {
    return (
      <Link
        aria-current={active ? "page" : undefined}
        className={`relative rounded-lg px-2.5 py-2 text-sm font-semibold transition-colors lg:px-3 ${
          active
            ? "text-foreground after:absolute after:inset-x-2.5 after:-bottom-[13px] after:h-[3px] after:rounded-full after:bg-primary"
            : "text-foreground/65 hover:bg-foreground/[0.06] hover:text-foreground"
        }`}
        data-testid={`app-nav-${item.label.toLowerCase()}`}
        to={item.to}
      >
        {item.label}
      </Link>
    );
  }
  return (
    <Link
      aria-current={active ? "page" : undefined}
      className={`flex min-w-14 flex-col items-center justify-center gap-0.5 rounded-lg px-1.5 py-1.5 text-2xs font-semibold transition-colors ${
        active
          ? "bg-primary/15 text-primary-ink"
          : "text-foreground/60 hover:bg-foreground/[0.06] hover:text-foreground"
      }`}
      data-testid={`app-nav-${item.label.toLowerCase()}`}
      to={item.to}
    >
      <Icon aria-hidden className="h-5 w-5" />
      {item.label}
    </Link>
  );
}
