/**
 * The Backing block: how a project's backing stands, on its page and on its public scorecard. The record comes first and
 * money second, so this is one quiet card below the project's news, and it never shows a price chart, a price, or what
 * backing has returned (those live only in Home's feed). It says in plain words what state backing is in, what is held
 * for the project and what has been released, which milestone is next and the date backers may leave by, and the one
 * honest line about what a backer can and cannot do.
 *
 * Where the build has investing off (`VITE_INVESTING` not 1), this renders nothing at all and reads nothing: the gate is a
 * component of its own so no hook below it runs.
 *
 * On the scorecard it is for reading and sharing, signed out or in: it has no actions and links to the project's page,
 * where the same block takes them. On the project's page it carries the actions (`BackingActions`).
 */

import { Link } from "@tanstack/react-router";
import { type ReactNode, useMemo } from "react";

import {
  type MilestoneRecord,
  milestoneRecords,
  type NoPoolView,
  nextMilestone,
  type PoolEvent,
  type PoolPhase,
  type PoolView,
  poolTotals,
} from "@creaton/core/launchpad/backing.ts";

import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { Chip, type ChipTone } from "@/shared/ui/chip";

import {
  BACKING_HEADING,
  backingLimits,
  cutLine,
  dayWords,
  HONEST_LINE,
  milestoneLine,
  milestoneOutcomeLine,
  money,
  NOT_CONFIRMED_LINE,
  nextMilestoneFact,
  notHereLine,
  PHASE_CHIP,
  positionLine,
  READING_LINE,
  staleReadLine,
  stateLine,
  unreadableLine,
  WRONG_TOKEN_LINE,
} from "../lib/backing-copy";
import { milestoneChoices } from "../lib/backing-records";
import { investingOffered } from "../lib/investing-offered";
import type { Launch } from "../models";
import { useChainSend } from "../use-chain-send";
import {
  BACKING_QUERY,
  useBackingEvents,
  useBackingPool,
} from "../use-backing";
import { useProjectUpdates } from "../use-help-requests";
import { useProjectTasks } from "../use-tasks";
import { BackingActions } from "./BackingActions";
import { FailureNote, WalletStrip } from "./account-widgets";
import { backingFailure } from "../lib/backing-copy";

const PHASE_TONE: Record<PoolPhase, ChipTone> = {
  none: "neutral",
  waiting: "info",
  live: "success",
  failed: "warning",
  abandoned: "danger",
};

/**
 * The block, or nothing. `variant` "page" is the project's own page, with actions for a signed-in person; "scorecard" is
 * the public card, read only.
 */
export function BackingBlock(props: {
  launch: Launch;
  isFounder: boolean;
  variant: "page" | "scorecard";
}) {
  if (!investingOffered()) return null;
  return props.variant === "page" ? (
    <PageBacking isFounder={props.isFounder} launch={props.launch} />
  ) : (
    <ScorecardBacking launch={props.launch} />
  );
}

function ScorecardBacking({ launch }: { launch: Launch }) {
  const pool = useBackingPool(launch.record, null);
  const link = (
    <Button asChild className="max-sm:h-11" size="sm" variant="outline">
      <Link
        params={{ launchId: launch.record.id }}
        search={{ author: launch.record.author }}
        to="/launchpad/$launchId"
      >
        See backing on the project's page
      </Link>
    </Button>
  );
  return (
    <BackingView
      actions={() => <div className="mt-3">{link}</div>}
      isFounder={false}
      launch={launch}
      pool={pool}
      variant="scorecard"
    />
  );
}

function PageBacking({
  launch,
  isFounder,
}: {
  launch: Launch;
  isFounder: boolean;
}) {
  const chain = Number(launch.record.chainId ?? "");
  const sender = useChainSend(
    Number.isInteger(chain) && chain > 0 ? chain : null,
    BACKING_QUERY,
  );
  const pool = useBackingPool(launch.record, sender.wallet.address);
  return (
    <BackingView
      actions={(view) => (
        <BackingActions
          isFounder={isFounder}
          launch={launch}
          sender={sender}
          target={pool.target}
          view={view}
        />
      )}
      footer={
        <>
          <WalletStrip testIdPrefix="backing" wallet={sender.wallet} />
          {sender.failure ? (
            <FailureNote
              failure={backingFailure(sender.failure)}
              testId="backing-failure"
            />
          ) : null}
        </>
      }
      isFounder={isFounder}
      launch={launch}
      noPoolActions={(view) => (
        // With no pool yet the founder's way in is the same actions component, given the factory's side.
        <BackingActions
          isFounder={isFounder}
          launch={launch}
          sender={sender}
          target={pool.target}
          view={view}
        />
      )}
      pool={pool}
      variant="page"
    />
  );
}

function Fact({
  label,
  value,
  testId,
}: {
  label: string;
  value: ReactNode;
  testId: string;
}) {
  return (
    <div className="glass flex min-w-0 flex-col rounded-2xl border p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="break-words text-base font-bold" data-testid={testId}>
        {value}
      </dd>
    </div>
  );
}

/** The card itself: every state of every read, with `actions` given the pool's view once there is one. */
function BackingView({
  launch,
  pool,
  isFounder,
  variant,
  actions,
  noPoolActions,
  footer,
}: {
  launch: Launch;
  pool: ReturnType<typeof useBackingPool>;
  isFounder: boolean;
  variant: "page" | "scorecard";
  actions: (view: PoolView) => ReactNode;
  noPoolActions?: (view: NoPoolView) => ReactNode;
  footer?: ReactNode;
}) {
  const { target, provenance, provenanceFailed, retryProvenance, query } = pool;
  const data = query.data;
  let view: PoolView | null = null;
  let none: NoPoolView | null = null;
  if (data?.kind === "pool") view = data;
  else if (data?.kind === "none") none = data;
  const shell = (children: ReactNode, chip?: ReactNode) => (
    <Card
      className="flex flex-col gap-3 p-4"
      data-testid="backing"
      id="backing"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2
          className="text-base font-semibold"
          id={`backing-heading-${variant}`}
        >
          {BACKING_HEADING}
        </h2>
        {chip}
      </div>
      {children}
    </Card>
  );

  // A project that cannot have backing here says so only where the build offers it and the network lacks it; a project
  // with no shared money (an idea) shows nothing at all, so there is no empty card on every page.
  if (target.kind !== "target") {
    if (target.kind === "not-here" && target.why === "no-factory")
      return shell(
        <p
          className="text-sm text-muted-foreground"
          data-testid="backing-state"
        >
          {notHereLine(target.why)}
        </p>,
      );
    return null;
  }
  if (provenanceFailed)
    return shell(
      <div className="text-sm">
        <p data-testid="backing-unreadable" role="alert">
          {unreadableLine()}
        </p>
        <Button
          className="mt-2 max-sm:h-11"
          onClick={retryProvenance}
          size="sm"
          type="button"
          variant="outline"
        >
          Try again
        </Button>
      </div>,
    );
  if (provenance === "reading")
    return shell(
      <p className="text-sm text-muted-foreground" role="status">
        {READING_LINE}
      </p>,
    );
  if (provenance !== "kit")
    return shell(
      <p className="text-sm" data-testid="backing-state" role="status">
        {NOT_CONFIRMED_LINE}
      </p>,
    );
  if (!data) {
    if (query.isError)
      return shell(
        <div className="text-sm">
          <p data-testid="backing-unreadable" role="alert">
            {unreadableLine()}
          </p>
          <Button
            className="mt-2 max-sm:h-11"
            onClick={() => void query.refetch()}
            size="sm"
            type="button"
            variant="outline"
          >
            Try again
          </Button>
        </div>,
      );
    return shell(
      <p className="text-sm text-muted-foreground" role="status">
        {READING_LINE}
      </p>,
    );
  }

  const stale = query.isError ? (
    <p
      className="text-sm text-muted-foreground"
      data-testid="backing-stale"
      role="status"
    >
      {staleReadLine(query.dataUpdatedAt)}{" "}
      <button
        className="underline max-sm:min-h-11"
        onClick={() => void query.refetch()}
        type="button"
      >
        Try again
      </button>
    </p>
  ) : null;

  if (none) {
    return shell(
      <>
        <p className="text-sm" data-testid="backing-state">
          {stateLine("none", isFounder)}
        </p>
        {stale}
        {variant === "page" && noPoolActions ? noPoolActions(none) : null}
        {footer}
      </>,
      <Chip tone={PHASE_TONE.none}>{PHASE_CHIP.none}</Chip>,
    );
  }
  if (!view) return null;
  return shell(
    <PoolDetails
      actions={actions(view)}
      footer={footer}
      isFounder={isFounder}
      launch={launch}
      stale={stale}
      variant={variant}
      view={view}
    />,
    <Chip data-testid="backing-chip" tone={PHASE_TONE[view.phase]}>
      {PHASE_CHIP[view.phase]}
    </Chip>,
  );
}

function PoolDetails({
  launch,
  view,
  isFounder,
  variant,
  actions,
  footer,
  stale,
}: {
  launch: Launch;
  view: PoolView;
  isFounder: boolean;
  variant: "page" | "scorecard";
  actions: ReactNode;
  footer: ReactNode;
  stale: ReactNode;
}) {
  const { snapshot, quote } = view;
  const events = useBackingEvents(view.pool, Number(launch.record.chainId));
  const totals = events.data ? poolTotals(events.data.events) : null;
  const cut = events.data
    ? cutLine(events.data.cut, events.data.unreadable)
    : null;
  const live = view.phase === "live" || view.phase === "abandoned";
  const next = nextMilestone(snapshot, view.now);
  const fact = nextMilestoneFact(next);
  const position = positionLine(snapshot, quote);
  const held =
    snapshot.holderEscrow > 0n ? money(snapshot.holderEscrow, quote) : "";
  const note = milestoneLine(next, held);
  return (
    <>
      <p className="text-sm" data-testid="backing-state">
        {stateLine(view.phase, isFounder)}
      </p>
      {stale}
      {!view.quoteMatchesFactory ? (
        <p
          className="text-sm text-destructive"
          data-testid="backing-token-mismatch"
          role="alert"
        >
          {WRONG_TOKEN_LINE}
        </p>
      ) : null}
      {live ? (
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Fact
            label="Held for the project"
            testId="backing-held"
            value={money(snapshot.escrow, quote)}
          />
          <Fact
            label="Released to the project"
            testId="backing-released"
            value={money(snapshot.released, quote)}
          />
          <Fact
            label="Paid in so far"
            testId="backing-paid-in"
            value={
              totals
                ? `${events.data?.cut ? "At least " : ""}${money(totals.paidIn, quote)}`
                : events.isError
                  ? "Not known"
                  : "Reading…"
            }
          />
          {view.phase === "live" ? (
            <Fact label={fact.label} testId="backing-next" value={fact.value} />
          ) : null}
        </dl>
      ) : null}
      {cut ? (
        <p
          className="text-xs text-muted-foreground"
          data-testid="backing-cut"
          role="status"
        >
          {cut}
        </p>
      ) : null}
      {events.isError && !events.data ? (
        <p
          className="text-xs text-muted-foreground"
          data-testid="backing-events-failed"
          role="status"
        >
          The history of this project's backing could not be read, so what was
          paid in and the milestones are not shown.{" "}
          <button
            className="underline max-sm:min-h-11"
            onClick={() => void events.refetch()}
            type="button"
          >
            Try again
          </button>
        </p>
      ) : null}
      {view.phase === "live" && note ? (
        <p className="text-sm" data-testid="backing-milestone-note">
          {note}
        </p>
      ) : null}
      {position ? (
        <p className="text-sm" data-testid="backing-position">
          {position}
        </p>
      ) : null}
      {view.phase === "failed" ? null : (
        // Nothing was opened when a round fell short, so there is nothing to sell or leave: the line would promise it.
        <p
          className="text-sm text-muted-foreground"
          data-testid="backing-honest"
        >
          {HONEST_LINE}
        </p>
      )}
      {actions}
      {variant === "page" ? (
        <>
          <Milestones launch={launch} view={view} />
          <Limits />
        </>
      ) : null}
      {footer}
    </>
  );
}

/** What a backer has to read before putting money in: always in the page, never collapsed, next to the actions. */
function Limits() {
  return (
    <div
      className="rounded-lg bg-muted/50 p-3 text-xs"
      data-testid="backing-limits"
    >
      <p className="font-medium">Before you back this project</p>
      <ul className="mt-1 list-disc pl-4">
        {backingLimits().map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  );
}

/** Each milestone the founder posted, with the record it points at and what became of it. */
function Milestones({ launch, view }: { launch: Launch; view: PoolView }) {
  const events = useBackingEvents(view.pool, Number(launch.record.chainId));
  const records: MilestoneRecord[] = useMemo(
    () => (events.data ? milestoneRecords(events.data.events) : []),
    [events.data],
  );
  if (!events.data || records.length === 0) return null;
  return (
    <MilestoneList
      launch={launch}
      posted={events.data.events}
      records={records}
      times={events.data.times}
      view={view}
    />
  );
}

/**
 * The list itself. It reads the project's own records only when there is a milestone to show, and shows each milestone
 * with the words of the record it points at; one that names anything else is said to name something this page cannot find
 * among the project's own (the records are read with no cap here, so a real one is never missed for being old).
 */
function MilestoneList({
  launch,
  view,
  records,
  posted,
  times,
}: {
  launch: Launch;
  view: PoolView;
  records: MilestoneRecord[];
  posted: readonly PoolEvent[];
  times: ReadonlyMap<number, number>;
}) {
  const read = useProjectUpdates(launch.record);
  const tasks = useProjectTasks(launch.record);
  const known = useMemo(() => {
    const own = read.data?.founder;
    if (!own) return null;
    return new Map(
      milestoneChoices({
        founder: launch.record.author,
        updates: own.updates,
        goals: own.goals,
        tasks: tasks.tasks,
        now: Math.floor(Date.now() / 1000),
        limit: Number.MAX_SAFE_INTEGER,
      }).map((choice) => [choice.id, choice]),
    );
  }, [read.data, tasks.tasks, launch.record.author]);
  return (
    <section aria-labelledby="backing-milestones-heading" className="text-sm">
      <h3 className="font-medium" id="backing-milestones-heading">
        Milestones so far
      </h3>
      <ol className="mt-1 flex flex-col gap-2" data-testid="backing-milestones">
        {[...records].reverse().map((m) => {
          const choice = known?.get(m.ref.replace(/^0x/, ""));
          const event = posted.find(
            (e) => e.kind === "milestone-posted" && e.id === m.id,
          );
          const at = event ? times.get(event.block) : undefined;
          return (
            <li
              className="glass rounded-2xl border p-3"
              data-testid="backing-milestone"
              key={m.id.toString()}
            >
              <p className="font-medium">
                Milestone {m.id.toString()}
                {at ? ` · posted ${dayWords(at)}` : ""}
              </p>
              <p className="text-muted-foreground">
                {milestoneOutcomeLine(
                  m.outcome,
                  money(m.releasedAmount, view.quote),
                  m.leavers,
                )}
              </p>
              <p className="text-muted-foreground">
                {choice
                  ? `Points at this project's record: ${choice.label}`
                  : known
                    ? "Points at a record this page cannot find among the project's own."
                    : "Reading the record it points at…"}
              </p>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
