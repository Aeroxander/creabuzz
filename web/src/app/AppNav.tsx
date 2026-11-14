import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  Hammer,
  Home,
  LayoutGrid,
  type LucideIcon,
  PlusCircle,
  Search,
  UserRound,
} from "lucide-react";

import { Suspense, lazy, useState } from "react";

import { ProfileMenu } from "@/features/identity/ui/ProfileMenu";
import { useNotifications } from "@/features/notifications/use-notifications";
import { raisesOffered } from "@/features/launchpad/lib/raises-offered";
import {
  portfolioInNav,
  portfolioLabel,
} from "@/features/portfolio/lib/portfolio-label";
import { existingUserPubkey } from "@/shared/lib/identity";
import { APP_NAME } from "@/shared/constants/brand";
import { useMediaQuery } from "@/shared/hooks/use-media-query";
import { Button } from "@/shared/ui/button";
import { CreatonMark } from "@/shared/ui/CreatonMark";

import { communityBadge } from "./nav-badge";
import { TestnetChip, TestnetStrip } from "./TestnetTag";

// Notifications and Messages in the top bar: their reads load with them, after the page.
const InboxLinks = lazy(() =>
  import("@/features/social/ui/SocialShell").then((m) => ({
    default: m.InboxLinks,
  })),
);

interface NavItem {
  to:
    | "/"
    | "/social"
    | "/c"
    | "/discover"
    | "/launchpad"
    | "/portfolio"
    | "/work"
    | "/start";
  label: string;
  icon: LucideIcon;
  /** Whether a pathname belongs to this section. */
  matches: (pathname: string) => boolean;
  /**
   * Optional secondary destinations can stay out of the four-item phone bar.
   */
  wideOnly?: boolean;
}

/**
 * Four places, and no second way to reach the same thing: Home (what is happening), Projects (who is building what,
 * and how they are keeping their word), Work (what there is to do, and what waits on you) and You (your own projects
 * and record). Messages and notifications are the two icons beside them. Rooms, Explore and the old directories are
 * still at their addresses, reached from where they belong (a project, the bell, the account menu).
 */
const NAV_ITEMS: readonly NavItem[] = [
  {
    to: "/",
    label: "Home",
    icon: Home,
    matches: (p) => p === "/" || p.startsWith("/social") || p.startsWith("/b/"),
  },
  {
    to: "/discover",
    label: "Projects",
    icon: LayoutGrid,
    // A project's page and the older lists of them are all Projects.
    matches: (p) =>
      p.startsWith("/discover") ||
      p.startsWith("/projects") ||
      p.startsWith("/launchpad"),
  },
  {
    to: "/work",
    label: "Work",
    icon: Hammer,
    matches: (p) => p.startsWith("/work"),
  },
  {
    to: "/portfolio",
    label: "You",
    icon: UserRound,
    // Your profile, your rooms and the court (reached from this page) are yours too.
    matches: (p) =>
      p.startsWith("/portfolio") ||
      p.startsWith("/court") ||
      p.startsWith("/u/") ||
      p === "/c" ||
      p.startsWith("/c/") ||
      p.startsWith("/repos"),
  },
];

/** Start, as a tab on phones (wide screens have the Start button in the top bar). */
const START_TAB: NavItem = {
  to: "/start",
  label: "Start",
  icon: PlusCircle,
  matches: (p) => p.startsWith("/start"),
};

/** The sections this build and this person see. A contributor-only build shows "You" only to someone with an account. */
function navItems(): readonly NavItem[] {
  const raises = raisesOffered();
  return NAV_ITEMS.flatMap((item) => {
    if (item.to !== "/portfolio") return [item];
    if (!portfolioInNav(raises, existingUserPubkey() !== null)) return [];
    return [{ ...item, label: portfolioLabel() }];
  });
}

/**
 * What is new in the rooms (mentions, a moderator's notice about your words), for the one bell: counted with the
 * rest. A check that failed with nothing read is `failed`, marked on the bell instead of no count.
 */
function useRoomsBadge(): { count: number; failed: boolean } {
  const { view, unread } = useNotifications();
  return communityBadge({ view, unread });
}

/** The test id of a section's link: by its address, so a build that renames a section keeps it. */
function navTestId(item: NavItem): string {
  return `app-nav-${item.to === "/" ? "home" : item.to.slice(1)}`;
}

/** Pages people land on from outside the app, shown without app chrome. */
export function hidesAppNav(pathname: string): boolean {
  return pathname.startsWith("/invite/");
}

/**
 * The app's one navigation: a top bar on wide screens (logo, search, sections,
 * account), a bottom tab bar on phones. Exactly one is mounted (not both
 * hidden by CSS), so there is one profile menu, one set of landmarks and one
 * tab stop per destination. Both carry the Testnet tag while the build cannot
 * reach real money: beside the logo, or as a line above the tab bar.
 */
export function AppNav() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const wide = useMediaQuery("(min-width: 768px)");
  const items = navItems();
  const rooms = useRoomsBadge();
  const signedIn = existingUserPubkey() !== null;

  if (wide) {
    return (
      <nav
        aria-label="Main"
        className="flex h-16 w-full shrink-0 items-center gap-3 border-b border-border/60 bg-background/70 px-4 backdrop-blur-md lg:gap-6 lg:px-8"
        data-testid="app-nav"
        data-layout="wide"
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
        <TestnetChip />
        <HeaderSearch />
        <div className="ml-auto flex items-center gap-0.5">
          {items.map((item) => (
            <NavLink
              active={item.matches(pathname)}
              item={item}
              key={item.to}
              variant="top"
            />
          ))}
        </div>
        {signedIn ? (
          <Suspense fallback={null}>
            <InboxLinks rooms={rooms} />
          </Suspense>
        ) : null}
        <Button asChild size="sm">
          <Link data-testid="app-nav-start" to="/start">
            Start
          </Link>
        </Button>
        <ProfileMenu placement="header" />
      </nav>
    );
  }

  return (
    <div className="flex w-full flex-col">
      <TestnetStrip />
      <nav
        aria-label="Main"
        className="flex h-14 w-full shrink-0 items-stretch justify-around border-t border-border/60 bg-sidebar px-1"
        data-testid="app-nav"
        data-layout="phone"
      >
        {/* Start sits in the middle, as the wide bar's Start button does at its end. */}
        {[...items.slice(0, 2), START_TAB, ...items.slice(2)]
          .filter((item) => !item.wideOnly)
          .map((item) => (
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
    </div>
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
  const target = { to: item.to } as const;
  if (variant === "top") {
    return (
      <Link
        {...target}
        aria-current={active ? "page" : undefined}
        className={`relative rounded-lg px-2.5 py-2 text-sm font-semibold transition-colors lg:px-3 ${
          active
            ? "text-foreground after:absolute after:inset-x-2.5 after:-bottom-[13px] after:h-[3px] after:rounded-full after:bg-primary"
            : "text-foreground/65 hover:bg-foreground/[0.06] hover:text-foreground"
        }`}
        data-testid={navTestId(item)}
      >
        {item.label}
      </Link>
    );
  }
  return (
    <Link
      {...target}
      aria-current={active ? "page" : undefined}
      className={`relative flex min-w-0 max-w-20 flex-1 flex-col items-center justify-center gap-0.5 rounded-lg px-1 py-1.5 text-2xs font-semibold transition-colors ${
        active
          ? "bg-primary/15 text-primary-ink"
          : "text-foreground/75 hover:bg-foreground/[0.06] hover:text-foreground"
      }`}
      data-testid={navTestId(item)}
    >
      <Icon aria-hidden className="h-5 w-5 shrink-0" />
      <span className="max-w-full truncate">{item.label}</span>
    </Link>
  );
}
