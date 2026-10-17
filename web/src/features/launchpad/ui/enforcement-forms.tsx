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
  states,
  none,
  intro,
  label,
  testId,
  make,
}: FormProps & {
  states: readonly string[];
  none: string;
  intro: string;
  label: string;
  testId: string;
  make: (pick: Pick) => ReturnType<typeof freezeClaimDecision>;
}) {
  const options = claimsIn(ctx.work?.mandates ?? [], states);
  const [which, setWhich] = useState("");
  const chosen = options.find((o) => pickKey(o) === which) ?? options[0];
  const result = useMemo<DraftResult>(
    () => (chosen ? attempt(() => make(chosen)) : { problem: none }),
    [chosen, none, make],
  );
  return (
    <div className="mt-3 grid gap-3" data-testid={`form-${testId}`}>
      <p className="text-sm text-muted-foreground">{intro}</p>
      {options.length === 0 ? (
        <p className="text-sm" data-testid={`${testId}-none`}>
          {none}
        </p>
      ) : (
        <SelectField
          label={label}
          onChange={setWhich}
          options={options.map((o) => ({
            value: pickKey(o),
            label: pickLabel(o),
          }))}
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
export function FreezeForm(props: FormProps) {
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
export function UnwindForm(props: FormProps) {
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
  const [which, setWhich] = useState("");
  const chosen = open.find((m) => m.address === which) ?? open[0];
  const result = useMemo<DraftResult>(
    () =>
      chosen
        ? attempt(() => closeBudgetDecision({ mandate: chosen.address }))
        : { problem: "No work budget is open." },
    [chosen],
  );
  return (
    <div className="mt-3 grid gap-3" data-testid="form-close">
      <p className="text-sm text-muted-foreground">
        Close a work budget early. No new claim can be started in it and the
        money not set aside for a claim goes back to the DAO. Claims that are
        already funded keep their own rules. The milestone panel is not offered
        here: closing it would leave the team&apos;s locked Shares with no way
        to unlock.
      </p>
      {open.length === 0 ? (
        <p className="text-sm" data-testid="close-none">
          No work budget is open.
        </p>
      ) : (
        <SelectField
          label="Work budget to close"
          onChange={setWhich}
          options={open.map((m) => ({
            value: m.address,
            label: `${short(m.address)}, open until ${new Date(m.expiresAt * 1000).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })}`,
          }))}
          testId="close-budget"
          value={chosen?.address ?? ""}
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

/** Take some of a reviewer's bond after an approval the DAO disputes; it is paid to the DAO. */
export function SlashForm({ ctx, blocked, busy, gate, onSubmit }: FormProps) {
  const reviewers = (ctx.work?.mandates ?? []).flatMap((mandate) =>
    mandate.bond
      ? mandate.reviewers
          .filter((r) => r.stake !== null && r.stake > 0n)
          .map((reviewer) => ({ mandate, reviewer }))
      : [],
  );
  const key = (r: (typeof reviewers)[number]) =>
    `${r.mandate.address}:${r.reviewer.address}`;
  const [which, setWhich] = useState("");
  const [amount, setAmount] = useState("");
  const chosen = reviewers.find((r) => key(r) === which) ?? reviewers[0];
  const bond = chosen?.mandate.bond ?? null;
  const result = useMemo<DraftResult>(() => {
    if (!chosen || !bond)
      return { problem: "No reviewer holds a bond that could be taken." };
    return attempt(() => {
      const wei = amount.trim()
        ? parseUnits(amount, bond.decimals, "amount", "The amount")
        : 0n;
      const held = chosen.reviewer.stake ?? 0n;
      if (wei > held)
        throw new DecisionInputError(
          "amount",
          `That reviewer holds only ${formatUnits(held, bond.decimals, 4)} ${bond.symbol}.`,
        );
      return slashReviewerDecision({
        mandate: chosen.mandate.address,
        reviewer: chosen.reviewer.address,
        amount: wei,
        bondDecimals: bond.decimals,
        bondSymbol: bond.symbol,
      });
    });
  }, [chosen, bond, amount]);
  return (
    <div className="mt-3 grid gap-3" data-testid="form-slash">
      <p className="text-sm text-muted-foreground">
        Take some of a reviewer&apos;s bond after an approval you dispute. It is
        paid to the DAO, and no more than the reviewer holds can be taken.
      </p>
      {reviewers.length === 0 ? (
        <p className="text-sm" data-testid="slash-none">
          No reviewer holds a bond. A work budget has to ask its reviewers for
          one when it is set up.
        </p>
      ) : (
        <>
          <SelectField
            label="Reviewer"
            onChange={setWhich}
            options={reviewers.map((r) => ({
              value: key(r),
              label: `${short(r.reviewer.address)} in ${budgetName(r.mandate)}, holding ${formatUnits(r.reviewer.stake ?? 0n, r.mandate.bond?.decimals ?? 18, 4)} ${r.mandate.bond?.symbol ?? ""}`,
            }))}
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
