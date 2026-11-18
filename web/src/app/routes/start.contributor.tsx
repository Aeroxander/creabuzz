import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";

interface ContributorStartSearch {
  /** A Projects-board project to start from (D84): its id. */
  project?: string;
  /** And the founder who posted it. */
  author?: string;
}

export const Route = createFileRoute("/start/contributor")({
  validateSearch: (
    search: Record<string, unknown>,
  ): ContributorStartSearch => ({
    project: typeof search.project === "string" ? search.project : undefined,
    author: typeof search.author === "string" ? search.author : undefined,
  }),
  component: lazyRouteComponent(
    () => import("@/features/start/ui/ContributorStartPage"),
    "ContributorStartPage",
  ),
});
