import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";

import {
  type LaunchAction,
  parseLaunchAction,
} from "@/features/launchpad/lib/deep-link";

/** Optional on purpose: a link names only what it needs, so existing links stay as they are. */
interface LaunchSearch {
  author?: string;
  action?: LaunchAction;
  tab?: "decisions";
}

export const Route = createFileRoute("/launchpad/$launchId")({
  validateSearch: (search: Record<string, unknown>): LaunchSearch => ({
    author:
      typeof search.author === "string" && search.author.length > 0
        ? search.author
        : undefined,
    // Desktop handoff: `?action=bid|exit|claim` opens the matching flow.
    // Unknown values are ignored (forward-compat).
    action: parseLaunchAction(search.action) ?? undefined,
    // `?tab=decisions` opens that tab: a discussion on a board links straight to the vote.
    tab: search.tab === "decisions" ? ("decisions" as const) : undefined,
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
  const { author, action, tab } = Route.useSearch();
  const sandbox = launchId === "nebula-sandbox";
  return (
    <LaunchDetailPage
      action={action}
      author={author}
      initialTab={tab}
      launchId={launchId}
      sandbox={sandbox}
    />
  );
}
