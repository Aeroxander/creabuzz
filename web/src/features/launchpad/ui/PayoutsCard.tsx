import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { defaultChainPreset, payoutsFactory } from "../chain-config";
import { formatUnits } from "@creaton/core/launchpad/daoActions.ts";
import {
  encodeApplySplit,
  encodeDistribute,
  encodeWithdrawPayout,
} from "@creaton/core/launchpad/payouts.ts";
import { useChainSend } from "../use-chain-send";
import { PAYOUTS_QUERY, usePayouts } from "../use-payouts";
import { FailureNote, WalletStrip } from "./account-widgets";

const date = (seconds: number) =>
  new Date(seconds * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

const percent = (bps: number) =>
  `${(bps / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;

/**
 * Payouts to holders (N10, test networks): where revenue is sent, how it is split, revenue waiting to be distributed,
 * and what the connected wallet can collect. Shown where this build names a payout factory; until the DAO votes to start
 * payouts, it says how.
 */
export function PayoutsCard({ dao }: { dao: string }) {
  const chainId = defaultChainPreset().chainId;
  const sender = useChainSend(chainId, PAYOUTS_QUERY);
  const query = usePayouts(dao, sender.wallet.address);
  if (!payoutsFactory(chainId)) return null;
  const data = query.data;
  const blocked = sender.busy !== null || sender.gate !== null;
  const usdc = (units: bigint) => `${formatUnits(units, 6)} USDC`;
  return (
    <Card className="flex flex-col gap-2 p-4 text-sm" data-testid="payouts">
      <h2 className="text-base font-semibold">Payouts to holders</h2>
      {query.isError ? (
        <p className="text-muted-foreground" role="status">
          The network did not answer, so payouts can&apos;t be shown.{" "}
          <button
            className="underline"
            onClick={() => void query.refetch()}
            type="button"
          >
            Try again
          </button>
        </p>
      ) : data === undefined ? (
        <p className="text-muted-foreground" role="status">
          Reading…
        </p>
      ) : data === null ? (
        <p className="text-muted-foreground" data-testid="payouts-none">
          None yet. A vote on the Decisions tab can start paying holders a share
          of revenue.
        </p>
      ) : (
        <>
          <p data-testid="payouts-split">
            Revenue sent to{" "}
            <span className="font-mono break-all">{data.module}</span> is split:{" "}
            {percent(data.splitBps)} to holders by how many Shares and Loot they
            hold, the rest to the treasury.
          </p>
          {data.pending ? (
            <p className="text-muted-foreground" data-testid="payouts-pending">
              A vote changed the split to {percent(data.pending.splitBps)}, from{" "}
              {date(data.pending.from)}.
            </p>
          ) : null}
          {data.waiting > 0n ? (
            <p data-testid="payouts-waiting">
              {usdc(data.waiting)} of revenue is waiting to be split.
            </p>
          ) : null}
          {data.owed !== null && data.owed > 0n ? (
            <p data-testid="payouts-owed">You can collect {usdc(data.owed)}.</p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {data.waiting > 0n ? (
              <Button
                data-testid="payouts-distribute"
                disabled={blocked}
                onClick={() =>
                  void sender.send(
                    "payouts-distribute",
                    data.module,
                    encodeDistribute(),
                  )
                }
                size="sm"
                type="button"
                variant="outline"
              >
                Split it now
              </Button>
            ) : null}
            {data.owed !== null && data.owed > 0n && sender.wallet.address ? (
              <Button
                data-testid="payouts-collect"
                disabled={blocked}
                onClick={() =>
                  void sender.send(
                    "payouts-collect",
                    data.module,
                    encodeWithdrawPayout(sender.wallet.address as string),
                  )
                }
                size="sm"
                type="button"
              >
                Collect {usdc(data.owed)}
              </Button>
            ) : null}
            {data.pending && data.now >= data.pending.from ? (
              <Button
                data-testid="payouts-apply-split"
                disabled={blocked}
                onClick={() =>
                  void sender.send(
                    "payouts-apply",
                    data.module,
                    encodeApplySplit(),
                  )
                }
                size="sm"
                type="button"
                variant="outline"
              >
                Use the new split
              </Button>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            Holders count from when they hold, keep what was paid to them after
            they sell or leave, and collect it themselves. Test money only.
          </p>
        </>
      )}
      <WalletStrip testIdPrefix="payouts" wallet={sender.wallet} />
      {sender.failure ? (
        <FailureNote message={sender.failure} testId="payouts-failure" />
      ) : null}
    </Card>
  );
}
