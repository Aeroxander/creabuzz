import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";

type HomeTab = "everyone" | "following" | "boards" | "updates";

const TABS: readonly HomeTab[] = ["everyone", "following", "boards", "updates"];

/** Older names for a tab, so links and bookmarks made before a rename still open it. */
const TAB_ALIASES: Readonly<Record<string, HomeTab>> = {
  // The projects' progress reports were called Projects before Discover listed the projects themselves.
  projects: "updates",
};

interface HomeSearch {
  /** The timeline tab, kept in the address so Back from a board post returns to it. */
  tab?: Exclude<HomeTab, "everyone">;
}

export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>): HomeSearch => {
    const asked =
      typeof search.tab === "string"
        ? (TAB_ALIASES[search.tab] ?? search.tab)
        : undefined;
    const tab = TABS.find((t) => t === asked);
    return tab && tab !== "everyone" ? { tab } : {};
  },
  component: lazyRouteComponent(
    () => import("@/features/social/ui/SocialHomePage"),
    "SocialHomePage",
  ),
});
