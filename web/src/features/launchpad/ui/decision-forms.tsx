import { useMemo, useState } from "react";

import { Button } from "@/shared/ui/button";
import {
  awardDecision,
  type DecisionDraft,
  DecisionInputError,
  formatUnits,
  mandateDecision,
  parseUnits,
  projectDecision,
} from "../lib/dao-actions";
import { idLabel } from "../lib/work";
import type { WorkSnapshot } from "../lib/work-read";
import { SelectField, TextAreaField, TextField } from "./decision-fields";

/** What the forms need to know about the DAO they compose for. */
export interface FormContext {
  dao: string;
  /** The chain's own clock: expiry dates are counted from it, not from the browser's. */
  chainTime: number;
  wallet: string | null;
  /** The DAO's work budget factory. */
  factory: string;
  /** What claims are paid and staked in. A contract; the Shares themselves when the project sells for nothing else. */
  currency: string;
  /** Decimals of the sale currency, or null when the project has none (then no form offers money). */
  currencyDecimals: number | null;
  work: WorkSnapshot | undefined;
}

export type DraftResult = { draft: DecisionDraft } | { problem: string };

/** Compose a draft from form values; a refusal becomes the sentence to show, anything else is a bug and is rethrown. */
function attempt(make: () => DecisionDraft): DraftResult {
  try {
    return { draft: make() };
  } catch (error) {
    if (error instanceof DecisionInputError) return { problem: error.message };
    throw error;
  }
}

const DAY = 86_400;
const days = (value: string, fallback: number): number => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const names = (text: string) => text.split(/[\s,;]+/).filter(Boolean);

/** The preview of what would be put to a vote, and the button that does it. */
export function DraftPanel({
  result,
  dirty,
  blocked,
  busy,
  gate,
  onSubmit,
}: {
  result: DraftResult;
  /** Whether the person has started filling the form in: a problem is only shown once they have. */
  dirty: boolean;
  /** Why this wallet cannot put a decision to a vote, when it cannot. */
  blocked: string | null;
  busy: string | null;
  gate: string | null;
  onSubmit: (draft: DecisionDraft) => void;
}) {
  const sending = busy === "open-decision";
  return (
    <div
      className="mt-3 rounded-lg border border-black/10 p-3 dark:border-white/10"
      data-testid="decision-draft"
    >
      {"draft" in result ? (
        <>
          <p
            className="text-sm font-semibold"
            data-testid="decision-draft-title"
          >
            {result.draft.title}
          </p>
          <ul className="mt-1 list-disc pl-5 text-sm text-muted-foreground">
            {result.draft.lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted-foreground">
            {result.draft.lane === "unrestricted"
              ? "This changes what the DAO can do or spend, so it takes the full vote."
              : "This is inside a budget the DAO already voted, so it takes the lighter vote."}{" "}
            Nothing happens until holders back it and it runs.
          </p>
          <Button
            aria-busy={sending}
            className="mt-2"
            data-testid="decision-draft-submit"
            disabled={busy !== null || gate !== null || blocked !== null}
            onClick={() => onSubmit(result.draft)}
            size="sm"
            type="button"
          >
            {sending ? "Opening…" : "Put it to a vote"}
          </Button>
        </>
      ) : dirty ? (
        <p
          className="text-sm text-muted-foreground"
          data-testid="decision-draft-problem"
          role="status"
        >
          {result.problem}
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          Fill in the details and you will see exactly what is put to a vote.
        </p>
      )}
      {blocked ? (
        <p
          className="mt-2 text-xs text-red-700 dark:text-red-400"
          data-testid="decision-draft-blocked"
          role="status"
        >
          {blocked}
        </p>
      ) : null}
    </div>
  );
}

interface FormProps {
  ctx: FormContext;
  blocked: string | null;
  busy: string | null;
  gate: string | null;
  onSubmit: (draft: DecisionDraft) => void;
}

const reviewerExample = "0x… (one wallet address per line)";

export function WorkBudgetForm({
  ctx,
  blocked,
  busy,
  gate,
  onSubmit,
}: FormProps) {
  const [shareBudget, setShareBudget] = useState("");
  const [shareCap, setShareCap] = useState("");
  const [money, setMoney] = useState("");
  const [moneyCap, setMoneyCap] = useState("");
  const [open, setOpen] = useState("90");
  const [reviewers, setReviewers] = useState("");
  const [quorum, setQuorum] = useState("");
  const dirty = [
    shareBudget,
    shareCap,
    money,
    moneyCap,
    reviewers,
    quorum,
  ].some((v) => v !== "");

  const result = useMemo<DraftResult>(
    () =>
      attempt(() => {
        const decimals = ctx.currencyDecimals ?? 0;
        const list = names(reviewers);
        return mandateDecision({
          dao: ctx.dao,
          factory: ctx.factory,
          currency: ctx.currency,
          currencyDecimals: decimals,
          budget: money.trim()
            ? parseUnits(money, decimals, "budget", "The money")
            : 0n,
          cap: moneyCap.trim()
            ? parseUnits(moneyCap, decimals, "cap", "The limit per project")
            : 0n,
          shareBudget: shareBudget.trim()
            ? parseUnits(shareBudget, 18, "shareBudget", "The Shares")
            : 0n,
          shareCap: shareCap.trim()
            ? parseUnits(shareCap, 18, "shareCap", "The limit per project")
            : 0n,
          expiresAt: ctx.chainTime + Math.round(days(open, 90) * DAY),
          reviewers: list,
          // Left empty, a simple majority of the reviewers named.
          quorum: quorum.trim()
            ? Number(quorum)
            : Math.floor(list.length / 2) + 1,
          now: ctx.chainTime,
        });
      }),
    [ctx, shareBudget, shareCap, money, moneyCap, open, reviewers, quorum],
  );

  return (
    <div className="mt-3 grid gap-3" data-testid="form-work-budget">
      <p className="text-sm text-muted-foreground">
        Set aside Shares (and, if you want, money) for people to earn by doing
        work. Reviewers you name check each claim; nothing is paid or awarded
        without them.
      </p>
      <TextField
        hint="Shares the DAO may award from this budget, in all."
        inputMode="decimal"
        label="Shares to set aside"
        onChange={setShareBudget}
        placeholder="100000"
        testId="budget-shares"
        value={shareBudget}
      />
      <TextField
        hint="The most Shares any one project can be allowed to award."
        inputMode="decimal"
        label="Most Shares for one project"
        onChange={setShareCap}
        placeholder="25000"
        testId="budget-shares-cap"
        value={shareCap}
      />
      {ctx.currencyDecimals !== null ? (
        <>
          <TextField
            hint="Optional. Money moves from the treasury into the budget now."
            inputMode="decimal"
            label="Money to set aside"
            onChange={setMoney}
            placeholder="0"
            testId="budget-money"
            value={money}
          />
          <TextField
            hint="Needed with money: the most any one project can hold."
            inputMode="decimal"
            label="Most money for one project"
            onChange={setMoneyCap}
            placeholder="0"
            testId="budget-money-cap"
            value={moneyCap}
          />
        </>
      ) : null}
      <TextField
        label="Open for how many days"
        inputMode="numeric"
        onChange={setOpen}
        testId="budget-days"
        value={open}
      />
      <TextAreaField
        hint="People who judge claims. Choose people other than the ones who will claim."
        label="Reviewers"
        onChange={setReviewers}
        placeholder={reviewerExample}
        testId="budget-reviewers"
        value={reviewers}
      />
      <TextField
        hint="Leave empty for a simple majority of the reviewers."
        inputMode="numeric"
        label="How many reviewers must agree on a claim"
        onChange={setQuorum}
        testId="budget-quorum"
        value={quorum}
      />
      <DraftPanel
        blocked={blocked}
        busy={busy}
        dirty={dirty}
        gate={gate}
        onSubmit={onSubmit}
        result={result}
      />
    </div>
  );
}

export function ProjectForm({ ctx, blocked, busy, gate, onSubmit }: FormProps) {
  const budgets = (ctx.work?.mandates ?? []).filter(
    (m) => !m.closed && m.expiresAt > ctx.chainTime,
  );
  const [which, setWhich] = useState("");
  const [name, setName] = useState("");
  const [manager, setManager] = useState("");
  const [shares, setShares] = useState("");
  const [money, setMoney] = useState("");
  const [open, setOpen] = useState("30");
  const [check, setCheck] = useState("");
  const chosen = budgets.find((m) => m.address === which) ?? budgets[0];
  const dirty = [name, manager, shares, money, check].some((v) => v !== "");
  const decimals = chosen?.currency?.decimals ?? ctx.currencyDecimals ?? 0;
  const hasMoney = (chosen?.created.budget ?? 0n) > 0n;

  const result = useMemo<DraftResult>(() => {
    if (!chosen)
      return {
        problem: "There is no open work budget yet. Set one aside first.",
      };
    return attempt(() =>
      projectDecision({
        mandate: chosen.address,
        id: name,
        manager: manager.trim() || ctx.wallet || "",
        amount: money.trim()
          ? parseUnits(money, decimals, "amount", "The money")
          : 0n,
        shares: shares.trim()
          ? parseUnits(shares, 18, "amount", "The Shares")
          : 0n,
        expiresAt: ctx.chainTime + Math.round(days(open, 30) * DAY),
        checkText: check,
        now: ctx.chainTime,
        currencyDecimals: decimals,
      }),
    );
  }, [ctx, chosen, name, manager, shares, money, open, check, decimals]);

  return (
    <div className="mt-3 grid gap-3" data-testid="form-project">
      <p className="text-sm text-muted-foreground">
        Approve a project inside a work budget. Its manager takes on claims; the
        words below are what every claim for it is judged against, exactly.
      </p>
      {budgets.length === 0 ? (
        <p className="text-sm" data-testid="project-no-budget">
          There is no open work budget yet. Set one aside first, then approve
          projects inside it.
        </p>
      ) : (
        <SelectField
          label="Work budget"
          onChange={setWhich}
          options={budgets.map((m) => ({
            value: m.address,
            label: `${m.address.slice(0, 10)}… · ${formatUnits(m.created.shareBudget - m.sharesAllocated, 18)} Shares left`,
          }))}
          testId="project-budget"
          value={chosen?.address ?? ""}
        />
      )}
      <TextField
        hint="A short name, up to 32 characters."
        label="Project name"
        onChange={setName}
        placeholder="docs"
        testId="project-name"
        value={name}
      />
      <TextField
        hint="Leave empty to manage it yourself."
        label="Who manages it (wallet address)"
        onChange={setManager}
        placeholder="0x…"
        testId="project-manager"
        value={manager}
      />
      <TextField
        hint="Most Shares this project may award."
        inputMode="decimal"
        label="Shares for the project"
        onChange={setShares}
        placeholder="1000"
        testId="project-shares"
        value={shares}
      />
      {hasMoney ? (
        <TextField
          inputMode="decimal"
          label="Money for the project"
          onChange={setMoney}
          placeholder="0"
          testId="project-money"
          value={money}
        />
      ) : null}
      <TextField
        inputMode="numeric"
        label="Open for how many days"
        onChange={setOpen}
        testId="project-days"
        value={open}
      />
      <TextAreaField
        hint="Claims for this project must state these exact words, or the manager cannot take them on."
        label="How the work is judged"
        onChange={setCheck}
        placeholder="The docs are merged and reviewed"
        testId="project-check"
        value={check}
      />
      <DraftPanel
        blocked={blocked}
        busy={busy}
        dirty={dirty}
        gate={gate}
        onSubmit={onSubmit}
        result={result}
      />
    </div>
  );
}

export function AwardForm({ ctx, blocked, busy, gate, onSubmit }: FormProps) {
  const awardable = (ctx.work?.mandates ?? []).flatMap((mandate) =>
    mandate.claims
      .filter(
        (c) =>
          c.record.status === "Paid" && c.project !== null && !c.sharesAwarded,
      )
      .map((claim) => ({ mandate, claim })),
  );
  const [which, setWhich] = useState("");
  const [shares, setShares] = useState("");
  const key = (a: (typeof awardable)[number]) =>
    `${a.mandate.address}:${a.claim.id}`;
  const chosen = awardable.find((a) => key(a) === which) ?? awardable[0];
  const project = chosen?.mandate.projects.find(
    (p) => p.id === chosen.claim.project,
  );
  const left = project
    ? project.record.shareBudget - project.record.sharesAwarded
    : null;

  const result = useMemo<DraftResult>(() => {
    if (!chosen)
      return { problem: "No approved claim is waiting for an award." };
    return attempt(() =>
      awardDecision({
        dao: ctx.dao,
        mandate: chosen.mandate.address,
        claimId: chosen.claim.id,
        shares: shares.trim()
          ? parseUnits(shares, 18, "shares", "The Shares")
          : 0n,
      }),
    );
  }, [ctx, chosen, shares]);

  return (
    <div className="mt-3 grid gap-3" data-testid="form-award">
      <p className="text-sm text-muted-foreground">
        Award Shares to someone whose claim the reviewers approved. The work
        budget refuses an award larger than the project has left, however the
        vote goes.
      </p>
      {awardable.length === 0 ? (
        <p className="text-sm" data-testid="award-none">
          No approved claim is waiting for an award. A claim becomes awardable
          once its reviewers approve it, the waiting period has passed, and its
          project's manager has taken it on.
        </p>
      ) : (
        <SelectField
          label="Claim to award"
          onChange={setWhich}
          options={awardable.map((a) => ({
            value: key(a),
            label: `“${idLabel(a.claim.id)}” by ${a.claim.record.contributor.slice(0, 8)}… in project “${a.claim.project ? idLabel(a.claim.project) : ""}”`,
          }))}
          testId="award-claim"
          value={chosen ? key(chosen) : ""}
        />
      )}
      <TextField
        hint={
          left !== null
            ? `The project has ${formatUnits(left, 18)} Shares left to award.`
            : undefined
        }
        inputMode="decimal"
        label="Shares to award"
        onChange={setShares}
        placeholder="500"
        testId="award-shares"
        value={shares}
      />
      <DraftPanel
        blocked={blocked}
        busy={busy}
        dirty={shares !== ""}
        gate={gate}
        onSubmit={onSubmit}
        result={result}
      />
    </div>
  );
}
