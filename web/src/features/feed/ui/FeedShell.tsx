import { Link } from "@tanstack/react-router";
import { Bookmark, BookMarked, Home, PenLine, User } from "lucide-react";
import type { ReactNode } from "react";

import buzzAppIcon from "@/assets/app-icon@3x.png";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { ThemeToggle } from "@/shared/theme/ThemeToggle";
import { ConnectButton } from "@/features/repos/ui/ConnectButton";

import { useViewerPubkey } from "../use-feed";

function focusComposer() {
  const el = document.getElementById("composer");
  el?.scrollIntoView({ block: "center", behavior: "smooth" });
  el?.focus({ preventScroll: true });
}

function relayHost(): string {
  try {
    return new URL(relayWsUrl()).host;
  } catch {
    return relayWsUrl();
  }
}

type NavItem = {
  key: string;
  label: string;
  icon: typeof Home;
  link:
    | { to: "/feed" | "/bookmarks" | "/" }
    | { to: "/p/$id"; params: { id: string } };
};

function useNavItems(): NavItem[] {
  const viewer = useViewerPubkey();
  return [
    { key: "home", label: "Home", icon: Home, link: { to: "/feed" } },
    {
      key: "bookmarks",
      label: "Bookmarks",
      icon: Bookmark,
      link: { to: "/bookmarks" },
    },
    ...(viewer
      ? [
          {
            key: "profile",
            label: "Profile",
            icon: User,
            link: { to: "/p/$id" as const, params: { id: viewer } },
          },
        ]
      : []),
    {
      key: "repos",
      label: "Repositories",
      icon: BookMarked,
      link: { to: "/" },
    },
  ];
}

/** Twitter-style three-column frame: nav rail, 600px timeline, info rail. */
export function FeedShell({ children }: { children: ReactNode }) {
  const nav = useNavItems();
  return (
    <div className="mx-auto flex w-full max-w-[1265px] flex-1 justify-center">
      <header className="sticky top-0 hidden h-dvh w-[68px] shrink-0 flex-col justify-between px-2 py-2 sm:flex xl:w-[275px] xl:px-3">
        <nav
          aria-label="Primary"
          className="flex flex-col items-center gap-1 xl:items-stretch"
        >
          <Link
            to="/feed"
            aria-label="Buzz"
            className="mb-1 flex h-12 w-12 items-center justify-center rounded-full hover:bg-foreground/10"
          >
            <img alt="" src={buzzAppIcon} className="h-8 w-8 rounded-[22%]" />
          </Link>
          {nav.map(({ key, label, icon: Icon, link }) => (
            <Link
              key={key}
              {...link}
              activeOptions={{ exact: true, includeSearch: false }}
              className="group flex w-fit items-center gap-5 rounded-full p-3 text-xl hover:bg-foreground/10 xl:pr-6"
              activeProps={{ className: "font-bold" }}
              inactiveProps={{ className: "font-normal" }}
            >
              <Icon className="h-[26px] w-[26px]" />
              <span className="hidden xl:inline">{label}</span>
            </Link>
          ))}
          <button
            type="button"
            onClick={focusComposer}
            aria-label="Post"
            className="mt-3 flex h-[52px] w-[52px] items-center justify-center rounded-full bg-primary font-bold text-primary-foreground shadow transition-colors hover:bg-primary/90 xl:w-full"
          >
            <PenLine className="h-5 w-5 xl:hidden" />
            <span className="hidden text-[17px] xl:inline">Post</span>
          </button>
        </nav>
        <div className="flex justify-center pb-2 xl:justify-start">
          <ThemeToggle />
        </div>
      </header>

      <main className="min-h-dvh w-full max-w-[600px] border-x pb-14 sm:pb-0">
        {children}
      </main>

      <aside className="sticky top-0 hidden h-dvh w-[350px] shrink-0 px-6 py-3 lg:block">
        <section className="rounded-2xl bg-muted/40 p-4">
          <h2 className="text-xl font-extrabold">This community</h2>
          <p className="mt-1 break-all text-sm text-muted-foreground">
            {relayHost()}
          </p>
          <p className="mt-3 text-[15px] leading-5">
            Posts here are Nostr notes. Open the community in Buzz for chat,
            channels and agents.
          </p>
          <ConnectButton className="mt-4 rounded-full" />
        </section>
      </aside>

      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-20 flex h-14 items-center justify-around border-t bg-background/95 backdrop-blur sm:hidden"
      >
        {nav.map(({ key, label, icon: Icon, link }) => (
          <Link
            key={key}
            {...link}
            aria-label={label}
            activeOptions={{ exact: true, includeSearch: false }}
            className="flex h-full flex-1 items-center justify-center"
            activeProps={{ className: "text-foreground" }}
            inactiveProps={{ className: "text-muted-foreground" }}
          >
            <Icon className="h-6 w-6" />
          </Link>
        ))}
      </nav>
    </div>
  );
}
