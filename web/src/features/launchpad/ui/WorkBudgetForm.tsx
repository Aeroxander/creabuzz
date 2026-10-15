import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { ethCall, getRpcEndpoint } from "../chain";
import {
  DecisionInputError,
  mandateDecision,
  parseUnits,
} from "../lib/dao-actions";
import { decodeWord } from "../lib/work";
import {
  PeoplePicker,
  SelectField,
  TextAreaField,
  TextField,
} from "./decision-fields";
import {
  attempt,
  DAY,
  DraftPanel,
  type DraftResult,
  days,
  type FormProps,
  names,
} from "./decision-forms";

const reviewerExample = "0x… (one wallet address per line)";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** The decimals of a token the vote names for the reviewers' bond, read from the chain (null while it cannot be). */
export function useTokenDecimals(token: string) {
  return useQuery({
    queryKey: ["launchpad", "token-decimals", token.toLowerCase()],
    enabled: ADDRESS_RE.test(token),
    queryFn: async () => {
      const word = decodeWord(
        await ethCall(getRpcEndpoint(), token, "0x313ce567"),
      );
      if (word > 36n) throw new Error("not a token");
      return Number(word);
    },
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
}

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
  const [bond, setBond] = useState("");
  // What the bond is paid in: the claim currency when there is one (the safest), the project's own token, or another.
  const hasCurrency = ctx.currencyDecimals !== null;
  const [bondIn, setBondIn] = useState<"currency" | "project" | "other">(
    hasCurrency ? "currency" : "project",
  );
  const [bondOther, setBondOther] = useState("");
  const otherDecimals = useTokenDecimals(
    bondIn === "other" ? bondOther.trim() : "",
  );
  const dirty = [
    shareBudget,
    shareCap,
    money,
    moneyCap,
    reviewers,
    quorum,
    bond,
    bondOther,
  ].some((v) => v !== "");

  const result = useMemo<DraftResult>(
    () =>
      attempt(() => {
        const decimals = ctx.currencyDecimals ?? 0;
        const list = names(reviewers);
        // The bond's token, its decimals and how the summary names it. The claim currency needs no words.
        const bondTerms = () => {
          if (!bond.trim()) return { reviewerBond: 0n };
          if (bondIn === "currency") {
            return {
              reviewerBond: parseUnits(
                bond,
                decimals,
                "reviewerBond",
                "The bond",
              ),
            };
          }
          if (bondIn === "project") {
            return {
              reviewerBond: parseUnits(bond, 18, "reviewerBond", "The bond"),
              reviewerBondToken: ctx.sharesToken,
              reviewerBondDecimals: 18,
              reviewerBondLabel: "of the project's own token",
            };
          }
          const token = bondOther.trim();
          if (!ADDRESS_RE.test(token))
            throw new DecisionInputError(
              "reviewerBondToken",
              "Paste the address of the token the bond is paid in.",
            );
          if (otherDecimals.isError)
            throw new DecisionInputError(
              "reviewerBondToken",
              "That address does not look like a token on this chain.",
            );
          if (otherDecimals.data === undefined)
            throw new DecisionInputError(
              "reviewerBondToken",
              "Reading that token…",
            );
          return {
            reviewerBond: parseUnits(
              bond,
              otherDecimals.data,
              "reviewerBond",
              "The bond",
            ),
            reviewerBondToken: token,
            reviewerBondDecimals: otherDecimals.data,
          };
        };
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
          ...bondTerms(),
          now: ctx.chainTime,
        });
      }),
    [
      ctx,
      shareBudget,
      shareCap,
      money,
      moneyCap,
      open,
      reviewers,
      quorum,
      bond,
      bondIn,
      bondOther,
      otherDecimals.data,
      otherDecimals.isError,
    ],
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
        hint="People who judge claims. Choose people other than the ones who will claim; team members whose Shares are locked cannot be reviewers."
        after={
          <PeoplePicker
            onPick={(address) =>
              setReviewers((current) =>
                current.toLowerCase().includes(address.toLowerCase())
                  ? current
                  : current.trim()
                    ? `${current.trimEnd()}\n${address}`
                    : address,
              )
            }
            testId="budget-reviewers-people"
          />
        }
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
      <TextField
        hint="Optional. Each reviewer posts this before judging a claim. The DAO can take it after a disputed approval, so judging carelessly costs them. Leave empty for none."
        inputMode="decimal"
        label="Bond each reviewer must post"
        onChange={setBond}
        placeholder="0"
        testId="budget-bond"
        value={bond}
      />
      {bond.trim() ? (
        <>
          <SelectField
            label="Bond paid in"
            onChange={(next) => setBondIn(next as typeof bondIn)}
            options={[
              ...(hasCurrency
                ? [
                    {
                      value: "currency",
                      label: `${ctx.currencySymbol || "The payment currency"} (recommended)`,
                    },
                  ]
                : []),
              { value: "project", label: "The project's own token" },
              { value: "other", label: "Another token" },
            ]}
            testId="budget-bond-token"
            value={bondIn}
          />
          {bondIn === "other" ? (
            <TextField
              hint="The address of the token on this network."
              label="Token address"
              onChange={setBondOther}
              placeholder="0x…"
              testId="budget-bond-other"
              value={bondOther}
            />
          ) : null}
          {bondIn !== "currency" ? (
            <p
              className="text-xs text-amber-700 dark:text-amber-300"
              data-testid="budget-bond-warning"
            >
              {bondIn === "project"
                ? "A bond in the project's own token is worth least when the project struggles, and the people steering the project help set its price. Reviewers may not accept it."
                : "Any token works, but a bond only deters if it keeps its value and nobody involved can freeze or inflate it. Check the token before you vote."}
            </p>
          ) : null}
        </>
      ) : null}
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
