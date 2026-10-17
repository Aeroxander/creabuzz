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
} from "../lib/dao-actions";
import { closeEffects } from "../lib/close-effects";
import { resolvePick } from "../lib/claim-pick";
import { formatShares } from "../lib/shares-format";
import { slashableReviewers } from "../lib/slashable";
import { type ClaimView, idLabel } from "../lib/work";
import type { MandateView } from "../lib/work-read";
import { SelectField, TextField } from "./decision-fields";
import {
  attempt,
  DraftPanel,
  type DraftResult,
  type FormProps,
} from "./decision-forms";

const short = (address: string) => `${address.slice(0, 8)}…`;
const budgetName = (m: MandateView) =>
  m.isMilestonePanel
    ? "the milestone panel"
    : `the work budget ${short(m.address)}`;

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
const pickLabel = (p: Pick) =>
  `“${idLabel(p.claim.id)}” by ${short(p.claim.record.contributor)} in ${budgetName(p.mandate)}`;

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
  const [selected, setSelected] = useState("");
  // A claim the person came here for, or picked, that is no longer eligible is never swapped for another one.
  const pick = resolvePick(options.map(pickKey), initialPick ?? null, selected);
  const chosen = pick.key
    ? options.find((o) => pickKey(o) === pick.key)
    : undefined;
  const result = useMemo<DraftResult>(
    () =>
      chosen
        ? attempt(() => make(chosen))
        : {
            problem: pick.gone
              ? "That claim is no longer open to this. Choose which claim you mean."
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
          The claim you chose is no longer open to this. It may have been paid,
          frozen or closed since you looked.
          {options.length > 0 ? " Choose the claim you mean below." : ""}
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
            ...(chosen ? [] : [{ value: "", label: "Choose a claim…" }]),
            ...options.map((o) => ({ value: pickKey(o), label: pickLabel(o) })),
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
      intro="Freeze a claim you doubt. Nothing is paid for it and no Shares are unlocked by it while it is frozen. A freeze is not a verdict: a later decision unwinds it, and nobody's money is taken."
      label="Claim to freeze"
      make={make}
      none="No claim is open to freeze. Only a claim that is still being reviewed, or approved and waiting out its challenge window, can be frozen."
      states={["Open", "Approved"]}
      testId="freeze"
    />
  );
}

/** Unwind a frozen claim: the money reserved for it returns to the budget, and the contributor's deposit to them. */
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
      intro="Unwind a frozen claim. The money set aside for it goes back to the work budget and the contributor's deposit goes back to them. Nothing is taken from anyone."
      label="Frozen claim to unwind"
      make={make}
      none="No claim is frozen."
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
  const [selected, setSelected] = useState("");
  const pick = resolvePick(
    open.map((m) => m.address),
    null,
    selected,
  );
  const chosen = pick.key
    ? open.find((m) => m.address === pick.key)
    : undefined;
  const effects = chosen ? closeEffects(chosen) : null;
  const result = useMemo<DraftResult>(
    () =>
      chosen
        ? attempt(() => closeBudgetDecision({ mandate: chosen.address }))
        : {
            problem: pick.gone
              ? "That work budget is no longer open. Choose which one you mean."
              : "No work budget is open.",
          },
    [chosen, pick.gone],
  );
  return (
    <div className="mt-3 grid gap-3" data-testid="form-close">
      <p className="text-sm text-muted-foreground">
        Close a work budget early. No new claim can be started in it and the
        money not set aside for a claim goes back to the DAO. Claims whose money
        is already set aside keep their own payment rules. The milestone panel
        is not offered here: closing it would leave the team&apos;s locked
        Shares with no way to unlock.
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
              label: `${short(m.address)}, open until ${new Date(m.expiresAt * 1000).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })}`,
            })),
          ]}
          testId="close-budget"
          value={chosen?.address ?? ""}
        />
      )}
      {effects && (effects.awardsLost > 0 || effects.allowanceLost > 0n) ? (
        <div
          className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100"
          data-testid="close-effects"
          role="note"
        >
          <p className="font-medium">
            Closing also ends this budget&apos;s Shares allowance.
          </p>
          <p className="mt-1">
            {effects.awardsLost > 0
              ? `${effects.awardsLost} ${effects.awardsLost === 1 ? "claim that was" : "claims that were"} approved and paid ${effects.awardsLost === 1 ? "is" : "are"} still waiting for a Shares award, and can no longer be awarded. `
              : ""}
            {effects.allowanceLost > 0n
              ? `${formatShares(effects.allowanceLost)} Shares of allowance would go unused. `
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
  const { entries: reviewers, unreadableBudgets } = slashableReviewers(
    ctx.work?.mandates ?? [],
  );
  const key = (r: (typeof reviewers)[number]) =>
    `${r.mandate.address}:${r.reviewer.address}`;
  const [selected, setSelected] = useState("");
  const [amount, setAmount] = useState("");
  const pick = resolvePick(reviewers.map(key), null, selected);
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
                label: `${short(r.reviewer.address)} in ${budgetName(r.mandate)}, holding ${held(r)}`,
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
