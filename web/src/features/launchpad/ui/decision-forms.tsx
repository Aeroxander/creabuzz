import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { PaymentRecipientPicker } from "@/features/identity/ui/PaymentRecipientPicker";

import { Button } from "@/shared/ui/button";
import { type ExchangeAddresses, ethCall, getRpcEndpoint } from "../chain";
import {
  awardDecision,
  collectFeesDecision,
  type DecisionDraft,
  DecisionInputError,
  formatUnits,
  parseUnits,
  payDecision,
  projectDecision,
} from "../lib/dao-actions";
import {
  computePoolIdCall,
  marketDecision,
  marketTerms,
} from "../lib/market-actions";
import { decodeWord, idLabel } from "../lib/work";
import type { WorkSnapshot } from "../lib/work-read";
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
  /** Why the work budgets could not be read, when they could not; null while they are still being read. */
  workError?: string | null;
  /** The DAO's voting policy and its Shares. */
  policy: string;
  sharesToken: string;
  /** The exchange's contracts on this chain, or null when there is no market here. */
  exchange: ExchangeAddresses | null;
  /** The exact words of each of the team's milestones, in order (empty when the team's Shares are not locked). */
  milestoneWords: readonly string[];
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

export interface FormProps {
  ctx: FormContext;
  blocked: string | null;
  busy: string | null;
  gate: string | null;
  onSubmit: (draft: DecisionDraft) => void;
}

export function ProjectForm({ ctx, blocked, busy, gate, onSubmit }: FormProps) {
  // The milestone panel is listed last: a project is usually for ordinary work, and the panel is only for milestones.
  const openBudgets = (ctx.work?.mandates ?? []).filter(
    (m) => !m.closed && m.expiresAt > ctx.chainTime,
  );
  const budgets = [
    ...openBudgets.filter((m) => !m.isMilestonePanel),
    ...openBudgets.filter((m) => m.isMilestonePanel),
  ];
  const [which, setWhich] = useState("");
  const [name, setName] = useState("");
  const [manager, setManager] = useState("");
  const [shares, setShares] = useState("");
  const [money, setMoney] = useState("");
  const [open, setOpen] = useState("30");
  const [check, setCheck] = useState("");
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
            label:
              ctx.work?.milestonePanel === m.address.toLowerCase()
                ? "The milestone panel (judges your team's milestones)"
                : `${m.address.slice(0, 10)}… · ${formatUnits(m.created.shareBudget - m.sharesAllocated, 18)} Shares left`,
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
        after={
          <PeoplePicker onPick={setManager} testId="project-manager-people" />
        }
        label="Who manages it (wallet address)"
        onChange={setManager}
        placeholder="0x…"
        testId="project-manager"
        value={manager}
      />
      {isMilestonePanel ? (
        <SelectField
          hint="The project holds nothing: it only lets reviewers judge this milestone, against its exact words."
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
          hint="Most Shares this project may award."
          inputMode="decimal"
          label="Shares for the project"
          onChange={setShares}
          placeholder="1000"
          testId="project-shares"
          value={shares}
        />
      )}
      {hasMoney && !isMilestonePanel ? (
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
      {isMilestonePanel ? null : (
        <TextAreaField
          hint="Claims for this project must state these exact words, or the manager cannot take them on."
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
  // The Shares refuse an award over this year's allowance of new Shares (D76), so the form says so first.
  const allowance = useAllowance(
    ctx.sharesToken || null,
    ctx.dao,
    ctx.chainTime,
  );
  const allowanceLeft = allowance?.kind === "capped" ? allowance.left : null;

  const result = useMemo<DraftResult>(() => {
    if (!chosen)
      return { problem: "No approved claim is waiting for an award." };
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
          [
            left !== null
              ? `The project has ${formatUnits(left, 18)} Shares left to award.`
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
    </div>
  );
}

const percentToBps = (text: string): number => Math.round(Number(text) * 100);

export function MarketForm({ ctx, blocked, busy, gate, onSubmit }: FormProps) {
  const exchange = ctx.exchange;
  const [shares, setShares] = useState("");
  const [price, setPrice] = useState("");
  const [tradeFee, setTradeFee] = useState("1");
  const [poolFee, setPoolFee] = useState("0.3");
  const [step, setStep] = useState("200");
  const dirty = shares !== "" || price !== "";

  const balance = useQuery({
    queryKey: ["launchpad", "work", ctx.dao, "dao-shares"],
    queryFn: async () =>
      decodeWord(
        await ethCall(
          getRpcEndpoint(),
          ctx.sharesToken,
          `0x70a08231${ctx.dao.slice(2).toLowerCase().padStart(64, "0")}`,
        ),
      ),
    staleTime: 10_000,
  });

  const input = useMemo(
    () =>
      exchange && ctx.currencyDecimals !== null
        ? {
            dao: ctx.dao,
            policy: ctx.policy,
            sharesToken: ctx.sharesToken,
            currency: ctx.currency,
            currencyDecimals: ctx.currencyDecimals,
            amm: exchange.amm,
            hook: exchange.hook,
            registry: exchange.registry,
            poolType: exchange.poolType,
            shares,
            price,
            poolFeeBps: percentToBps(poolFee),
            taxBps: percentToBps(tradeFee),
            tickSpacing: Number(step),
          }
        : null,
    [ctx, exchange, shares, price, poolFee, tradeFee, step],
  );
  const terms = useMemo(() => {
    if (!input) return null;
    try {
      return { terms: marketTerms(input), problem: null };
    } catch (error) {
      if (error instanceof DecisionInputError)
        return { terms: null, problem: error.message };
      throw error;
    }
  }, [input]);
  // The exchange's pool type is the authority on what a pool is called; the decision needs the name before it exists.
  const poolId = useQuery({
    queryKey: [
      "launchpad",
      "work",
      ctx.dao,
      "pool-id",
      terms?.terms ? computePoolIdCall(terms.terms) : null,
    ],
    enabled: Boolean(terms?.terms && exchange),
    queryFn: async () =>
      `0x${decodeWord(
        await ethCall(
          getRpcEndpoint(),
          (exchange as ExchangeAddresses).poolType,
          computePoolIdCall(
            terms?.terms as NonNullable<typeof terms>["terms"] & object,
          ),
        ),
      )
        .toString(16)
        .padStart(64, "0")}`,
    staleTime: 60_000,
  });

  const result = useMemo<DraftResult>(() => {
    if (!exchange || ctx.currencyDecimals === null || !input)
      return { problem: "There is no market on this network yet." };
    if (terms?.problem) return { problem: terms.problem };
    if (
      terms?.terms &&
      balance.data !== undefined &&
      terms.terms.sharesAmount > balance.data
    )
      return {
        problem: `The DAO holds only ${formatUnits(balance.data, 18)} Shares of its own to put on a market.`,
      };
    if (!poolId.data)
      return {
        problem: poolId.isError
          ? "The exchange could not name the pool. Check the connection."
          : "Asking the exchange to name the pool…",
      };
    return attempt(() => marketDecision(input, poolId.data as string));
  }, [
    exchange,
    ctx.currencyDecimals,
    input,
    terms,
    balance.data,
    poolId.data,
    poolId.isError,
  ]);

  return (
    <div className="mt-3 grid gap-3" data-testid="form-market">
      <p className="text-sm text-muted-foreground">
        Let people buy and sell the Shares. The DAO puts some of its own Shares
        into a pool; the price starts where you say and rises as people buy. The
        DAO needs no money to start, and a small fee on every trade goes to the
        DAO.
      </p>
      <TextField
        hint={
          balance.data !== undefined
            ? `The DAO holds ${formatUnits(balance.data, 18)} Shares of its own.`
            : undefined
        }
        inputMode="decimal"
        label="Shares to put on the market"
        onChange={setShares}
        placeholder="1000000"
        testId="market-shares"
        value={shares}
      />
      <TextField
        hint={`Per Share, in ${ctx.currencySymbol}. The pool rounds it to the nearest price step.`}
        inputMode="decimal"
        label="Starting price"
        onChange={setPrice}
        placeholder="0.01"
        testId="market-price"
        value={price}
      />
      <details className="text-sm">
        <summary className="cursor-pointer text-muted-foreground">
          Fees and price steps
        </summary>
        <div className="mt-2 grid gap-3">
          <TextField
            hint="Paid to the DAO on every buy and sell. Up to 10%."
            inputMode="decimal"
            label="Fee on every trade (%)"
            onChange={setTradeFee}
            testId="market-trade-fee"
            value={tradeFee}
          />
          <TextField
            hint="Paid to whoever provides the Shares to the pool (here, the DAO)."
            inputMode="decimal"
            label="Pool fee (%)"
            onChange={setPoolFee}
            testId="market-pool-fee"
            value={poolFee}
          />
          <TextField
            hint="Each step is a 0.01% price move; liquidity sits on these steps."
            inputMode="numeric"
            label="Price step (in 0.01% moves)"
            onChange={setStep}
            testId="market-step"
            value={step}
          />
        </div>
      </details>
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

export function CollectFeesForm({
  ctx,
  blocked,
  busy,
  gate,
  onSubmit,
}: FormProps) {
  const exchange = ctx.exchange;
  const owed = useQuery({
    queryKey: ["launchpad", "work", ctx.dao, "fees-owed", exchange?.amm],
    enabled: Boolean(exchange),
    queryFn: async () =>
      decodeWord(
        await ethCall(
          getRpcEndpoint(),
          (exchange as ExchangeAddresses).amm,
          `0x271e88f9${ctx.sharesToken.slice(2).toLowerCase().padStart(64, "0")}${ctx.currency.slice(2).toLowerCase().padStart(64, "0")}`,
        ),
      ),
    staleTime: 5_000,
  });
  const decimals = ctx.currencyDecimals ?? 0;
  const result = useMemo<DraftResult>(() => {
    if (!exchange)
      return { problem: "There is no market on this network yet." };
    if (owed.data === undefined)
      return { problem: "Reading the fees collected so far…" };
    return attempt(() =>
      collectFeesDecision({
        amm: exchange.amm,
        sharesToken: ctx.sharesToken,
        currency: ctx.currency,
        currencyDecimals: decimals,
        recipient: ctx.dao,
        amount: owed.data as bigint,
      }),
    );
  }, [exchange, owed.data, ctx, decimals]);

  return (
    <div className="mt-3 grid gap-3" data-testid="form-fees">
      <p className="text-sm text-muted-foreground">
        Every trade pays a small fee to the DAO. Collecting it moves what has
        built up into the treasury.
      </p>
      <p className="text-sm" data-testid="fees-owed">
        {owed.data === undefined
          ? "Reading the fees collected so far…"
          : `Collected so far: ${formatUnits(owed.data, decimals, 4)} ${ctx.currencySymbol}`}
      </p>
      <DraftPanel
        blocked={blocked}
        busy={busy}
        dirty={owed.data !== undefined}
        gate={gate}
        onSubmit={onSubmit}
        result={result}
      />
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
        Pay someone from the treasury. Nothing moves until holders back this and
        it runs.
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
