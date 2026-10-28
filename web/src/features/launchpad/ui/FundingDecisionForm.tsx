/**
 * "Sell new units for the project" (D133): with no funding terms yet, the vote that publishes them (what buyers get and
 * the most the project can ever sell); once published, a vote that opens a sale within them, stops the open one, or
 * raises or lowers the most. The form reads the terms and offers only what fits where they stand.
 */

import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { getRpcEndpoint } from "../chain";
import {
  capPlan,
  fundingStateLine,
  instrumentLine,
  salePlan,
  soldLine,
  units,
} from "../lib/funding-copy";
import {
  closeTrancheDecision,
  fundingPhase,
  lowerCapDecision,
  openTrancheDecision,
  publishFundingDecision,
  readFundingTerms,
} from "../lib/funding-terms";
import { decodeAddress, decodeWord, encodeCall0 } from "../lib/work";
import { endpointChain } from "../use-work";
import { SelectField, TextField } from "./decision-fields";
import {
  attempt,
  type DraftResult,
  DraftPanel,
  type FormProps,
} from "./decision-forms";

type Action = "sell" | "stop" | "raise" | "lower";

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
  const [action, setAction] = useState<Action>("sell");
  const [quantityText, setQuantityText] = useState("");
  const [priceText, setPriceText] = useState("");
  const [daysText, setDaysText] = useState("60");

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
          label: "Raise the most that can be sold (30 days' notice)",
        },
        { value: "lower" as const, label: "Lower the most that can be sold" },
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
      return attempt(() =>
        publishFundingDecision({
          terms,
          asShares: instrument === "shares",
          cap: plan.cap,
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
            unitsNow: read.data?.unitsNow ?? null,
          }),
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
      default:
        return { problem: "Choose what to decide." };
    }
  }, [
    terms,
    view,
    capText,
    instrument,
    read.data?.unitsNow,
    chosen,
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
            ? ` ${instrumentLine(view.asShares)}; ${soldLine(view)}.`
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
            hint="The most new units that can ever be sold under these terms. Raising it later takes another vote and 30 days."
            inputMode="decimal"
            label="The most that can be sold"
            onChange={setCapText}
            placeholder="100"
            testId="funding-cap-input"
            value={capText}
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
            hint="Bids set the price above this. Nothing sells below what leaving pays, plus 2%."
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
      {view?.published && (chosen === "raise" || chosen === "lower") ? (
        <TextField
          inputMode="decimal"
          label="The new most that can be sold"
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
