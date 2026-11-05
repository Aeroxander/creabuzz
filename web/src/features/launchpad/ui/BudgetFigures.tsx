import { formatAtomic } from "../lib/amounts";
import type { MandateView } from "@creaton/core/launchpad/workRead.ts";
import { Meter } from "@/shared/ui/meter";
import { Person } from "./Face";

const shares = (wei: bigint) => formatAtomic(wei, 18, { maxFractionDigits: 2 });

/**
 * A work budget's figures as tiles: the Shares it has given to work areas (with a bar), its money, how many reviewers
 * must agree and who they are, and the bond each reviewer posts.
 */
export function BudgetFigures({
  mandate,
  money,
  bondMoney,
  labelOf,
}: {
  mandate: MandateView;
  /** The budget's money, written in its currency. */
  money: (units: bigint) => string;
  /** A bond, written in the bond's own token. */
  bondMoney: (units: bigint) => string;
  labelOf: (address: string) => string;
}) {
  const { created } = mandate;
  return (
    <div className="mt-3 grid gap-3 sm:grid-cols-3">
      {created.shareBudget > 0n ? (
        <div className="rounded-xl bg-secondary/60 px-4 py-3">
          <p className="text-xs text-muted-foreground">Shares for work</p>
          <p className="mt-0.5 text-sm" data-testid="work-share-budget">
            <span className="text-lg font-bold tabular-nums">
              {shares(mandate.sharesAllocated)}
            </span>{" "}
            of {shares(created.shareBudget)} allocated to work areas
          </p>
          <Meter
            className="mt-2"
            label="Shares given to work areas"
            max={created.shareBudget}
            value={mandate.sharesAllocated}
          />
        </div>
      ) : null}
      {created.budget > 0n ? (
        <div className="rounded-xl bg-secondary/60 px-4 py-3">
          <p className="text-xs text-muted-foreground">Money for work</p>
          <p className="mt-0.5 text-lg font-bold tabular-nums">
            {money(created.budget)}
          </p>
        </div>
      ) : null}
      <div className="rounded-xl bg-secondary/60 px-4 py-3">
        <p className="text-xs text-muted-foreground">Reviewers</p>
        <p className="mt-0.5 text-sm">
          <span className="text-lg font-bold tabular-nums">
            {mandate.reviewers.length > 0
              ? `${mandate.quorum} of ${mandate.reviewers.length}`
              : mandate.quorum}
          </span>{" "}
          must agree
        </p>
        {mandate.reviewersUnreadable ? (
          <p
            className="mt-2 text-xs text-amber-700 dark:text-amber-300"
            data-testid="work-reviewers-unread"
          >
            Who they are could not be read just now. Press Refresh to try again.
          </p>
        ) : null}
        {mandate.reviewers.length > 0 ? (
          <ul
            className="mt-2 flex flex-col gap-1 text-xs text-muted-foreground"
            data-testid="work-reviewers"
          >
            {mandate.reviewers.map((reviewer) => (
              <li
                className="flex flex-wrap items-center gap-x-1"
                data-testid="work-reviewer"
                key={reviewer.address}
              >
                <Person label={labelOf(reviewer.address)} />
                {mandate.bond
                  ? reviewer.stake === null
                    ? " · bond could not be read"
                    : reviewer.stake >= mandate.bond.minBond
                      ? " · bond put down"
                      : " · bond not put down yet"
                  : ""}
                {reviewer.pending
                  ? ` · ${bondMoney(reviewer.pending.amount)} waiting to be taken back`
                  : ""}
                {reviewer.pendingUnreadable
                  ? " · a bond waiting to be taken back could not be read"
                  : ""}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {/* No bond is the common case: a "None" box would only take room. */}
      {mandate.bond || mandate.bondUnreadable ? (
        <div className="rounded-xl bg-secondary/60 px-4 py-3">
          <p className="text-xs text-muted-foreground">Reviewer bond</p>
          <p className="mt-0.5 text-sm" data-testid="work-bond">
            {mandate.bond
              ? `${bondMoney(mandate.bond.minBond)} each, which the project can take after a disputed approval`
              : "Could not be read. The network did not answer; this is not the same as no bond."}
          </p>
        </div>
      ) : null}
    </div>
  );
}

/** Says once, above the list of work budgets, what a reviewer bond is (shown only when some budget asks for one). */
export function BondNote({ mandates }: { mandates: MandateView[] }) {
  if (!mandates.some((m) => m.bond || m.bondUnreadable)) return null;
  return (
    <p className="text-sm text-muted-foreground" data-testid="work-bond-help">
      A bond is a deposit a reviewer puts down before judging. The project can
      take it if they approve carelessly.
    </p>
  );
}
