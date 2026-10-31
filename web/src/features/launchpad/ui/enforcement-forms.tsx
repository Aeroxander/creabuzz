/**
 * The decisions that hold a work budget to account: stop a payment the DAO doubts, unwind it, take a careless reviewer's
 * bond, or close a budget early. A work budget pays only against reviewed claims, but reviewers can be wrong, and the
 * DAO is the only one that can step in. These are forms for that, so it is a vote and not a hand-built call.
 */

import { useMemo, useState } from "react";

import {
  closeBudgetDecision,
  DecisionInputError,
  formatUnits,
  freezeClaimDecision,
  parseUnits,
  resolveFrozenClaimDecision,
  slashReviewerDecision,
} from "@creaton/core/launchpad/daoActions.ts";
import { closeEffects } from "../lib/close-effects";
import { formatShares } from "../lib/shares-format";
import { slashableReviewers } from "../lib/slashable";
import type { ClaimView } from "@creaton/core/launchpad/work.ts";
import { workTitle } from "../lib/work-titles";
import type { MandateView } from "@creaton/core/launchpad/workRead.ts";
import { SelectField, TextField } from "./decision-fields";
import { useStickyPick } from "./use-sticky-pick";
import { useWalletLabels } from "../use-wallet-labels";
import {
  attempt,
  DraftPanel,
  type DraftResult,
  type FormProps,
} from "./decision-forms";

const until = (seconds: number) =>
  new Date(seconds * 1000).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
/** A budget by when it is open until, never by its contract's address. */
const budgetName = (m: MandateView) =>
  m.isMilestonePanel
    ? "the milestone panel"
    : `the work budget open until ${until(m.expiresAt)}`;

interface Pick {
  mandate: MandateView;
  claim: ClaimView;
}

/** The claims across the DAO's budgets that are in one of these states. */
function claimsIn(mandates: readonly MandateView[], states: readonly string[]) {
  return mandates.flatMap((mandate) =>
    mandate.claims
      .filter((claim) => states.includes(claim.record.status))
      .map((claim): Pick => ({ mandate, claim })),
  );
}

const pickKey = (p: Pick) => `${p.mandate.address}:${p.claim.id}`;
/** A claim by its name and who submitted it; its budget only when the DAO has more than one. */
const pickLabel = (
  p: Pick,
  who: (address: string) => string,
  budgets: number,
) =>
  `${workTitle(p.claim.id)} by ${who(p.claim.record.contributor)}${budgets > 1 ? ` in ${budgetName(p.mandate)}` : ""}`;

function ClaimPickForm({
  ctx,
  blocked,
  busy,
  gate,
  onSubmit,
  initialPick,
  states,
  none,
  intro,
  label,
  testId,
  make,
}: FormProps & {
  /** A claim to have chosen when the form opens (from a claim card), as the pick key. */
  initialPick?: string;
  states: readonly string[];
  none: string;
  intro: string;
  label: string;
  testId: string;
  make: (pick: Pick) => ReturnType<typeof freezeClaimDecision>;
}) {
  const options = claimsIn(ctx.work?.mandates ?? [], states);
  const who = useWalletLabels(options.map((o) => o.claim.record.contributor));
  const budgets = ctx.work?.mandates.length ?? 0;
  // A claim the person came here for, or was first shown, that is no longer eligible is never swapped for another one.
  const { pick, select: setSelected } = useStickyPick(
    options.map(pickKey),
    initialPick ?? null,
  );
  const chosen = pick.key
    ? options.find((o) => pickKey(o) === pick.key)
    : undefined;
  const result = useMemo<DraftResult>(
    () =>
      chosen
        ? attempt(() => make(chosen))
        : {
            problem: pick.gone
              ? "That submission is no longer open to this. Choose which one you mean."
              : none,
          },
    [chosen, pick.gone, none, make],
  );
  return (
    <div className="mt-3 grid gap-3" data-testid={`form-${testId}`}>
      <p className="text-sm text-muted-foreground">{intro}</p>
      {pick.gone ? (
        <p
          className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100"
          data-testid={`${testId}-gone`}
          role="status"
        >
          The submission you chose is no longer open to this. It may have been
          paid, frozen or closed since you looked.
          {options.length > 0 ? " Choose the one you mean below." : ""}
        </p>
      ) : null}
      {options.length === 0 ? (
        <p className="text-sm" data-testid={`${testId}-none`}>
          {none}
        </p>
      ) : (
        <SelectField
          label={label}
          onChange={setSelected}
          options={[
            ...(chosen ? [] : [{ value: "", label: "Choose a submission…" }]),
            ...options.map((o) => ({
              value: pickKey(o),
              label: pickLabel(o, who, budgets),
            })),
          ]}
          testId={`${testId}-claim`}
          value={chosen ? pickKey(chosen) : ""}
        />
      )}
      <DraftPanel
        blocked={blocked}
        busy={busy}
        dirty
        gate={gate}
        onSubmit={onSubmit}
        result={result}
      />
    </div>
  );
}

/** Stop a payment the DAO doubts: nothing is paid for the claim, and no Shares are unlocked by it, until it is unwound. */
export function FreezeForm(props: FormProps & { initialPick?: string }) {
  const make = useMemo(
    () => (p: Pick) =>
      freezeClaimDecision({ mandate: p.mandate.address, claimId: p.claim.id }),
    [],
  );
  return (
    <ClaimPickForm
      {...props}
      intro={
        props.ctx.contributor
          ? "Hold back work you doubt. While it is frozen, no Shares can be awarded for it. A later vote can reject it for good."
          : "Hold back work you doubt. Nothing is paid or awarded for it while it is frozen. A later vote can reject it for good."
      }
      label="Submission to freeze"
      make={make}
      none="Nothing is open to freeze. Only work that is still being reviewed, or approved and waiting out its challenge window, can be frozen."
      states={["Open", "Approved"]}
      testId="freeze"
    />
  );
}

/**
 * Unwind a frozen submission: it ends for good, so nothing is awarded for it. Where money was set aside, it returns to the
 * budget and the deposit to the person who submitted.
 */
export function UnwindForm(props: FormProps & { initialPick?: string }) {
  const make = useMemo(
    () => (p: Pick) =>
      resolveFrozenClaimDecision({
        mandate: p.mandate.address,
        claimId: p.claim.id,
      }),
    [],
  );
  return (
    <ClaimPickForm
      {...props}
      intro={
        props.ctx.contributor
          ? "End a frozen submission for good: nothing is awarded for it, now or later."
          : "Reject a frozen submission. It ends for good: the money set aside for it goes back to the work budget and the deposit goes back to the person who submitted it. Nothing is taken from anyone."
      }
      label="Frozen submission to reject"
      make={make}
      none="No submission is frozen."
      states={["Frozen"]}
      testId="unwind"
    />
  );
}

/** Close a work budget early: no new claims, and its unused money goes back to the DAO. */
export function CloseBudgetForm({
  ctx,
  blocked,
  busy,
  gate,
  onSubmit,
}: FormProps) {
  // The milestone panel is not offered: closing it would leave the team's locked Shares with no way to unlock.
  const open = (ctx.work?.mandates ?? []).filter(
    (m) => !m.closed && !m.isMilestonePanel,
  );
  const { pick, select: setSelected } = useStickyPick(
    open.map((m) => m.address),
    null,
  );
  const chosen = pick.key
    ? open.find((m) => m.address === pick.key)
    : undefined;
  const effects = chosen ? closeEffects(chosen) : null;
  const result = useMemo<DraftResult>(
    () =>
      chosen
        ? attempt(() =>
            closeBudgetDecision({
              mandate: chosen.address,
              // A contributor project's budgets hold Shares only: the money lines would describe nothing.
              sharesOnly: ctx.contributor,
            }),
          )
        : {
            problem: pick.gone
              ? "That work budget is no longer open. Choose which one you mean."
              : "No work budget is open.",
          },
    [chosen, pick.gone, ctx.contributor],
  );
  return (
    <div className="mt-3 grid gap-3" data-testid="form-close">
      <p className="text-sm text-muted-foreground">
        {ctx.contributor
          ? "Close a work budget early. No new work can be submitted in it, and no more Shares can be awarded through it."
          : "Close a work budget early. No new work can be submitted in it and the money not set aside for a submission goes back to the DAO. Submissions whose money is already set aside keep their own payment rules. The milestone panel is not offered here: closing it would leave the team's locked Shares with no way to unlock."}
      </p>
      {pick.gone ? (
        <p
          className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100"
          data-testid="close-gone"
          role="status"
        >
          The work budget you chose is no longer open.
          {open.length > 0 ? " Choose the one you mean below." : ""}
        </p>
      ) : null}
      {open.length === 0 ? (
        <p className="text-sm" data-testid="close-none">
          No work budget is open.
        </p>
      ) : (
        <SelectField
          label="Work budget to close"
          onChange={setSelected}
          options={[
            ...(chosen ? [] : [{ value: "", label: "Choose a work budget…" }]),
            ...open.map((m) => ({
              value: m.address,
              label: budgetName(m).replace(/^the w/, "W"),
            })),
          ]}
          testId="close-budget"
          value={chosen?.address ?? ""}
        />
      )}
      {effects &&
      (effects.awardsLost > 0 ||
        effects.allowanceLost > 0n ||
        effects.unallocatedLost > 0n) ? (
        <div
          className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100"
          data-testid="close-effects"
          role="note"
        >
          <p className="font-medium">
            Closing also ends this budget&apos;s Shares for work.
          </p>
          <p className="mt-1">
            {effects.awardsLost > 0
              ? `${effects.awardsLost} ${effects.awardsLost === 1 ? "submission that was" : "submissions that were"} approved and paid ${effects.awardsLost === 1 ? "is" : "are"} still waiting for a Shares award, and can no longer be awarded. `
              : ""}
            {effects.allowanceLost > 0n || effects.unallocatedLost > 0n
              ? `Closing gives up ${formatShares(effects.allowanceLost + effects.unallocatedLost)} Shares: ${formatShares(effects.allowanceLost)} left in its work areas and ${formatShares(effects.unallocatedLost)} not yet given to any work area. `
              : ""}
            {effects.incomplete
              ? "This budget has more history than the page reads, so there may be more. "
              : ""}
            If that work should earn Shares, put the awards to a vote first.
          </p>
        </div>
      ) : null}
      <DraftPanel
        blocked={blocked}
        busy={busy}
        dirty
        gate={gate}
        onSubmit={onSubmit}
        result={result}
      />
    </div>
  );
}

/** Take some of a reviewer's bond after an approval the DAO disputes; it is paid to the DAO. */
export function SlashForm({ ctx, blocked, busy, gate, onSubmit }: FormProps) {
  // The bond a reviewer asked back stays slashable until they take it, so it counts beside their active stake.
  const {
    entries: reviewers,
    unreadableBudgets,
    unscaledBudgets,
  } = slashableReviewers(ctx.work?.mandates ?? []);
  const key = (r: (typeof reviewers)[number]) =>
    `${r.mandate.address}:${r.reviewer.address}`;
  const nameOf = useWalletLabels(reviewers.map((r) => r.reviewer.address));
  const [amount, setAmount] = useState("");
  const { pick, select } = useStickyPick(reviewers.map(key), null);
  // An amount typed for one reviewer is not carried to another: choosing again starts the amount again.
  const setSelected = (value: string) => {
    select(value);
    setAmount("");
  };
  const chosen = pick.key
    ? reviewers.find((r) => key(r) === pick.key)
    : undefined;
  const bond = chosen?.mandate.bond ?? null;
  const result = useMemo<DraftResult>(() => {
    if (!chosen || !bond)
      return {
        problem: pick.gone
          ? "That reviewer no longer holds a bond that could be taken. Choose which one you mean."
          : "No reviewer holds a bond that could be taken.",
      };
    return attempt(() => {
      const wei = amount.trim()
        ? parseUnits(amount, bond.decimals, "amount", "The amount")
        : 0n;
      if (wei > chosen.total)
        throw new DecisionInputError(
          "amount",
          `That reviewer holds only ${formatUnits(chosen.total, bond.decimals, 4)} ${bond.symbol}${chosen.waiting > 0n ? ", counting the part they are waiting to take back" : ""}.`,
        );
      return slashReviewerDecision({
        mandate: chosen.mandate.address,
        reviewer: chosen.reviewer.address,
        amount: wei,
        bondDecimals: bond.decimals,
        bondSymbol: bond.symbol,
      });
    });
  }, [chosen, bond, amount, pick.gone]);
  const held = (r: (typeof reviewers)[number]) => {
    const b = r.mandate.bond;
    if (!b) return "";
    const fmt = (v: bigint) => `${formatUnits(v, b.decimals, 4)} ${b.symbol}`;
    return [
      r.active > 0n || r.waiting === 0n ? fmt(r.active) : null,
      r.waiting > 0n
        ? `${fmt(r.waiting)} waiting to be taken back${r.waitingUntil ? ` until ${new Date(r.waitingUntil * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : ""}`
        : null,
      r.waitingUnreadable ? "a waiting amount that could not be read" : null,
    ]
      .filter(Boolean)
      .join(" + ");
  };
  return (
    <div className="mt-3 grid gap-3" data-testid="form-slash">
      <p className="text-sm text-muted-foreground">
        Take some of a reviewer&apos;s bond after an approval you dispute. It is
        paid to the DAO. This includes bond a reviewer has asked to take back
        but has not received yet: it stays at risk until they do. No more than
        the reviewer holds can be taken.
      </p>
      {unreadableBudgets > 0 ? (
        <p
          className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100"
          data-testid="slash-unreadable"
          role="status"
        >
          {unreadableBudgets === 1
            ? "One work budget's bond could not be read, so its reviewers are not listed."
            : `${unreadableBudgets} work budgets' bonds could not be read, so their reviewers are not listed.`}{" "}
          Reload the page to try again.
        </p>
      ) : null}
      {unscaledBudgets > 0 ? (
        <p
          className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100"
          data-testid="slash-unscaled"
          role="status"
        >
          {unscaledBudgets === 1
            ? "One work budget's bond token did not say how many decimals it has, so an amount cannot be typed for its reviewers safely."
            : `${unscaledBudgets} work budgets' bond tokens did not say how many decimals they have, so amounts cannot be typed for their reviewers safely.`}{" "}
          Reload the page to try again.
        </p>
      ) : null}
      {reviewers.length === 0 ? (
        <p className="text-sm" data-testid="slash-none">
          No reviewer holds a bond. A work budget has to ask its reviewers for
          one when it is set up.
        </p>
      ) : (
        <>
          <SelectField
            label="Reviewer"
            onChange={setSelected}
            options={[
              ...(chosen ? [] : [{ value: "", label: "Choose a reviewer…" }]),
              ...reviewers.map((r) => ({
                value: key(r),
                label: `${nameOf(r.reviewer.address)} in ${budgetName(r.mandate)}, holding ${held(r)}`,
              })),
            ]}
            testId="slash-reviewer"
            value={chosen ? key(chosen) : ""}
          />
          <TextField
            inputMode="decimal"
            label={`Amount to take (${bond?.symbol ?? ""})`}
            onChange={setAmount}
            placeholder="0"
            testId="slash-amount"
            value={amount}
          />
        </>
      )}
      <DraftPanel
        blocked={blocked}
        busy={busy}
        dirty={amount !== ""}
        gate={gate}
        onSubmit={onSubmit}
        result={result}
      />
    </div>
  );
}
