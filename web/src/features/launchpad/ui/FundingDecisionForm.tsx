/**
 * "Sell new units for the project" (D133): with no funding terms yet, the vote that publishes them (what buyers get and
 * the funding limit, and the exit fee, D135); once published, a vote that opens a sale within them, stops the open one,
 * raises or lowers the limit, or lowers the exit fee. The form reads the terms and offers only what fits where they
 * stand.
 */

import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { getRpcEndpoint } from "../chain";
import {
  capPlan,
  exitFeeLine,
  feePlan,
  fundingStateLine,
  instrumentLine,
  salePlan,
  soldLine,
  units,
} from "../lib/funding-copy";
import {
  acceptTokensDecision,
  closeTrancheDecision,
  feePercent,
  fundingPhase,
  lowerCapDecision,
  lowerExitFeeDecision,
  openTrancheDecision,
  publishFundingDecision,
  readFundingTerms,
  watchAssetsDecision,
} from "@creaton/core/launchpad/fundingTerms.ts";
import { weeklyRounds } from "../chain-config";
import {
  decodeAddress,
  decodeWord,
  encodeCall0,
} from "@creaton/core/launchpad/work.ts";
import { endpointChain } from "../use-work";
import { SelectField, TextField } from "./decision-fields";
import {
  attempt,
  type DraftResult,
  DraftPanel,
  type FormProps,
} from "./decision-forms";

type Action = "sell" | "stop" | "raise" | "lower" | "fee" | "watch" | "accept";

export function FundingDecisionForm({
  ctx,
  blocked,
  busy,
  gate,
  onSubmit,
}: FormProps) {
  const terms = ctx.fundingTerms ?? null;
  const read = useQuery({
    queryKey: ["launchpad", "funding", "form", terms, ctx.dao],
    enabled: terms !== null,
    queryFn: async () => {
      const chain = endpointChain(getRpcEndpoint());
      const total = async (token: string) =>
        decodeWord(await chain.call(token, encodeCall0("totalSupply()")));
      const loot = decodeAddress(
        await chain.call(ctx.dao, encodeCall0("loot()")),
      );
      const [view, sharesTotal, lootTotal] = await Promise.all([
        readFundingTerms(chain, terms as string, ctx.dao),
        total(ctx.sharesToken),
        total(loot),
      ]);
      return { view, unitsNow: sharesTotal + lootTotal };
    },
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });
  const [instrument, setInstrument] = useState<"loot" | "shares">("loot");
  const [capText, setCapText] = useState("");
  const [feeText, setFeeText] = useState("2");
  const [action, setAction] = useState<Action>("sell");
  const [quantityText, setQuantityText] = useState("");
  const [priceText, setPriceText] = useState("");
  const [daysText, setDaysText] = useState("60");
  const [tokensText, setTokensText] = useState("");
  // Terms name the one rounds contract that may sell: this app's, on this network.
  const rounds = weeklyRounds(ctx.chainId ?? null);

  const view = read.data?.view ?? null;
  const phase = view ? fundingPhase(view, ctx.chainTime) : null;
  const active = view?.published && ctx.chainTime >= view.activeFrom;
  const actions: { value: Action; label: string }[] = view?.published
    ? [
        ...(active
          ? [{ value: "sell" as const, label: "Open a sale within the terms" }]
          : []),
        ...(view.tranche
          ? [{ value: "stop" as const, label: "Stop the open sale" }]
          : []),
        {
          value: "raise" as const,
          label: "Raise the funding limit (30 days' notice)",
        },
        { value: "lower" as const, label: "Lower the funding limit" },
        ...(view.exitFeeBps > 0
          ? [{ value: "fee" as const, label: "Lower the exit fee" }]
          : []),
        {
          value: "watch" as const,
          label: "Stop sales while the treasury holds other tokens",
        },
        {
          value: "accept" as const,
          label: "Sell even while the treasury holds a token",
        },
      ]
    : [];
  const chosen: Action | null = actions.some((a) => a.value === action)
    ? action
    : (actions[0]?.value ?? null);

  const result = useMemo<DraftResult>(() => {
    if (!terms)
      return { problem: "Funding terms are not set up for this project." };
    if (!view) return { problem: "Reading the funding terms…" };
    if (!view.published) {
      const plan = capPlan(capText || "0");
      if ("problem" in plan) return plan;
      const fee = feePlan(feeText);
      if ("problem" in fee) return fee;
      return attempt(() =>
        publishFundingDecision({
          terms,
          asShares: instrument === "shares",
          cap: plan.cap,
          rounds: rounds ?? "",
          exitFeeBps: fee.bps,
          unitsNow: read.data?.unitsNow ?? null,
        }),
      );
    }
    switch (chosen) {
      case "sell": {
        const plan = salePlan(
          quantityText,
          priceText,
          daysText,
          ctx.chainTime,
          view.cap - view.sold,
        );
        if ("problem" in plan) return plan;
        return attempt(() => openTrancheDecision({ terms, ...plan }));
      }
      case "stop":
        return attempt(() => closeTrancheDecision({ terms }));
      case "raise": {
        const plan = capPlan(capText || "0");
        if ("problem" in plan) return plan;
        if (plan.cap <= view.cap) {
          return { problem: `Raise it above ${units(view.cap)}.` };
        }
        return attempt(() =>
          publishFundingDecision({
            terms,
            asShares: view.asShares,
            cap: plan.cap,
            // Fixed when the terms were first published.
            rounds: view.rounds ?? rounds ?? "",
            exitFeeBps: view.exitFeeBps,
            unitsNow: read.data?.unitsNow ?? null,
            raising: true,
          }),
        );
      }
      case "watch":
      case "accept": {
        const tokens = tokensText
          .split(/[\s,]+/)
          .map((t) => t.trim())
          .filter(Boolean);
        return attempt(() =>
          chosen === "watch"
            ? watchAssetsDecision({ terms, tokens })
            : acceptTokensDecision({ terms, tokens, yes: true }),
        );
      }
      case "lower": {
        const plan = capPlan(capText || "0");
        if ("problem" in plan) return plan;
        if (plan.cap >= view.cap || plan.cap < view.sold + view.reserved) {
          return {
            problem: `Lower it below ${units(view.cap)}, and not below the ${units(view.sold + view.reserved)} already sold or on offer.`,
          };
        }
        return attempt(() => lowerCapDecision({ terms, cap: plan.cap }));
      }
      case "fee": {
        const fee = feePlan(feeText);
        if ("problem" in fee) return fee;
        if (fee.bps >= view.exitFeeBps) {
          return {
            problem: `Lower it below ${feePercent(view.exitFeeBps)}: no vote can raise it.`,
          };
        }
        return attempt(() =>
          lowerExitFeeDecision({ terms, exitFeeBps: fee.bps }),
        );
      }
      default:
        return { problem: "Choose what to decide." };
    }
  }, [
    terms,
    view,
    capText,
    feeText,
    instrument,
    read.data?.unitsNow,
    chosen,
    rounds,
    tokensText,
    quantityText,
    priceText,
    daysText,
    ctx.chainTime,
  ]);

  if (terms && read.isPending) {
    return (
      <p className="mt-3 text-sm text-muted-foreground" role="status">
        Reading the funding terms…
      </p>
    );
  }
  return (
    <div className="mt-3 grid gap-3" data-testid="form-funding">
      {view && phase ? (
        <p className="text-sm" data-testid="funding-form-state">
          {fundingStateLine(phase, view)}
          {view.published
            ? ` ${instrumentLine(view.asShares)}; ${soldLine(view)}; ${exitFeeLine(view.exitFeeBps).toLowerCase()}.`
            : ""}
        </p>
      ) : null}
      {view && !view.published ? (
        <>
          <SelectField
            hint="Loot shares in the treasury and payouts like a Share, without a vote, so the people doing the work keep the say. This cannot change later."
            label="What buyers get"
            onChange={(v) => setInstrument(v === "shares" ? "shares" : "loot")}
            options={[
              { value: "loot", label: "Loot: no vote" },
              { value: "shares", label: "Shares: a vote" },
            ]}
            testId="funding-instrument-input"
            value={instrument}
          />
          <TextField
            hint="New units that may be sold under these terms for now. A later vote can raise it, with another 30 days' notice."
            inputMode="decimal"
            label="Funding limit (new units)"
            onChange={setCapText}
            placeholder="100"
            testId="funding-cap-input"
            value={capText}
          />
          <TextField
            hint="The part of what leaving pays that stays in the treasury, for those who stay: at most 5%. It is not charged during the 30 days' notice, and a later vote can lower it but never raise it."
            inputMode="decimal"
            label="Exit fee (%)"
            onChange={setFeeText}
            testId="funding-fee-input"
            value={feeText}
          />
        </>
      ) : null}
      {view?.published && chosen ? (
        <SelectField
          label="Decide to"
          onChange={(v) => setAction(v as Action)}
          options={actions}
          testId="funding-action-input"
          value={chosen}
        />
      ) : null}
      {view?.published && chosen === "sell" ? (
        <>
          <TextField
            inputMode="decimal"
            label="How many new units"
            onChange={setQuantityText}
            placeholder="40"
            testId="funding-quantity-input"
            value={quantityText}
          />
          <TextField
            hint="Bids set the price above this. Nothing sells below a unit's share of the treasury, plus 2%."
            inputMode="decimal"
            label="Least price a unit (USDC)"
            onChange={setPriceText}
            placeholder="1.10"
            testId="funding-price-input"
            value={priceText}
          />
          <TextField
            inputMode="numeric"
            label="Open for (days)"
            onChange={setDaysText}
            testId="funding-days-input"
            value={daysText}
          />
        </>
      ) : null}
      {view?.published && (chosen === "watch" || chosen === "accept") ? (
        <TextField
          hint={
            chosen === "watch"
              ? `Sales stop while the treasury holds ETH or any of these, so a price set in USDC never gives buyers part of them for nothing. Any holder can add one too. Now watched: ${view.watched.length === 0 ? "none" : view.watched.join(", ")}.`
              : "Sales go ahead although the treasury holds these, and buyers get part of them without paying for it. Only for tokens worth nothing, or when holders agree to share them."
          }
          label="Token addresses (up to 16)"
          onChange={setTokensText}
          placeholder="0x…"
          testId="funding-tokens-input"
          value={tokensText}
        />
      ) : null}
      {view?.published && chosen === "fee" ? (
        <TextField
          inputMode="decimal"
          label="New exit fee (%)"
          onChange={setFeeText}
          testId="funding-fee-input"
          value={feeText}
        />
      ) : null}
      {view?.published && (chosen === "raise" || chosen === "lower") ? (
        <TextField
          inputMode="decimal"
          label="New funding limit (units)"
          onChange={setCapText}
          testId="funding-cap-input"
          value={capText}
        />
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
