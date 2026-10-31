/**
 * "Pay holders" (N10): with no payout module yet, the vote that makes one and names it, with the share of revenue that
 * goes to holders; once there is one, the vote that pays holders an amount from the treasury.
 */

import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { usdcAddress } from "@creaton/core/launchpad/sale-currency.ts";
import { getRpcEndpoint } from "../chain";
import { localUsdcAddress, payoutsFactory } from "../chain-config";
import { parseUnits } from "@creaton/core/launchpad/daoActions.ts";
import {
  declarePayoutDecision,
  encodePredictPayouts,
  startPayoutsDecision,
} from "@creaton/core/launchpad/payouts.ts";
import { decodeAddress } from "@creaton/core/launchpad/work.ts";
import { usePayouts } from "../use-payouts";
import { endpointChain } from "../use-work";
import { TextField } from "./decision-fields";
import {
  attempt,
  type DraftResult,
  DraftPanel,
  type FormProps,
} from "./decision-forms";

export function PayoutsForm({ ctx, blocked, busy, gate, onSubmit }: FormProps) {
  const chainId = ctx.chainId ?? null;
  const factory = payoutsFactory(chainId);
  const usdc = usdcAddress(chainId, localUsdcAddress());
  const payouts = usePayouts(ctx.dao, null);
  const [splitText, setSplitText] = useState("50");
  const [amountText, setAmountText] = useState("");
  const splitBps = Math.round(Number(splitText.trim()) * 100);
  const predicted = useQuery({
    queryKey: [
      "launchpad",
      "payouts",
      "predict",
      factory,
      ctx.dao,
      usdc,
      splitBps,
    ],
    enabled:
      factory !== null &&
      usdc !== null &&
      payouts.data === null &&
      splitBps >= 1 &&
      splitBps <= 10_000,
    queryFn: async () =>
      decodeAddress(
        await endpointChain(getRpcEndpoint()).call(
          factory as string,
          encodePredictPayouts(ctx.dao, usdc as string, splitBps),
        ),
      ),
    staleTime: Number.POSITIVE_INFINITY,
  });

  const result = useMemo<DraftResult>(() => {
    if (!factory || !usdc)
      return { problem: "Payouts are not set up on this network." };
    if (payouts.data === undefined)
      return { problem: "Reading whether payouts have started…" };
    if (payouts.data === null) {
      if (
        !/^\d{1,3}(\.\d{1,2})?$/.test(splitText.trim()) ||
        splitBps < 1 ||
        splitBps > 10_000
      ) {
        return {
          problem:
            "Say what share of revenue goes to holders, from 0.01% to 100%.",
        };
      }
      if (!predicted.data)
        return { problem: "Working out the module's address…" };
      return attempt(() =>
        startPayoutsDecision({
          dao: ctx.dao,
          factory,
          predicted: predicted.data as string,
          currency: usdc,
          splitBps,
        }),
      );
    }
    const module = payouts.data.module;
    return attempt(() =>
      declarePayoutDecision({
        dao: ctx.dao,
        payouts: module,
        currency: usdc,
        amount: parseUnits(amountText || "0", 6, "amount", "The amount"),
        decimals: 6,
        symbol: "USDC",
      }),
    );
  }, [
    factory,
    usdc,
    payouts.data,
    splitText,
    splitBps,
    predicted.data,
    amountText,
    ctx.dao,
  ]);

  return (
    <div className="mt-3 grid gap-3" data-testid="form-payouts">
      {payouts.data === null ? (
        <TextField
          hint="The rest of each payment goes to the treasury. Changing it later takes a vote and 30 days' notice."
          inputMode="decimal"
          label="Share of revenue for holders (%)"
          onChange={setSplitText}
          testId="payouts-split-input"
          value={splitText}
        />
      ) : payouts.data ? (
        <TextField
          hint="Taken from the treasury now and shared by everyone holding Shares or Loot, by how many they hold."
          inputMode="decimal"
          label="Amount to pay out (USDC)"
          onChange={setAmountText}
          placeholder="100"
          testId="payouts-amount-input"
          value={amountText}
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
