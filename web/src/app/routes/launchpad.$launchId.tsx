import {
  createFileRoute,
  lazyRouteComponent,
  redirect,
} from "@tanstack/react-router";

import { isDecisionId } from "@/features/launchpad/lib/decision-link";
import {
  type LaunchAction,
  parseLaunchAction,
} from "@/features/launchpad/lib/deep-link";
import { raisesOffered } from "@/features/launchpad/lib/raises-offered";
import { SANDBOX_ID } from "@/features/launchpad/lib/sandbox";

/** Optional on purpose: a link names only what it needs, so existing links stay as they are. */
interface LaunchSearch {
  author?: string;
  action?: LaunchAction;
  tab?:
    | "overview"
    | "decisions"
    | "record"
    | "milestones"
    | "work"
    | "contributions"
    | "agents"
    | "updates"
    | "discussion"
    | "boards"
    | "treasury"
    | "mybids"
    | "manage"
    | "proposals";
  claim?: string;
  mandate?: string;
  /** One decision to show: its id. Opens the Decisions tab and highlights that card. */
  decision?: string;
}

export const Route = createFileRoute("/launchpad/$launchId")({
  // The sandbox walks through a raise; a contributor-only build offers none, so its address leads to the launchpad.
  beforeLoad: ({ params }) => {
    if (params.launchId === SANDBOX_ID && !raisesOffered()) {
      throw redirect({ to: "/launchpad", search: {}, replace: true });
    }
  },
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
      typeof search.tab === "string" &&
      [
        "overview",
        "decisions",
        "record",
        "milestones",
        "work",
        "contributions",
        "agents",
        "updates",
        "discussion",
        "boards",
        "treasury",
        "mybids",
        "manage",
        "proposals",
      ].includes(search.tab)
        ? (search.tab as LaunchSearch["tab"])
        : undefined,
    claim:
      typeof search.claim === "string" && /^0x[0-9a-f]{64}$/i.test(search.claim)
        ? search.claim.toLowerCase()
        : undefined,
    mandate:
      typeof search.mandate === "string" &&
      /^0x[0-9a-f]{40}$/i.test(search.mandate)
        ? search.mandate.toLowerCase()
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
  const { author, action, tab, decision, claim, mandate } = Route.useSearch();
  const sandbox = launchId === SANDBOX_ID;
  return (
    <LaunchDetailPage
      key={`${author ?? "unknown"}:${launchId}`}
      action={action}
      author={author}
      initialClaim={claim && mandate ? { id: claim, mandate } : undefined}
      initialDecision={decision}
      initialTab={tab}
      launchId={launchId}
      sandbox={sandbox}
    />
  );
}
