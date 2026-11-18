import { readFailureWords } from "@creaton/core/client/readable-error.ts";
import { Banknote } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import { EmptyState } from "../../ui/empty-state";
import {
  dayText,
  dollarsText,
  openRound,
  type ProjectNumbers,
  projectPriceText,
  type RemovedNumbers,
  type RoundNumbers,
  roundState,
  STAGE_LABEL,
  sharesPerDollar,
  sharesText,
  timeText,
} from "./numbers";

/** The one sentence that goes wherever money is offered, word for word. */
const OWNERSHIP_LINE =
  "Buyers acquire ownership only: governance and exit. No dividends or revenue share, ever, unless they contribute and earn one.";

export function OwnershipLine({ className }: { className?: string }) {
  return (
    <p className={className ?? "text-sm text-muted"} data-testid="ownership">
      {OWNERSHIP_LINE}
    </p>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="text-right font-semibold">{children}</dd>
    </div>
  );
}

/** "1 dollar buys 3,000 Shares (333,333.33 for the whole project)". */
export function priceLine(
  round: Pick<RoundNumbers, "sharesPerRawDollar" | "projectPrice">,
) {
  const whole = projectPriceText(round.projectPrice);
  return `1 dollar buys ${sharesPerDollar(round.sharesPerRawDollar)} Shares${whole ? ` (${whole} for the whole project)` : ""}`;
}

/** One round in the list: taking asks, past its 24 hours and waiting for someone to close it, or closed. */
function roundLine(round: RoundNumbers, now: number): string {
  const state = roundState(round, now);
  if (state === "open") return `open until ${timeText(round.closesAt)}`;
  if (state === "waiting")
    return `stopped taking asks ${timeText(round.closesAt)}; waiting to be closed`;
  return `closed ${dayText(round.closesAt)}: ${dollarsText(round.accepted ?? 0n)} dollars from ${round.backers} ${round.backers === 1 ? "backer" : "backers"}`;
}

/** The Money tab: where the project stands in money, from the server's reading of the chain. */
export function MoneyTab({
  numbers,
  loading,
  error,
  onRetry,
  now,
}: {
  numbers: ProjectNumbers | RemovedNumbers | null | undefined;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  now: number;
}) {
  if (loading) return <Card className="h-40 animate-pulse" />;
  if (error)
    return (
      <EmptyState
        action={
          <Button onClick={onRetry} variant="secondary">
            Try again
          </Button>
        }
        title="The numbers could not be read"
      >
        {readFailureWords(error).text}
      </EmptyState>
    );
  if (!numbers || numbers.removed)
    return (
      <EmptyState
        icon={<Banknote size={28} />}
        testId="money-none"
        title={
          numbers?.removed ? "Not on the network any more" : "No backing yet"
        }
      >
        <p>
          {numbers?.removed
            ? "This project's launch left the network, so it has no rounds to show."
            : "This project has not opened a backing round. When it does, the round, what was paid in and what can be taken back show here."}
        </p>
        <OwnershipLine className="mt-3 text-sm text-muted" />
      </EmptyState>
    );
  const open = openRound(numbers, now);
  const heldTotal = numbers.holders.reduce((sum, h) => sum + h.held, 0n);
  const percent =
    numbers.raised.cap > 0n
      ? Number((numbers.raised.total * 100n) / numbers.raised.cap)
      : 0;
  return (
    <div className="flex flex-col gap-3" data-testid="money-tab">
      <Card>
        <dl>
          <Row label="Stage">
            {STAGE_LABEL[numbers.stage.name]}
            {numbers.stage.since ? (
              <span className="font-normal text-muted">
                {" "}
                since {dayText(numbers.stage.since)}
              </span>
            ) : null}
          </Row>
          {numbers.eligible ? (
            <Row label="Eligible for">
              {STAGE_LABEL[numbers.eligible.for]}
              <span className="font-normal text-muted">
                {" "}
                since {dayText(numbers.eligible.since)}
              </span>
            </Row>
          ) : null}
        </dl>
        <div className="mt-3 flex flex-col gap-1.5" data-testid="money-raised">
          <p className="text-sm">
            <span className="num font-semibold">
              {dollarsText(numbers.raised.total)}
            </span>{" "}
            of <span className="num">{dollarsText(numbers.raised.cap)}</span>{" "}
            dollars raised at this stage
          </p>
          <div
            aria-hidden="true"
            className="h-2 overflow-hidden rounded-full bg-white/18"
          >
            <div
              className="h-full rounded-full bg-mint"
              style={{ width: `${Math.min(100, percent)}%` }}
            />
          </div>
          <p className="text-xs text-muted">
            {dollarsText(numbers.raised.left)} dollars left under this stage's
            limit.
          </p>
        </div>
      </Card>

      {open ? (
        <Card data-testid="money-open-round">
          <p className="font-semibold">
            Round {open.round} is open until {timeText(open.closesAt)}
          </p>
          <p className="mt-1 text-sm text-muted">{priceLine(open)}.</p>
          <p className="mt-1 text-sm text-muted">
            <span className="num">{dollarsText(open.asked)}</span> dollars asked
            by {open.backers} {open.backers === 1 ? "backer" : "backers"} so
            far, of <span className="num">{dollarsText(open.size)}</span>.
          </p>
        </Card>
      ) : null}

      {numbers.rounds.length > 0 ? (
        <Card>
          <h3 className="font-semibold">Rounds</h3>
          <ul className="mt-2 flex flex-col gap-2" data-testid="money-rounds">
            {numbers.rounds.map((round) => (
              <li className="text-sm" key={round.round}>
                <span className="font-semibold">Round {round.round}</span>{" "}
                <span className="text-muted">
                  {roundLine(round, now)}
                  {round.acceptedPercent
                    ? `, ${round.acceptedPercent}% of each ask taken`
                    : ""}
                </span>
                <br />
                <span className="text-muted">{priceLine(round)}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card data-testid="money-held">
        <h3 className="font-semibold">Shares already held</h3>
        <p className="mt-1 text-sm text-muted">
          {/* holderCount is the full count; only the list (and so the sum) may be cut. */}
          {numbers.holders.length < numbers.holderCount ? "At least " : ""}
          <span className="num">{sharesText(heldTotal)}</span> Shares are held
          for {numbers.holderCount}{" "}
          {numbers.holderCount === 1 ? "account" : "accounts"}. Held Shares are
          released evenly over 365 days from the day a market opens; until then
          they cannot be sent or sold.
        </p>
      </Card>

      <Card data-testid="money-clock">
        {numbers.clock.woundDown ? (
          <p className="text-sm">
            This project wound down. Payments stopped for good; backers can take
            their unpaid money back.
          </p>
        ) : numbers.now.quietSince ? (
          <p className="text-sm">
            Quiet since {dayText(numbers.now.quietSince)}. Payments to the
            project wait until the founder checks in again.
          </p>
        ) : numbers.clock.lastCheckIn ? (
          <p className="text-sm">
            Last check-in {dayText(numbers.clock.lastCheckIn)}. Payments run
            until{" "}
            {numbers.clock.runsUntil
              ? dayText(numbers.clock.runsUntil)
              : "the next check-in"}
            .
          </p>
        ) : (
          <p className="text-sm">No check-in yet.</p>
        )}
        <p className="mt-2 text-xs text-muted">
          As of {timeText(numbers.asOf.time)}. The network decides the exact
          amounts when you act.
        </p>
      </Card>

      <OwnershipLine />
    </div>
  );
}
