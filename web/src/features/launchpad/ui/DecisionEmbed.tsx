/**
 * A decision, as a small live card, wherever a link to it appears: where it
 * stands, what it would do, who backs it, and a way to open it.
 *
 * Everything on it is read from the chain, never taken from the message that
 * linked it. The link names a launch and a decision id; the DAO is worked out
 * from the launch record the app already knows (`lib/dao-of-launch.ts`), so a
 * link cannot point this card at a contract of its writer's choosing. If the
 * launch is unknown or has no DAO, there is no card at all and the link is
 * left as the plain link it is.
 */

import { Link } from "@tanstack/react-router";
import { ScrollText } from "lucide-react";

import { TONE_CLASS } from "@/features/board/ui/status-tone";
import { Button } from "@/shared/ui/button";

import { formatUnits } from "@creaton/core/launchpad/daoActions.ts";
import { daoOfLaunch } from "../lib/dao-of-launch";
import type { DecisionLink } from "../lib/decision-link";
import { describeDecision } from "../lib/decision-describe";
import { decisionStage } from "../lib/decision-stage";
import { useDecisionContext, useDecisions } from "../use-decisions";
import { useLaunch } from "../use-launches";
import { useSecondaryMarketForWords } from "../use-secondary";

const shares = (wei: bigint) => formatUnits(wei, 18, 0);

export function DecisionEmbed({ link }: { link: DecisionLink }) {
  const { launch, isLoading } = useLaunch(link.launchId, link.author);
  const dao = launch ? daoOfLaunch(launch) : null;
  const decisions = useDecisions(dao, null);
  const context = useDecisionContext(dao);
  const secondaryMarket = useSecondaryMarketForWords({
    chainId: launch?.record.chainId ?? null,
    dao,
  });

  if (isLoading) {
    return (
      <p className="mt-2 text-xs text-muted-foreground" role="status">
        Loading the decision…
      </p>
    );
  }
  // Not a launch this app knows, or one with no DAO: nothing to show, so the link stays as it is.
  if (!launch || !dao) return null;

  const frame = (children: React.ReactNode) => (
    <div
      className="mt-2 max-w-xl rounded-xl border bg-card p-3 text-sm"
      data-testid="decision-embed"
    >
      <p className="flex items-center gap-2 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
        <ScrollText aria-hidden className="h-3.5 w-3.5" />
        Decision · {launch.record.name}
      </p>
      {children}
    </div>
  );

  if (decisions.isLoading) {
    return frame(
      <p className="mt-1 text-xs text-muted-foreground" role="status">
        Reading it from the chain…
      </p>,
    );
  }
  const snapshot = decisions.data;
  if (decisions.error || !snapshot) {
    return frame(
      <p className="mt-1 text-xs text-destructive" role="alert">
        Couldn't read this decision just now.{" "}
        <button
          className="underline"
          onClick={() => void decisions.refetch()}
          type="button"
        >
          Try again
        </button>
      </p>,
    );
  }
  const decision = snapshot.decisions.find(
    (d) => d.id.toLowerCase() === link.decisionId,
  );
  if (!decision) {
    return frame(
      <p className="mt-1 text-xs text-muted-foreground">
        That decision isn't in this project's DAO.
      </p>,
    );
  }

  const stage = decisionStage(decision, snapshot.chainTime);
  const described = decision.action
    ? describeDecision(decision.action, {
        dao,
        factory: context.data?.factory,
        secondaryMarket,
      })
    : null;
  const title =
    described && described.kind !== "unknown"
      ? described.title
      : "A decision. Open it to read what it would do.";
  return frame(
    <>
      <p className="mt-1 font-semibold" data-testid="decision-embed-title">
        {title}
      </p>
      <p className="mt-1 flex flex-wrap items-center gap-2 text-xs">
        <span
          className={`rounded-full px-2 py-0.5 font-medium ${TONE_CLASS[stage.tone]}`}
          data-testid="decision-embed-status"
        >
          {stage.label}
        </span>
        <span className="text-muted-foreground">
          Backing {shares(decision.support.yes)} · Against{" "}
          {shares(decision.support.no)}
        </span>
      </p>
      <div className="mt-2">
        <Button asChild size="sm" variant="outline">
          <Link
            data-testid="decision-embed-open"
            params={{ launchId: launch.record.id }}
            search={{
              author: launch.record.author,
              tab: "decisions",
              decision: link.decisionId,
            }}
            to="/launchpad/$launchId"
          >
            Open the decision
          </Link>
        </Button>
      </div>
    </>,
  );
}
