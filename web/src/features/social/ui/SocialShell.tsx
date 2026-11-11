import { BrowserNotifications } from "@/features/notifications/ui/BrowserNotifications";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  Bell,
  Bookmark,
  Feather,
  Mail,
  PenLine,
  Search,
  User,
} from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/shared/lib/cn";
import { existingUserPubkey } from "@/shared/lib/identity";

import { useNotificationBadge } from "../use-discovery";
import { useHasNewMessages } from "../use-messages-seen";
import { RightRail } from "./RightRail";

type NavLinkTarget =
  | { to: "/" }
  | { to: "/social/explore" }
  | { to: "/social/notifications" }
  | { to: "/social/messages" }
  | { to: "/social/bookmarks" }
  | { to: "/social/search" }
  | { to: "/u/$pubkey"; params: { pubkey: string } };

interface NavEntry {
  key: string;
  label: string;
  icon: typeof Feather;
  link: NavLinkTarget;
  /** The nav item stays highlighted for any path under this prefix. */
  prefix: string;
  badge?: number;
  /** The count could not be read: the badge says so instead of showing nothing new. */
  badgeFailed?: boolean;
  /** Something new without a count: a dot, and the link's name says so. */
  dot?: boolean;
}

function useNavEntries(): NavEntry[] {
  const me = existingUserPubkey();
  const { unread, failed } = useNotificationBadge();
  const newMessages = useHasNewMessages();
  return navEntries(me, unread, failed, newMessages);
}

function navEntries(
  me: string | null,
  unread: number,
  failed: boolean,
  newMessages: boolean,
): NavEntry[] {
  return [
    {
      key: "feed",
      label: "Home",
      icon: Feather,
      link: { to: "/" },
      prefix: "/",
    },
    ...(me
      ? [
          {
            key: "notifications",
            label: "Notifications",
            icon: Bell,
            link: { to: "/social/notifications" as const },
            prefix: "/social/notifications",
            badge: unread,
            badgeFailed: failed,
          },
          {
            key: "messages",
            label: "Messages",
            icon: Mail,
            link: { to: "/social/messages" as const },
            prefix: "/social/messages",
            dot: newMessages,
          },
          {
            key: "bookmarks",
            label: "Bookmarks",
            icon: Bookmark,
            link: { to: "/social/bookmarks" as const },
            prefix: "/social/bookmarks",
          },
          {
            key: "profile",
            label: "Profile",
            icon: User,
            link: { to: "/u/$pubkey" as const, params: { pubkey: me } },
            prefix: `/u/${me}`,
          },
        ]
      : []),
  ];
}

function UnreadBadge({
  count,
  failed,
  dot,
}: {
  count?: number;
  failed?: boolean;
  dot?: boolean;
}) {
  if (failed) {
    return (
      <span
        className="absolute -right-2 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-3xs font-bold text-black"
        data-testid="social-unread-failed"
      >
        <span aria-hidden>!</span>
        <span className="sr-only">Couldn't check for new notifications</span>
      </span>
    );
  }
  if (!count) {
    // The link's own name says "new messages"; the dot is only what the eye sees.
    return dot ? (
      <span
        aria-hidden
        className="absolute -right-1 -top-0.5 h-2.5 w-2.5 rounded-full bg-primary ring-2 ring-background"
        data-testid="social-new-messages-dot"
      />
    ) : null;
  }
  return (
    <span
      className="absolute -right-2 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-3xs font-bold text-primary-foreground"
      data-testid="social-unread"
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

/** Focus the composer on this page, or take the reader to the feed to use it. */
function useCompose() {
  const navigate = useNavigate();
  return () => {
    const focus = () => {
      const el = document.getElementById("social-composer-input");
      el?.scrollIntoView({ block: "center", behavior: "smooth" });
      el?.focus({ preventScroll: true });
      return el !== null;
    };
    if (focus()) return;
    void navigate({ to: "/" }).then(() => setTimeout(focus, 150));
  };
}

function pathMatches(pathname: string, prefix: string): boolean {
  // A board opens from Home's Boards tab, so Home stays the place you are in.
  if (prefix === "/") return pathname === "/" || pathname.startsWith("/b/");
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * The social section's own frame, inside the app shell: a section nav, the
 * timeline column and a rail of projects, trends and people to follow.
 * On phones the section nav becomes a strip along the top of the page, and
 * the rail moves below the timeline.
 */
export function SocialShell({
  children,
  rail = true,
}: {
  children: ReactNode;
  rail?: boolean;
}) {
  const entries = useNavEntries();
  // On a phone the app's own tab bar has Home but no search box, so the strip carries Search, and is always shown.
  const mobileEntries: NavEntry[] = [
    {
      key: "search",
      label: "Search",
      icon: Search,
      link: { to: "/social/search" },
      prefix: "/social/search",
    },
    ...entries.filter((entry) => entry.key !== "feed"),
  ];
  const compose = useCompose();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return (
    <div
      className="flex h-full w-full flex-1 overflow-y-auto"
      data-testid="social-shell"
    >
      {/* Three columns with equal outer tracks, so the timeline sits in the exact
          middle of the screen whether or not the nav and the rail are shown. */}
      {/* On a phone the one column is told it may shrink: left to size itself, a long name that is cut with an
          ellipsis (a project in the side panel) would set the column's width and push the page sideways. */}
      <div className="mx-auto grid w-full max-w-[96rem] grid-cols-[minmax(0,1fr)] items-start md:grid-cols-[minmax(0,1fr)_minmax(0,38rem)_minmax(0,1fr)]">
        <nav
          aria-label="Social"
          className="sticky top-0 hidden w-14 shrink-0 flex-col items-center gap-1 self-start justify-self-end px-1 py-3 md:flex xl:w-56 xl:items-stretch xl:px-3"
          data-testid="social-nav"
        >
          {/* Home and your profile are in the app's own nav and account menu, and Notifications and Messages sit in
              its top bar: this column keeps what only the timeline has. */}
          {entries
            .filter((entry) => !IN_APP_NAV.has(entry.key))
            .map((entry) => (
              <SocialNavLink
                entry={entry}
                key={entry.key}
                pathname={pathname}
              />
            ))}
          <button
            aria-label="Write a post"
            className="mt-3 flex h-11 w-11 items-center justify-center gap-2 rounded-full bg-primary text-sm font-semibold text-primary-foreground hover:bg-primary/90 xl:w-full"
            data-testid="social-compose"
            onClick={compose}
            type="button"
          >
            <PenLine aria-hidden className="h-5 w-5 xl:hidden" />
            <span className="hidden xl:inline">Post</span>
          </button>
        </nav>

        <div className="glass min-w-0 border-x xl:min-h-full">
          {/* On a phone Home is already in the app's own tab bar, so the strip carries the rest. */}
          {mobileEntries.length > 0 ? (
            <nav
              aria-label="Social"
              // Solid: inside the timeline's glass card a bar's own blur does not apply (a blur inside a blur), and any
              // see-through background leaves scrolled text readable under it.
              className="sticky top-0 z-20 flex gap-1 overflow-x-auto border-b border-border/60 bg-background px-2 py-1 md:hidden"
              data-testid="social-nav-mobile"
            >
              {mobileEntries.map((entry) => (
                <SocialNavLink
                  compact
                  entry={entry}
                  key={entry.key}
                  pathname={pathname}
                />
              ))}
            </nav>
          ) : null}
          <div className="min-h-full">{children}</div>
        </div>

        {rail ? (
          // One landmark in every layout, last in reading order: on wide screens it is the third column; below that it
          // sits under the timeline (in its column on a tablet, full width on a phone), so no block is lost.
          <aside
            aria-label="Discover"
            className="w-full min-w-0 max-w-full px-4 py-3 md:col-start-2 md:row-start-2 xl:sticky xl:top-0 xl:col-start-3 xl:row-start-1 xl:max-h-[calc(100dvh-4rem)] xl:w-80 xl:self-start xl:justify-self-start xl:overflow-y-auto"
            data-testid="social-rail"
          >
            <RightRail />
          </aside>
        ) : null}
      </div>
    </div>
  );
}

/** The timeline's sections that wide screens reach from the app's top bar instead. */
const IN_APP_NAV = new Set(["feed", "profile", "notifications", "messages"]);

/**
 * Notifications and Messages for the app's top bar on wide screens, with the same counts and names as the timeline's
 * own nav. Rendered only for someone with an account (its reads need one).
 */
export function InboxLinks({
  rooms = { count: 0, failed: false },
}: {
  /**
   * What is new in the rooms (mentions, a moderator's notice): counted on the same bell, so there is one bell and one
   * number. The Notifications page says how many of them are in rooms and links there.
   */
  rooms?: { count: number; failed: boolean };
}) {
  const me = existingUserPubkey();
  const badge = useNotificationBadge();
  const unread = badge.unread + rooms.count;
  const failed = badge.failed || rooms.failed;
  const newMessages = useHasNewMessages();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const entries = navEntries(me, unread, failed, newMessages).filter(
    (entry) => entry.key === "notifications" || entry.key === "messages",
  );
  return (
    <div className="flex items-center gap-0.5" data-testid="app-nav-inbox">
      {me && !failed ? <BrowserNotifications me={me} unread={unread} /> : null}
      {entries.map((entry) => (
        <SocialNavLink
          compact
          entry={entry}
          key={entry.key}
          pathname={pathname}
        />
      ))}
    </div>
  );
}

function SocialNavLink({
  entry,
  pathname,
  compact = false,
}: {
  entry: NavEntry;
  pathname: string;
  compact?: boolean;
}) {
  const Icon = entry.icon;
  const active = pathMatches(pathname, entry.prefix);
  return (
    <Link
      {...entry.link}
      aria-current={active ? "page" : undefined}
      aria-label={
        compact || entry.dot
          ? `${entry.label}${entry.badge && !entry.badgeFailed ? `, ${entry.badge} new` : ""}${entry.badgeFailed ? ", couldn't check for new ones" : ""}${entry.dot ? ", new messages" : ""}`
          : undefined
      }
      className={cn(
        "flex shrink-0 items-center gap-4 rounded-full text-base transition-colors hover:bg-black/5 dark:hover:bg-white/10",
        compact
          ? "px-3 py-2 max-sm:min-h-11"
          : "h-11 w-11 justify-center xl:w-auto xl:justify-start xl:px-3",
        active
          ? "font-bold text-black dark:text-white"
          : "text-black/70 dark:text-white/70",
      )}
      data-testid={`social-nav-${entry.key}`}
      title={entry.label}
    >
      <span className="relative">
        <Icon aria-hidden className="h-6 w-6" />
        <UnreadBadge
          count={entry.badge}
          dot={entry.dot}
          failed={entry.badgeFailed}
        />
      </span>
      {compact ? null : <span className="hidden xl:inline">{entry.label}</span>}
    </Link>
  );
}

/** The sticky title bar every social page opens with. */
export function PageBar({
  title,
  back,
  actions,
  children,
}: {
  title: ReactNode;
  back?: ReactNode;
  /** Buttons at the right end of the title row. */
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    // Above the timeline: a post's avatar link is lifted (z-10) over its card's own link, and must still pass under this.
    // Solid for the same reason as the phone's strip: a blur does not apply inside the glass card.
    <header className="sticky top-0 z-20 border-b border-border/60 bg-background max-md:top-11">
      <div className="flex min-h-12 items-center gap-3 px-4">
        {back}
        <h1 className="min-w-0 flex-1 truncate text-lg font-bold text-black dark:text-white">
          {title}
        </h1>
        {actions ? (
          <div className="flex shrink-0 items-center gap-1.5">{actions}</div>
        ) : null}
      </div>
      {children}
    </header>
  );
}
