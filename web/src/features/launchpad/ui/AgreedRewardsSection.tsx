import { Card } from "@/shared/ui/card";
import { Button } from "@/shared/ui/button";

import type { MandateView } from "@creaton/core/launchpad/workRead.ts";
import type { SenderCall } from "@/features/identity/lib/sponsoredSender";
import { capabilityHeadline } from "../lib/agreed-lane";
import type { OpenWorkArea } from "../lib/ways-to-help";
import type { Launch } from "../models";
import type { AgreementsLane, AgreementsRead } from "../use-agreements";
import { AgreedProposalForm } from "./AgreedProposalForm";
import { AgreedTermsCard } from "./AgreedTermsCard";

const sameAddress = (a: string | null, b: string) =>
  a !== null && a.toLowerCase() === b.toLowerCase();

/**
 * The agreed-reward lane as the Work tab shows it, for the budgets that carry
 * it: every offer's exact terms, the one step open now, and the manager's
 * proposal form. A budget whose lane cannot be read says so and offers a real
 * retry — a failed read is never turned into "this budget predates agreed
 * rewards", and a page of offers that stopped early says it is truncated.
 */
export function AgreedRewardsSection({
  launch,
  dao,
  wallet,
  gate,
  busy,
  mandates,
  read,
  loading,
  failed,
  onRetry,
  areas,
  titles,
  labelOf,
  onSendBatch,
}: {
  launch: Launch;
  dao: string;
  wallet: string | null;
  gate: string | null;
  busy: string | null;
  mandates: readonly MandateView[];
  read: AgreementsRead | undefined;
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
  areas: readonly OpenWorkArea[];
  titles: ReadonlyMap<string, string>;
  labelOf: (address: string) => string;
  onSendBatch: (key: string, calls: SenderCall[]) => Promise<boolean>;
}) {
  const ready = read?.state === "ready" ? read : null;
  // A budget with nothing to say here (a deployment before agreed rewards
  // existed) is left to its existing manual flow; every other budget gets a
  // card, including one whose read failed.
  const shown = mandates.filter((mandate) => {
    // The milestone panel holds no money and awards no Shares: agreed rewards
    // are not one of its paths, so it gets no card.
    if (mandate.isMilestonePanel) return false;
    const lane = ready?.lanes.get(mandate.address.toLowerCase());
    if (!lane) return true;
    return lane.capability !== "known-legacy";
  });
  if (!loading && !failed && shown.length === 0) return null;

  return (
    <Card className="p-4" data-testid="agreed-rewards">
      <h2 className="text-base font-semibold">Agreed rewards</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Work whose exact reward is promised before it starts. The reward is a
        fixed number of Shares, not money and not a percentage of the project.
        It is paid on those terms without a new award vote.
      </p>
      {loading ? (
        <p
          className="mt-2 text-sm text-muted-foreground"
          data-testid="agreed-rewards-loading"
          role="status"
        >
          Reading this budget's agreed rewards from the network…
        </p>
      ) : failed || !ready ? (
        <div className="mt-2" data-testid="agreed-rewards-error">
          <p className="text-sm">
            Could not read this budget's agreed rewards just now. Nothing here
            is left out on purpose.
          </p>
          <Button
            className="mt-2"
            onClick={onRetry}
            size="sm"
            type="button"
            variant="outline"
          >
            Try again
          </Button>
        </div>
      ) : (
        <div className="mt-3 grid gap-3">
          {shown.map((mandate) => {
            const key = mandate.address.toLowerCase();
            const lane = ready.lanes.get(key);
            const error = ready.errors.get(key);
            return (
              <MandateLane
                areas={areas}
                busy={busy}
                dao={dao}
                error={error ?? null}
                gate={gate}
                key={key}
                labelOf={labelOf}
                lane={lane ?? null}
                launch={launch}
                mandate={mandate}
                onRefresh={onRetry}
                onSendBatch={onSendBatch}
                titles={titles}
                wallet={wallet}
              />
            );
          })}
        </div>
      )}
    </Card>
  );
}

function MandateLane({
  launch,
  dao,
  mandate,
  lane,
  error,
  wallet,
  gate,
  busy,
  areas,
  titles,
  labelOf,
  onSendBatch,
  onRefresh,
}: {
  launch: Launch;
  dao: string;
  mandate: MandateView;
  lane: AgreementsLane | null;
  error: string | null;
  wallet: string | null;
  gate: string | null;
  busy: string | null;
  areas: readonly OpenWorkArea[];
  titles: ReadonlyMap<string, string>;
  labelOf: (address: string) => string;
  onSendBatch: (key: string, calls: SenderCall[]) => Promise<boolean>;
  onRefresh: () => void;
}) {
  if (error !== null || lane === null) {
    return (
      <section
        className="rounded-xl border border-border/60 p-3 text-sm"
        data-testid="agreed-rewards-mandate-error"
      >
        <p>
          Could not read this budget's agreed rewards just now, so nothing is
          assumed about whether it has them. Its existing process is unchanged.
        </p>
        <Button
          className="mt-2"
          onClick={onRefresh}
          size="sm"
          type="button"
          variant="outline"
        >
          Try again
        </Button>
      </section>
    );
  }
  const supported = lane.capability === "supported";
  const manages = mandate.projects.some((project) =>
    sameAddress(wallet, project.record.manager),
  );
  const offers = lane.agreements.filter((item) => item.row.kind !== "absent");
  return (
    <section
      className="rounded-xl border border-border/60 p-3"
      data-testid="agreed-rewards-mandate"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">
          {mandate.isMilestonePanel ? "Milestone reviewers" : "Work budget"}
        </h3>
        <span className="text-xs text-muted-foreground">
          {lane.capability === "supported"
            ? `${offers.length} ${offers.length === 1 ? "agreement" : "agreements"}`
            : ""}
        </span>
      </div>
      <p className="mt-1 text-sm" data-testid="agreed-rewards-capability">
        {capabilityHeadline(lane.capability)}
      </p>
      {lane.capability === "unreadable" ? (
        <Button
          className="mt-2"
          onClick={onRefresh}
          size="sm"
          type="button"
          variant="outline"
        >
          Try again
        </Button>
      ) : null}
      {lane.offersUnavailable ? (
        <p
          className="mt-1 text-sm text-amber-800 dark:text-amber-200"
          data-testid="agreed-rewards-offers-unavailable"
        >
          {lane.offersUnavailable}
        </p>
      ) : null}
      {lane.offersTruncated ? (
        <p
          className="mt-1 text-sm text-muted-foreground"
          data-testid="agreed-rewards-truncated"
          role="status"
        >
          This budget has more offers than are listed here. The newest are
          shown; older ones are not hidden on purpose.
        </p>
      ) : null}
      {lane.idsTruncated ? (
        <p
          className="mt-1 text-sm text-muted-foreground"
          data-testid="agreed-rewards-ids-truncated"
          role="status"
        >
          This budget has more agreements than this page reads at once. The
          newest are shown; older ones are not hidden on purpose.
        </p>
      ) : null}
      {lane.wordsUnreadable ? (
        <p
          className="mt-1 text-sm text-muted-foreground"
          data-testid="agreed-rewards-words-unreadable"
        >
          The descriptions people published for these offers could not be read
          just now, so they are not shown. Their terms, as recorded on the
          network, are below.
        </p>
      ) : null}
      {lane.linksUnreadable ? (
        <p
          className="mt-1 text-sm text-muted-foreground"
          data-testid="agreed-rewards-links-unreadable"
        >
          Some submissions could not be checked against their agreements just
          now, so no award vote is offered on those.
        </p>
      ) : null}
      {supported && offers.length > 0 ? (
        <ul className="mt-3 grid gap-2">
          {offers.map((item) => (
            <AgreedTermsCard
              busy={busy}
              dao={dao}
              gate={gate}
              item={item}
              key={item.row.id}
              labelOf={labelOf}
              lane={lane}
              launch={launch}
              mandate={mandate}
              onRefresh={onRefresh}
              onSendBatch={onSendBatch}
              titles={titles}
              wallet={wallet}
            />
          ))}
        </ul>
      ) : supported ? (
        <p className="mt-2 text-sm text-muted-foreground">
          No agreed work is listed here yet.
        </p>
      ) : null}
      {supported &&
      manages &&
      !mandate.closed &&
      mandate.created.shareBudget > 0n ? (
        <div className="mt-3">
          <AgreedProposalForm
            areas={areas}
            busy={busy}
            chainTime={lane.chainTime}
            gate={gate}
            launch={launch}
            mandate={mandate}
            onRefresh={onRefresh}
            onSendBatch={onSendBatch}
            titles={titles}
            wallet={wallet}
          />
        </div>
      ) : null}
    </section>
  );
}
