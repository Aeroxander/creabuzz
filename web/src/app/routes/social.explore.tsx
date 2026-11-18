import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";

const ExplorePage = lazyRouteComponent(
  () => import("@/features/social/ui/ExplorePage"),
  "ExplorePage",
);

type ExploreTab = "posts" | "people" | "hashtags";

const TABS: readonly ExploreTab[] = ["posts", "people", "hashtags"];

interface ExploreSearch {
  /** Which full list opens: the rail's "See all" links name it. Trending posts is the default and stays out of the address. */
  tab?: Exclude<ExploreTab, "posts">;
}

export const Route = createFileRoute("/social/explore")({
  validateSearch: (search: Record<string, unknown>): ExploreSearch => {
    const tab = TABS.find((t) => t === search.tab);
    // The key is always present: a child route's search is merged over the raw address, so leaving it out would let an
    // unknown tab name through.
    return { tab: tab && tab !== "posts" ? tab : undefined };
  },
  component: ExplorePage,
});
