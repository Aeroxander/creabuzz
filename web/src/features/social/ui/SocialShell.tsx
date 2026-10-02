import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  Bell,
  Bookmark,
  Compass,
  Feather,
  Mail,
  PenLine,
  User,
} from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/shared/lib/cn";
import { existingUserPubkey } from "@/shared/lib/identity";

import { useNotificationBadge } from "../use-discovery";
import { RightRail } from "./RightRail";

type NavLinkTarget =
  | { to: "/social" }
  | { to: "/social/explore" }
  | { to: "/social/notifications" }
  | { to: "/social/messages" }
  | { to: "/social/bookmarks" }
  | { to: "/u/$pubkey"; params: { pubkey: string } };

interface NavEntry {
  key: string;
  label: string;
  icon: typeof Feather;
  link: NavLinkTarget;
  /** The nav item stays highlighted for any path under this prefix. */
  prefix: string;
  badge?: number;
}

function useNavEntries(): NavEntry[] {
  const me = existingUserPubkey();
  const { unread } = useNotificationBadge();
  return [
    {
      key: "feed",
      label: "Feed",
      icon: Feather,
      link: { to: "/social" },
      prefix: "/social",
    },
    {
      key: "explore",
      label: "Explore",
      icon: Compass,
      link: { to: "/social/explore" },
      prefix: "/social/explore",
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
          },
          {
            key: "messages",
            label: "Messages",
            icon: Mail,
            link: { to: "/social/messages" as const },
            prefix: "/social/messages",
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

function UnreadBadge({ count }: { count?: number }) {
  if (!count) return null;
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
    void navigate({ to: "/social" }).then(() => setTimeout(focus, 150));
  };
}

function pathMatches(pathname: string, prefix: string): boolean {
  if (prefix === "/social") return pathname === "/social";
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * The social section's own frame, inside the app shell: a section nav, the
 * timeline column and a right rail of search, trends and people to follow.
 * On phones the section nav becomes a strip along the top of the page.
 */
export function SocialShell({
  children,
  rail = true,
}: {
  children: ReactNode;
  rail?: boolean;
}) {
  const entries = useNavEntries();
  const compose = useCompose();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return (
    <div
      className="flex h-full w-full flex-1 overflow-y-auto"
      data-testid="social-shell"
    >
      {/* Three columns with equal outer tracks, so the timeline sits in the exact
          middle of the screen whether or not the nav and the rail are shown. */}
      <div className="mx-auto grid w-full max-w-[96rem] items-start md:grid-cols-[minmax(0,1fr)_minmax(0,38rem)_minmax(0,1fr)]">
        <nav
          aria-label="Social"
          className="sticky top-0 hidden w-14 shrink-0 flex-col items-center gap-1 self-start justify-self-end px-1 py-3 md:flex xl:w-56 xl:items-stretch xl:px-3"
          data-testid="social-nav"
        >
          {entries.map((entry) => (
            <SocialNavLink entry={entry} key={entry.key} pathname={pathname} />
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

        <div className="glass min-h-full min-w-0 border-x">
          <nav
            aria-label="Social"
            className="sticky top-0 z-20 flex gap-1 overflow-x-auto border-b border-border/60 bg-background/70 px-2 py-1 backdrop-blur md:hidden"
            data-testid="social-nav-mobile"
          >
            {entries.map((entry) => (
              <SocialNavLink
                compact
                entry={entry}
                key={entry.key}
                pathname={pathname}
              />
            ))}
          </nav>
          <div className="min-h-full">{children}</div>
        </div>

        {rail ? (
          <aside
            aria-label="Discover"
            className="sticky top-0 hidden w-80 max-w-full shrink-0 self-start justify-self-start px-4 py-3 xl:block"
            data-testid="social-rail"
          >
            <RightRail />
          </aside>
        ) : null}
      </div>
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
      aria-label={compact ? entry.label : undefined}
      className={cn(
        "flex shrink-0 items-center gap-4 rounded-full text-base transition-colors hover:bg-black/5 dark:hover:bg-white/10",
        compact
          ? "px-3 py-2"
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
        <UnreadBadge count={entry.badge} />
      </span>
      {compact ? null : <span className="hidden xl:inline">{entry.label}</span>}
    </Link>
  );
}

/** The sticky title bar every social page opens with. */
export function PageBar({
  title,
  back,
  children,
}: {
  title: ReactNode;
  back?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="sticky top-0 z-10 border-b border-border/60 bg-background/45 backdrop-blur-xl max-md:top-11">
      <div className="flex min-h-12 items-center gap-3 px-4">
        {back}
        <h1 className="min-w-0 flex-1 truncate text-lg font-bold text-black dark:text-white">
          {title}
        </h1>
      </div>
      {children}
    </header>
  );
}
