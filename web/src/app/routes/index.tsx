import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";

type HomeTab = "everyone" | "following" | "boards" | "projects";

const TABS: readonly HomeTab[] = [
  "everyone",
  "following",
  "boards",
  "projects",
];

interface HomeSearch {
  /** The timeline tab, kept in the address so Back from a board post returns to it. */
  tab?: Exclude<HomeTab, "everyone">;
}

export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>): HomeSearch => {
    const tab = TABS.find((t) => t === search.tab);
    return tab && tab !== "everyone" ? { tab } : {};
  },
  component: lazyRouteComponent(
    () => import("@/features/social/ui/SocialHomePage"),
    "SocialHomePage",
  ),
});
