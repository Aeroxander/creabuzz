import { useState } from "react";

import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { Input } from "@/shared/ui/input";
import { getRpcEndpoint, recordSaleCurrency } from "../chain";
import { formatUnits, parseUnits } from "../lib/dao-actions";
import { encodeSwap } from "../lib/market-actions";
import { estimateTrade, minimumOut, type TradeSide } from "../lib/market-read";
import { encodeErc20Approve } from "../lib/evmCalls";
import type { Launch } from "../models";
import { useExchange } from "../use-exchange";
import { endpointChain } from "../use-work";
import { useWalletSend } from "../use-wallet-send";

/**
 * Buy or sell a project's Shares on its market. The estimate comes from the pool's current price and its fees; the trade
 * is sent with a floor under what comes back, so a price that moves against the trader makes the exchange refuse it
 * rather than fill it badly. Shares the founders still have locked cannot be sold, and the card says how many are free.
 */
export function TradeCard({ launch, dao }: { launch: Launch; dao: string }) {
  const { wallet, gate, busy, failure, send } = useWalletSend(launch, dao);
  const market = useExchange(launch, dao, wallet.address);
  const [side, setSide] = useState<TradeSide>("buy");
  const [amount, setAmount] = useState("");
  const [slippage, setSlippage] = useState("5");
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const { exchange, decimals, pool, price, holdings } = market;
  if (!market.usable || !pool.data || !exchange) return null;

  const symbol = launch.record.tokenPlan?.symbol ?? "Shares";
  const sale = recordSaleCurrency(launch.record);
  const moneySymbol = sale.kind === "custom" ? "USDC" : sale.symbol;
  const tokenIn =
    side === "buy"
      ? (launch.record.currency as string)
      : (launch.record.token as string);
  const tokenOut =
    side === "buy"
      ? (launch.record.token as string)
      : (launch.record.currency as string);
  const outSymbol = side === "buy" ? symbol : moneySymbol;
  const inDecimals = side === "buy" ? decimals : 18;
  const outDecimals = side === "buy" ? 18 : decimals;
  const held = holdings.data;
  const free =
    held === undefined
      ? null
      : side === "buy"
        ? held.money
        : held.shares > held.locked
          ? held.shares - held.locked
          : 0n;

  let amountIn: bigint | null = null;
  let parseProblem: string | null = null;
  if (amount.trim()) {
    try {
      amountIn = parseUnits(amount, inDecimals, "amount", "That amount");
    } catch (error) {
      parseProblem =
        error instanceof Error ? error.message : "Enter an amount.";
    }
  }
  const feeBps = (pool.data.feeBps ?? 0) + 100; // the pool's fee, and the DAO's usual 1% on every trade
  const estimate =
    amountIn !== null && price.data
      ? estimateTrade({
          side,
          amountIn,
          price: price.data,
          currencyDecimals: decimals,
          feeBps,
        })
      : null;
  const allowed = Math.min(Math.max(Number(slippage) || 0, 0), 50);
  const insufficient = amountIn !== null && free !== null && amountIn > free;

  const submit = async () => {
    setProblem(null);
    setDone(null);
    if (
      !wallet.address ||
      amountIn === null ||
      amountIn <= 0n ||
      estimate === null
    ) {
      setProblem("Enter how much you want to trade.");
      return;
    }
    if (insufficient) {
      setProblem(
        side === "sell" && held && held.locked > 0n
          ? `You can sell at most ${formatUnits(free ?? 0n, 18)} ${symbol}: the rest is locked until milestones are reached.`
          : "That is more than you have.",
      );
      return;
    }
    const approved = side === "buy" ? held?.allowMoney : held?.allowShares;
    if ((approved ?? 0n) < amountIn) {
      const landed = await send(
        `approve-${side}`,
        tokenIn,
        encodeErc20Approve(exchange.amm, amountIn),
      );
      if (!landed) return;
    }
    const now = await endpointChain(getRpcEndpoint()).now();
    const landed = await send(
      `swap-${side}`,
      exchange.amm,
      encodeSwap({
        recipient: wallet.address,
        tokenIn,
        tokenOut,
        amountIn,
        minOut: minimumOut(estimate, allowed),
        deadline: now + 3_600,
        poolId: pool.data?.id ?? "",
      }),
    );
    if (landed) {
      setDone(side === "buy" ? "Bought" : "Sold");
      setAmount("");
    }
  };

  return (
    <Card className="p-4" data-testid="trade-card">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-bold">Trade {symbol}</h2>
        <span
          className="text-sm text-muted-foreground"
          data-testid="trade-price"
        >
          {price.data
            ? `Price ${price.data.toPrecision(3)} ${moneySymbol} per ${symbol}`
            : "Reading the price…"}
        </span>
      </div>
      <fieldset className="mt-2 flex gap-1 rounded-lg bg-secondary/60 p-1">
        <legend className="sr-only">Buy or sell</legend>
        {(["buy", "sell"] as const).map((s) => (
          <button
            aria-pressed={side === s}
            className={`flex-1 rounded-md px-3 py-1 text-sm font-bold ${side === s ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
            data-testid={`trade-${s}`}
            key={s}
            onClick={() => {
              setSide(s);
              setAmount("");
              setProblem(null);
            }}
            type="button"
          >
            {s === "buy" ? "Buy" : "Sell"}
          </button>
        ))}
      </fieldset>
      <label className="mt-3 block text-sm font-medium" htmlFor="trade-amount">
        {side === "buy" ? `Pay (${moneySymbol})` : `Sell how many ${symbol}`}
      </label>
      <Input
        data-testid="trade-amount"
        disabled={busy !== null}
        id="trade-amount"
        inputMode="decimal"
        onChange={(e) => {
          setAmount(e.target.value);
          setDone(null);
        }}
        placeholder="0"
        value={amount}
      />
      <p
        className="mt-1 text-xs text-muted-foreground"
        data-testid="trade-balance"
      >
        {free === null
          ? "Connect your wallet to see your balance."
          : side === "buy"
            ? `You can pay up to ${formatUnits(free, decimals)}.`
            : `You can sell up to ${formatUnits(free, 18)} ${symbol}${held && held.locked > 0n ? `; ${formatUnits(held.locked, 18)} more ${held.locked === 1n ? "is" : "are"} locked until milestones are reached` : ""}.`}
      </p>
      {parseProblem ? (
        <p className="mt-1 text-xs text-red-700 dark:text-red-400" role="alert">
          {parseProblem}
        </p>
      ) : estimate !== null && estimate > 0n ? (
        <p className="mt-2 text-sm" data-testid="trade-estimate" role="status">
          You get about {formatUnits(estimate, outDecimals, 2)} {outSymbol}, and
          at least {formatUnits(minimumOut(estimate, allowed), outDecimals, 2)}{" "}
          {outSymbol}.
        </p>
      ) : null}
      <details className="mt-2 text-xs text-muted-foreground">
        <summary className="cursor-pointer">If the price moves</summary>
        <label className="mt-1 block" htmlFor="trade-slippage">
          Accept up to this much less than the estimate (%)
        </label>
        <Input
          className="mt-1 w-24"
          data-testid="trade-slippage"
          id="trade-slippage"
          inputMode="decimal"
          onChange={(e) => setSlippage(e.target.value)}
          value={slippage}
        />
        <p className="mt-1">
          A trade that would give less than that is refused by the exchange, and
          nothing changes.
        </p>
      </details>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          aria-busy={busy?.endsWith(side) ?? false}
          data-testid="trade-submit"
          disabled={
            busy !== null ||
            gate !== null ||
            amountIn === null ||
            amountIn <= 0n
          }
          onClick={() => void submit()}
          size="sm"
          type="button"
        >
          {busy?.startsWith("approve")
            ? "Approving…"
            : busy?.startsWith("swap")
              ? "Trading…"
              : side === "buy"
                ? "Buy"
                : "Sell"}
        </Button>
        {done ? (
          <span className="text-sm" data-testid="trade-done" role="status">
            {done}.
          </span>
        ) : null}
      </div>
      {gate && wallet.address ? (
        <p
          className="mt-2 text-xs text-amber-700 dark:text-amber-300"
          role="status"
        >
          {gate}
        </p>
      ) : null}
      {problem ? (
        <p
          className="mt-2 text-sm text-red-700 dark:text-red-400"
          data-testid="trade-problem"
          role="alert"
        >
          {problem}
        </p>
      ) : null}
      {failure ? (
        <p
          className="mt-2 text-sm text-red-700 dark:text-red-400"
          data-testid="trade-failure"
          role="alert"
        >
          {failure}
        </p>
      ) : null}
    </Card>
  );
}
