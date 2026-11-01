import { useQuery } from "@tanstack/react-query";
import { useWalletLabels } from "../use-wallet-labels";
import type { SponsorIntent } from "../lib/sponsor";
import { useMemo, useState } from "react";
import { PaymentRecipientPicker } from "@/features/identity/ui/PaymentRecipientPicker";

import { Button } from "@/shared/ui/button";
import { ethCall, getRpcEndpoint } from "../chain";
import {
  awardDecision,
  type DecisionDraft,
  DecisionInputError,
  formatUnits,
  parseUnits,
  payDecision,
  projectDecision,
} from "@creaton/core/launchpad/daoActions.ts";
import { decodeWord } from "@creaton/core/launchpad/work.ts";
import { readableQuotes, workTitle } from "../lib/work-titles";

/** The work area name's rule, said the same way as the check that refuses a longer one. */
const WORK_AREA_NAME_HINT = "A short name, up to 32 characters.";
import type { WorkSnapshot } from "@creaton/core/launchpad/workRead.ts";
import type { DecisionsSnapshot } from "@creaton/core/launchpad/decisions.ts";
import {
  awardsUnderVote,
  waitingToFinish,
  waitingToFinishText,
} from "../lib/dao-overview";
import { useAllowance } from "./AllowanceNote";
import {
  PeoplePicker,
  SelectField,
  TextAreaField,
  TextField,
} from "./decision-fields";

/** What the forms need to know about the DAO they compose for. */
export interface FormContext {
  dao: string;
  /** Network of this project's treasury, used to scope verified payment identities. */
  chainId?: number;
  /** The chain's own clock: expiry dates are counted from it, not from the browser's. */
  chainTime: number;
  wallet: string | null;
  /** The DAO's work budget factory. */
  factory: string;
  /** What claims are paid and staked in. A contract; the Shares themselves when the project sells for nothing else. */
  currency: string;
  /** Decimals of the sale currency, or null when the project has none (then no form offers money). */
  currencyDecimals: number | null;
  currencySymbol: string;
  work: WorkSnapshot | undefined;
  /** The DAO's decisions as read, so a form does not offer what an open vote already does. */
  decisions?: DecisionsSnapshot;
  /** Why the work budgets could not be read, when they could not; null while they are still being read. */
  workError?: string | null;
  /** The DAO's voting policy and its Shares. */
  policy: string;
  sharesToken: string;
  /** The funding-terms contract of the DAO's summoner (D133), or null where it has none. */
  fundingTerms?: string | null;
  /** The exact words of each of the team's milestones, in order (empty when the team's Shares are not locked). */
  milestoneWords: readonly string[];
  /** A contributor project: no sale, Shares-only work, so the forms speak of submissions, not money (D111). */
  contributor?: boolean;
}

export type DraftResult = { draft: DecisionDraft } | { problem: string };

/** Compose a draft from form values; a refusal becomes the sentence to show, anything else is a bug and is rethrown. */
export function attempt(make: () => DecisionDraft): DraftResult {
  try {
    return { draft: make() };
  } catch (error) {
    if (error instanceof DecisionInputError) return { problem: error.message };
    throw error;
  }
}

/** A day, from unix seconds, the way the Work tab writes it. */
const day = (seconds: number) =>
  new Date(seconds * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

/** A work budget by what it holds and until when, never by its contract's address. */
function budgetName(m: {
  created: { shareBudget: bigint };
  sharesAllocated: bigint;
  expiresAt: number;
}): string {
  const until = day(m.expiresAt);
  return `Work budget · ${formatUnits(m.created.shareBudget - m.sharesAllocated, 18)} Shares not yet in a work area · open until ${until}`;
}

export const DAY = 86_400;
export const days = (value: string, fallback: number): number => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
export const names = (text: string) => text.split(/[\s,;]+/).filter(Boolean);

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
            {readableQuotes(result.draft.title)}
          </p>
          <ul className="mt-1 list-disc pl-5 text-sm text-muted-foreground">
            {result.draft.lines.map((line) => (
              <li key={line}>{readableQuotes(line)}</li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted-foreground">
            {result.draft.lane === "unrestricted"
              ? "This changes what the DAO can do or spend, so it takes the full vote."
              : "This is inside a budget the DAO already voted, so it takes the lighter vote."}{" "}
            Nothing happens until holders back it and it takes effect.
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
      ) : (
        // What is still missing, named: the first thing the form refuses, not a general "fill it in".
        <p
          className="text-sm text-muted-foreground"
          data-testid={
            dirty ? "decision-draft-problem" : "decision-draft-missing"
          }
          role="status"
        >
          {dirty ? result.problem : `Still needed: ${result.problem}`}
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

export interface FormProps {
  ctx: FormContext;
  blocked: string | null;
  busy: string | null;
  gate: string | null;
  onSubmit: (draft: DecisionDraft) => void;
}

export function ProjectForm({
  ctx,
  blocked,
  busy,
  gate,
  onSubmit,
  preset,
}: FormProps & {
  /** A suggestion being put to a vote (D84): its name, Shares and check, typed in already. */
  preset?: SponsorIntent;
}) {
  // The milestone panel is listed last: a project is usually for ordinary work, and the panel is only for milestones.
  const openBudgets = (ctx.work?.mandates ?? []).filter(
    (m) => !m.closed && m.expiresAt > ctx.chainTime,
  );
  const budgets = [
    ...openBudgets.filter((m) => !m.isMilestonePanel),
    ...openBudgets.filter((m) => m.isMilestonePanel),
  ];
  const [which, setWhich] = useState("");
  const [name, setName] = useState(preset?.name ?? "");
  const [manager, setManager] = useState("");
  // The manager picked or pasted, by name where this server knows one.
  const managerKeys = useMemo(
    () => (/^0x[0-9a-fA-F]{40}$/.test(manager.trim()) ? [manager.trim()] : []),
    [manager],
  );
  const managerName = useWalletLabels(managerKeys);
  const [shares, setShares] = useState(preset?.shares ?? "");
  const [money, setMoney] = useState("");
  const [open, setOpen] = useState("30");
  const [check, setCheck] = useState(preset?.check ?? "");
  const chosen = budgets.find((m) => m.address === which) ?? budgets[0];
  // The DAO's milestone panel holds nothing: a project in it only lets one of the team's milestones be judged, and its
  // words are the milestone's own, picked rather than typed.
  const isMilestonePanel =
    chosen !== undefined &&
    ctx.work?.milestonePanel === chosen.address.toLowerCase();
  const [milestone, setMilestone] = useState("0");
  const milestoneIndex = Math.min(
    Math.max(Number(milestone) || 0, 0),
    Math.max(ctx.milestoneWords.length - 1, 0),
  );
  const dirty = [name, manager, shares, money, check].some((v) => v !== "");
  const decimals = chosen?.currency?.decimals ?? ctx.currencyDecimals ?? 0;
  const hasMoney = (chosen?.created.budget ?? 0n) > 0n;

  const result = useMemo<DraftResult>(() => {
    if (!chosen)
      return {
        problem: "There is no open work budget yet. Set one aside first.",
      };
    if (isMilestonePanel && ctx.milestoneWords.length === 0)
      return {
        problem: "This project has no milestones to judge.",
      };
    // A currency that did not say how many decimals it has cannot have an amount typed against it.
    if (
      !isMilestonePanel &&
      money.trim() &&
      chosen.currency &&
      !chosen.currency.decimalsKnown
    )
      return {
        problem:
          "This work budget's currency could not be read just now, so an amount cannot be typed in safely. Reload the page and try again.",
      };
    return attempt(() =>
      projectDecision({
        mandate: chosen.address,
        id: isMilestonePanel ? name || `milestone-${milestoneIndex + 1}` : name,
        manager: manager.trim() || ctx.wallet || "",
        amount:
          !isMilestonePanel && money.trim()
            ? parseUnits(money, decimals, "amount", "The money")
            : 0n,
        shares:
          !isMilestonePanel && shares.trim()
            ? parseUnits(shares, 18, "amount", "The Shares")
            : 0n,
        expiresAt: ctx.chainTime + Math.round(days(open, 30) * DAY),
        checkText: isMilestonePanel
          ? (ctx.milestoneWords[milestoneIndex] ?? "")
          : check,
        now: ctx.chainTime,
        currencyDecimals: decimals,
        milestone: isMilestonePanel,
      }),
    );
  }, [
    ctx,
    chosen,
    isMilestonePanel,
    milestoneIndex,
    name,
    manager,
    shares,
    money,
    open,
    check,
    decimals,
  ]);

  return (
    <div className="mt-3 grid gap-3" data-testid="form-project">
      <p className="text-sm text-muted-foreground">
        Approve a work area inside a work budget. Its manager accepts submitted
        work for review; the words below are what all of it is judged against,
        exactly.
      </p>
      {budgets.length === 0 ? (
        <p className="text-sm" data-testid="project-no-budget">
          There is no open work budget yet. Set one aside first, then approve
          work areas inside it.
        </p>
      ) : (
        <SelectField
          label="Work budget"
          onChange={setWhich}
          options={budgets.map((m) => ({
            value: m.address,
            label:
              ctx.work?.milestonePanel === m.address.toLowerCase()
                ? "The milestone panel (judges your team's milestones)"
                : budgetName(m),
          }))}
          testId="project-budget"
          value={chosen?.address ?? ""}
        />
      )}
      <TextField
        hint={WORK_AREA_NAME_HINT}
        label="Work area name"
        onChange={setName}
        placeholder="docs"
        testId="project-name"
        value={name}
      />
      <TextField
        hint={
          managerKeys.length > 0 &&
          !managerName(managerKeys[0]).startsWith("0x")
            ? `${managerName(managerKeys[0])} will manage it.`
            : "Pick someone from the list, or leave empty to manage it yourself."
        }
        after={
          <PeoplePicker onPick={setManager} testId="project-manager-people" />
        }
        label="Who manages it"
        onChange={setManager}
        placeholder="Pick from the list below, or paste an account address"
        testId="project-manager"
        value={manager}
      />
      {isMilestonePanel ? (
        <SelectField
          hint="The work area holds nothing: it only lets reviewers judge this milestone, against its exact words."
          label="Which milestone"
          onChange={setMilestone}
          options={ctx.milestoneWords.map((words, index) => ({
            value: String(index),
            label: `${index + 1}. ${words}`,
          }))}
          testId="project-milestone"
          value={String(milestoneIndex)}
        />
      ) : (
        <TextField
          hint="Most Shares this work area may award."
          inputMode="decimal"
          label="Shares for the work area"
          onChange={setShares}
          placeholder="1000"
          testId="project-shares"
          value={shares}
        />
      )}
      {hasMoney && !isMilestonePanel ? (
        <TextField
          inputMode="decimal"
          label="Money for the work area"
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
      {isMilestonePanel ? null : (
        <TextAreaField
          hint="Work submitted here must state these exact words, or the manager cannot accept it for review."
          label="How the work is judged"
          onChange={setCheck}
          placeholder="The docs are merged and reviewed"
          testId="project-check"
          value={check}
        />
      )}
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
  // Work an open vote would already award is left out: a second vote for it could only fail when it runs.
  const voting = awardsUnderVote(ctx.decisions);
  const awardable = (ctx.work?.mandates ?? []).flatMap((mandate) =>
    mandate.claims
      .filter(
        (c) =>
          c.record.status === "Paid" &&
          c.project !== null &&
          !c.sharesAwarded &&
          !voting.has(`${mandate.address}:${c.id}`.toLowerCase()),
      )
      .map((claim) => ({ mandate, claim })),
  );
  const inVote = voting.size > 0;
  // Approved work that earns nothing until its contributor marks it finished: listed, so it is not mistaken for none.
  const unfinished = waitingToFinish(ctx.work);
  const [which, setWhich] = useState("");
  const [shares, setShares] = useState("");
  const key = (a: (typeof awardable)[number]) =>
    `${a.mandate.address}:${a.claim.id}`;
  const chosen = awardable.find((a) => key(a) === which) ?? awardable[0];
  const who = useWalletLabels([
    ...awardable.map((a) => a.claim.record.contributor),
    ...unfinished.map((u) => u.claim.record.contributor),
  ]);
  const project = chosen?.mandate.projects.find(
    (p) => p.id === chosen.claim.project,
  );
  const left = project
    ? project.record.shareBudget - project.record.sharesAwarded
    : null;
  // The Shares refuse an award over this year's allowance of new Shares (D76), so the form says so first.
  const allowance = useAllowance(
    ctx.sharesToken || null,
    ctx.dao,
    ctx.chainTime,
  );
  const allowanceLeft = allowance?.kind === "capped" ? allowance.left : null;

  const result = useMemo<DraftResult>(() => {
    if (!chosen)
      return { problem: "No approved work is waiting for an award." };
    return attempt(() => {
      const amount = shares.trim()
        ? parseUnits(shares, 18, "shares", "The Shares")
        : 0n;
      if (allowanceLeft !== null && amount > allowanceLeft) {
        throw new DecisionInputError(
          "shares",
          `That is more new Shares than this year allows: ${formatUnits(allowanceLeft, 18)} are left to award.`,
        );
      }
      return awardDecision({
        dao: ctx.dao,
        mandate: chosen.mandate.address,
        claimId: chosen.claim.id,
        shares: amount,
      });
    });
  }, [ctx, chosen, shares, allowanceLeft]);

  return (
    <div className="mt-3 grid gap-3" data-testid="form-award">
      <p className="text-sm text-muted-foreground">
        Award Shares to someone whose work the reviewers approved. The work
        budget refuses an award larger than the work area has left, however the
        vote goes.
      </p>
      {awardable.length === 0 && unfinished.length > 0 ? (
        // Approved work is there, but none of it is marked finished yet: say whose step it is, or from when.
        <div className="text-sm" data-testid="award-waiting">
          <p>
            Approved work can be awarded once its contributor marks it finished,
            after a waiting period.
          </p>
          <ul className="mt-1 list-disc pl-5">
            {unfinished.map((u) => (
              <li
                data-testid="award-waiting-item"
                key={`${u.mandate.address}:${u.claim.id}`}
              >
                {waitingToFinishText(u, who, day)}
              </li>
            ))}
          </ul>
        </div>
      ) : awardable.length === 0 ? (
        // Nothing to award: no amount to type and no preview, only where the work stands.
        <p className="text-sm" data-testid="award-none">
          No approved work is waiting for an award.{" "}
          {inVote
            ? "Work already in an open award vote is not listed again."
            : "Work can be awarded once its work area's manager has accepted it, its reviewers approve it, and the waiting period has passed. Submitted work and where it stands are on the Work tab."}
        </p>
      ) : (
        <SelectField
          label="Work to award"
          onChange={setWhich}
          options={awardable.map((a) => ({
            value: key(a),
            label: `${workTitle(a.claim.id)} by ${who(a.claim.record.contributor)}${a.claim.project ? ` in ${workTitle(a.claim.project)}` : ""}`,
          }))}
          testId="award-claim"
          value={chosen ? key(chosen) : ""}
        />
      )}
      {awardable.length === 0 ? null : (
        <>
          <TextField
            hint={
              [
                left !== null
                  ? `The work area has ${formatUnits(left, 18)} Shares left to award.`
                  : null,
                allowanceLeft !== null
                  ? `This year's allowance of new Shares has ${formatUnits(allowanceLeft, 18)} left.`
                  : null,
              ]
                .filter(Boolean)
                .join(" ") || undefined
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
        </>
      )}
    </div>
  );
}

export function PayForm({ ctx, blocked, busy, gate, onSubmit }: FormProps) {
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const dirty = recipient !== "" || amount !== "";
  const decimals = ctx.currencyDecimals ?? 0;
  const balance = useQuery({
    queryKey: ["launchpad", "work", ctx.dao, "treasury-balance", ctx.currency],
    enabled: ctx.currencyDecimals !== null,
    queryFn: async () =>
      decodeWord(
        await ethCall(
          getRpcEndpoint(),
          ctx.currency,
          `0x70a08231${ctx.dao.slice(2).toLowerCase().padStart(64, "0")}`,
        ),
      ),
    staleTime: 5_000,
  });
  const result = useMemo<DraftResult>(() => {
    if (ctx.currencyDecimals === null)
      return { problem: "This project has no currency to pay in." };
    return attempt(() => {
      const wei = amount.trim()
        ? parseUnits(amount, decimals, "amount", "The amount")
        : 0n;
      if (balance.data !== undefined && wei > balance.data)
        throw new DecisionInputError(
          "amount",
          `The treasury holds only ${formatUnits(balance.data, decimals, 4)} ${ctx.currencySymbol}.`,
        );
      return payDecision({
        currency: ctx.currency,
        currencyDecimals: decimals,
        currencySymbol: ctx.currencySymbol,
        recipient,
        amount: wei,
      });
    });
  }, [ctx, recipient, amount, decimals, balance.data]);

  return (
    <div className="mt-3 grid gap-3" data-testid="form-pay">
      <p className="text-sm text-muted-foreground">
        Pay someone from the treasury. Nothing moves until holders back it and
        it takes effect.
      </p>
      <p
        className="text-xs text-muted-foreground"
        data-testid="pay-network-token"
      >
        Network: chain {ctx.chainId ?? "unknown"}. Token: {ctx.currencySymbol}{" "}
        <code className="break-all">{ctx.currency}</code>.
      </p>
      <p className="text-sm" data-testid="pay-balance">
        {balance.data === undefined
          ? "Reading the treasury…"
          : `The treasury holds ${formatUnits(balance.data, decimals, 4)} ${ctx.currencySymbol}.`}
      </p>
      <TextField
        after={
          <PaymentRecipientPicker chainId={ctx.chainId} onPick={setRecipient} />
        }
        label="Who to pay (wallet address)"
        onChange={setRecipient}
        placeholder="0x…"
        testId="pay-recipient"
        value={recipient}
      />
      <TextField
        inputMode="decimal"
        label={`Amount (${ctx.currencySymbol})`}
        onChange={setAmount}
        placeholder="0"
        testId="pay-amount"
        value={amount}
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
