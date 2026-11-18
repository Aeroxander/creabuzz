import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";

const SearchPage = lazyRouteComponent(
  () => import("@/features/social/ui/SearchPage"),
  "SearchPage",
);

export const Route = createFileRoute("/social/search")({
  validateSearch: (search: Record<string, unknown>): { q?: string } => ({
    q: typeof search.q === "string" ? search.q : undefined,
  }),
  component: SearchPage,
});
