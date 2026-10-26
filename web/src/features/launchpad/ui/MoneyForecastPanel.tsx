import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";

import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { getRpcEndpoint } from "../chain";
import { forecastPool } from "../chain-config";
import { parseUnits } from "../lib/dao-actions";
import {
  encodeBet,
  encodeCollect,
  encodeSettlePool,
  mayBetNo,
  payoutIfRight,
  poolOpen,
  poolSettleable,
  readMoneyForecast,
} from "../lib/forecast-pool";
import { outcomeLine, poolsLine } from "../lib/money-forecast-copy";
import type { PostBountyRecord, WalletPosition } from "../lib/open-bounty";
import { postRefundsOpen } from "../lib/open-bounty";
import { encodeApproveBounty } from "../lib/work-bounty";
import { POST_BOUNTY_QUERY } from "../use-post-bounties";
import { endpointChain } from "../use-work";

type Send = (key: string, to: string, data: string) => Promise<boolean>;

/**
 * Money on it (N8, test networks only): people put their own money on whether a bounty will be paid; whoever is right
 * shares the other side's money. Shown under a bounty on a post when this build names the pools for its network.
 */
export function MoneyForecastPanel({
  chainId,
  id,
  record,
  currency,
  wallet,
  position,
  now,
  busy,
  gate,
  onSend,
  money,
}: {
  chainId: number;
  id: bigint;
  record: PostBountyRecord;
  currency: string;
  wallet: string | null;
  position: WalletPosition;
  now: number;
  busy: string | null;
  gate: string | null;
  onSend: Send;
  money: (units: bigint) => string;
}) {
  const fieldId = useId();
  const pool = forecastPool(chainId);
  const query = useQuery({
    queryKey: [...POST_BOUNTY_QUERY, "pool", pool, id.toString(), wallet],
    enabled: pool !== null,
    staleTime: 10_000,
    refetchOnWindowFocus: false,
    queryFn: () =>
      readMoneyForecast(
        endpointChain(getRpcEndpoint()),
        pool as string,
        id,
        wallet,
      ),
  });
  const [amountText, setAmountText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  if (!pool) return null;
  const data = query.data;
  const key = id.toString();
  const blocked = busy !== null || gate !== null;
  const open = data ? poolOpen(record, data.outcome, now) : false;
  const settleable = data
    ? poolSettleable(record, data.outcome, postRefundsOpen(record, now))
    : false;
  const noAllowed = wallet ? mayBetNo(record, wallet, position) : false;

  const bet = async (yes: boolean) => {
    setProblem(null);
    let amount: bigint;
    try {
      amount = parseUnits(amountText, 6, "amount", "The amount");
      encodeBet(id, yes, amount);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
      return;
    }
    const allowed = await onSend(
      `pool-allow-${key}`,
      currency,
      encodeApproveBounty(pool, amount),
    );
    if (!allowed) return;
    if (await onSend(`pool-bet-${key}`, pool, encodeBet(id, yes, amount))) {
      setAmountText("");
    }
  };

  const mine = data?.mine;
  return (
    <div
      className="mt-2 rounded-lg bg-black/[0.03] p-2 text-sm dark:bg-white/[0.04]"
      data-testid="money-forecast"
    >
      <p className="text-xs font-semibold">Money on it</p>
      {query.isError ? (
        <p className="text-muted-foreground" role="status">
          The pools could not be read.{" "}
          <button
            className="underline"
            onClick={() => void query.refetch()}
            type="button"
          >
            Try again
          </button>
        </p>
      ) : !data ? (
        <p className="text-muted-foreground">Reading…</p>
      ) : (
        <>
          <p data-testid="money-forecast-pools">
            {poolsLine(data.yes, data.no, money)}
          </p>
          {outcomeLine(data.outcome) ? (
            <p
              className="text-muted-foreground"
              data-testid="money-forecast-outcome"
            >
              {outcomeLine(data.outcome)}
            </p>
          ) : null}
          {mine && (mine.yes > 0n || mine.no > 0n) ? (
            <p
              className="text-xs text-muted-foreground"
              data-testid="money-forecast-mine"
            >
              {mine.yes > 0n
                ? `You put ${money(mine.yes)} on paid: about ${money(payoutIfRight(mine.yes, data.yes, data.no))} back if it is. `
                : ""}
              {mine.no > 0n
                ? `You put ${money(mine.no)} on not paid: about ${money(payoutIfRight(mine.no, data.no, data.yes))} back if it isn't.`
                : ""}
            </p>
          ) : null}
          <div className="mt-1 flex flex-wrap gap-2">
            {settleable ? (
              <Button
                data-testid="money-forecast-settle"
                disabled={blocked}
                onClick={() =>
                  void onSend(`pool-settle-${key}`, pool, encodeSettlePool(id))
                }
                size="sm"
                type="button"
                variant="outline"
              >
                Settle it
              </Button>
            ) : null}
            {mine && mine.owed > 0n && wallet ? (
              <Button
                data-testid="money-forecast-collect"
                disabled={blocked}
                onClick={() =>
                  void onSend(
                    `pool-collect-${key}`,
                    pool,
                    encodeCollect(id, wallet),
                  )
                }
                size="sm"
                type="button"
              >
                Collect {money(mine.owed)}
              </Button>
            ) : null}
          </div>
          {open && wallet ? (
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <div className="flex flex-col gap-1">
                <label
                  className="text-xs font-medium"
                  htmlFor={`${fieldId}-amount`}
                >
                  Amount
                </label>
                <Input
                  className="w-24"
                  data-testid="money-forecast-amount"
                  id={`${fieldId}-amount`}
                  inputMode="decimal"
                  onChange={(e) => setAmountText(e.target.value)}
                  placeholder="10"
                  value={amountText}
                />
              </div>
              <Button
                data-testid="money-forecast-yes"
                disabled={blocked || !amountText.trim()}
                onClick={() => void bet(true)}
                size="sm"
                type="button"
                variant="outline"
              >
                It will be paid
              </Button>
              {noAllowed ? (
                <Button
                  data-testid="money-forecast-no"
                  disabled={blocked || !amountText.trim()}
                  onClick={() => void bet(false)}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  It won't
                </Button>
              ) : null}
            </div>
          ) : null}
          {open ? (
            <p className="mt-1 text-xs text-muted-foreground">
              Test money only. Whoever is right shares the other side's money,
              by what they put in; at most 1,000 each.{" "}
              {wallet && !noAllowed
                ? "You opened this bounty or submitted work, so you can only say it will be paid."
                : ""}
            </p>
          ) : null}
        </>
      )}
      {problem ? (
        <p className="text-xs text-red-700 dark:text-red-300" role="alert">
          {problem}
        </p>
      ) : null}
    </div>
  );
}
