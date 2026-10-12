import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";

import { isDecisionId } from "@/features/launchpad/lib/decision-link";
import {
  type LaunchAction,
  parseLaunchAction,
} from "@/features/launchpad/lib/deep-link";

/** Optional on purpose: a link names only what it needs, so existing links stay as they are. */
interface LaunchSearch {
  author?: string;
  action?: LaunchAction;
  tab?: "decisions" | "record";
  /** One decision to show: its id. Opens the Decisions tab and highlights that card. */
  decision?: string;
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
    // `?tab=decisions` opens that tab (a discussion on a board links straight to the vote), and `?tab=record` opens the
    // DAO's track record, which is what people share.
    tab:
      search.tab === "decisions" || search.tab === "record"
        ? search.tab
        : undefined,
    decision:
      typeof search.decision === "string" &&
      isDecisionId(search.decision.toLowerCase())
        ? search.decision.toLowerCase()
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
  const { author, action, tab, decision } = Route.useSearch();
  const sandbox = launchId === "nebula-sandbox";
  return (
    <LaunchDetailPage
      action={action}
      author={author}
      initialDecision={decision}
      initialTab={tab}
      launchId={launchId}
      sandbox={sandbox}
    />
  );
}
