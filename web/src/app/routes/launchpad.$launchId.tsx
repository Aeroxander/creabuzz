import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";

import { parseLaunchAction } from "@/features/launchpad/lib/deep-link";

export const Route = createFileRoute("/launchpad/$launchId")({
  validateSearch: (search: Record<string, unknown>) => ({
    author:
      typeof search.author === "string" && search.author.length > 0
        ? search.author
        : undefined,
    // Desktop handoff: `?action=bid|exit|claim` opens the matching flow.
    // Unknown values are ignored (forward-compat).
    action: parseLaunchAction(search.action) ?? undefined,
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
  const { author, action } = Route.useSearch();
  const sandbox = launchId === "nebula-sandbox";
  return (
    <LaunchDetailPage
      action={action}
      author={author}
      launchId={launchId}
      sandbox={sandbox}
    />
  );
}
