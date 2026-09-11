import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";

export const Route = createFileRoute("/launchpad/$launchId")({
  validateSearch: (search: Record<string, unknown>) => ({
    author:
      typeof search.author === "string" && search.author.length > 0
        ? search.author
        : undefined,
  }),
  component: LaunchDetailRoute,
});

// Wrapper stays eager for `useParams`/`useSearch`; the page body (models and
// chain adapter) loads on demand.
const LaunchDetailPage = lazyRouteComponent(
  () => import("@/features/launchpad/ui/LaunchDetailPage"),
  "LaunchDetailPage",
);

function LaunchDetailRoute() {
  const { launchId } = Route.useParams();
  const { author } = Route.useSearch();
  return <LaunchDetailPage launchId={launchId} author={author} />;
}
