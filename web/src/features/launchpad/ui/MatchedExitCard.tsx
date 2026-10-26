import { useState } from "react";

import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { defaultChainPreset } from "../chain-config";
import {
  encodeActivateExitExchange,
  encodeCancelBelow,
  encodeCancelOffer,
  encodeFill,
} from "../lib/matched-exit";
import {
  cancelAllNonce,
  leavingLine,
  offerLine,
  salesStateLine,
} from "../lib/matched-exit-copy";
import { formatUnits } from "../lib/dao-actions";
import { encodeApproveBounty } from "../lib/work-bounty";
import { useChainSend } from "../use-chain-send";
import {
  type ExitWallet,
  MATCHED_EXIT_QUERY,
  type ShownOffer,
  useMatchedExit,
} from "../use-matched-exit";
import { useWalletLabels } from "../use-wallet-labels";
import { FailureNote, WalletStrip } from "./auction-widgets";
import { ExitOfferForm } from "./ExitOfferForm";

type Send = (key: string, to: string, data: string) => Promise<boolean>;

/**
 * Sales between members (N5), on a project's Funds tab: a member who wants out offers Shares at a price they choose,
 * and someone who wants in buys them. The money goes to the seller, not the project. Shown only where this build names
 * an exchange and the DAO's Shares are locked; it says where things stand until the DAO has voted sales on and they
 * were switched on 30 days later.
 */
export function MatchedExitCard({ dao }: { dao: string }) {
  const sender = useChainSend(defaultChainPreset().chainId, MATCHED_EXIT_QUERY);
  const { exchange, query } = useMatchedExit(dao, sender.wallet.address);
  const data = query.data;
  const labelOf = useWalletLabels(
    (data?.offers ?? []).map((o) => o.offer.seller),
  );
  const [selling, setSelling] = useState(false);
  if (!exchange || data === null) return null;
  if (data?.state.phase === "unlocked") return null;

  const wallet = sender.wallet.address?.toLowerCase() ?? null;
  const mine = (data?.offers ?? [])
    .filter((o) => o.offer.seller === wallet)
    .map((o) => o.offer);
  const allNonce = cancelAllNonce(mine);
  const blocked = sender.busy !== null || sender.gate !== null;
  const leaving = leavingLine(data?.leavingPerShare ?? null);

  return (
    <Card className="p-4" data-testid="exit-sales">
      <h2 className="text-base font-semibold">Sales between members</h2>
      {query.isError ? (
        <p className="mt-1 text-sm text-muted-foreground" role="status">
          The network did not answer, so sales can&apos;t be shown.{" "}
          <button
            className="underline"
            onClick={() => void query.refetch()}
            type="button"
          >
            Try again
          </button>
        </p>
      ) : data === undefined ? (
        <p className="mt-1 text-sm text-muted-foreground" role="status">
          Reading…
        </p>
      ) : (
        <>
          <p className="mt-1 text-sm" data-testid="exit-sales-state">
            {salesStateLine(data.state.phase, data.state.opensAt)}
          </p>
          {data.state.phase === "ready" ? (
            <Button
              className="mt-2"
              data-testid="exit-sales-switch-on"
              disabled={blocked}
              onClick={() =>
                void sender.send(
                  "exit-switch-on",
                  data.shares,
                  encodeActivateExitExchange(),
                )
              }
              size="sm"
              type="button"
            >
              {sender.busy === "exit-switch-on"
                ? "Switching on…"
                : "Switch on sales"}
            </Button>
          ) : null}
          {data.state.phase === "on" ? (
            <>
              {leaving ? (
                <p
                  className="mt-1 text-sm text-muted-foreground"
                  data-testid="exit-sales-leaving"
                >
                  {leaving}
                </p>
              ) : null}
              {data.offers.length === 0 ? (
                <p
                  className="mt-2 text-sm text-muted-foreground"
                  data-testid="exit-sales-none"
                >
                  No offers right now.
                </p>
              ) : (
                <ul
                  className="mt-2 flex flex-col gap-2"
                  data-testid="exit-sales-offers"
                >
                  {data.offers.map((shown) => (
                    <OfferItem
                      blocked={blocked}
                      busy={sender.busy}
                      exchange={data.exchange}
                      key={shown.status.digest}
                      labelOf={labelOf}
                      onSend={sender.send}
                      shown={shown}
                      side={data.wallet}
                      usdc={data.usdc}
                      wallet={wallet}
                    />
                  ))}
                </ul>
              )}
              <div className="mt-2 flex flex-wrap gap-2">
                {data.wallet && data.wallet.free > 0n && !selling ? (
                  <Button
                    data-testid="exit-sales-sell"
                    onClick={() => setSelling(true)}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    Offer Shares for sale
                  </Button>
                ) : null}
                {allNonce !== null ? (
                  <Button
                    data-testid="exit-sales-cancel-all"
                    disabled={blocked}
                    onClick={() =>
                      void sender.send(
                        "exit-cancel-all",
                        data.exchange,
                        encodeCancelBelow(allNonce),
                      )
                    }
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    Cancel all my offers
                  </Button>
                ) : null}
              </div>
              {selling && data.wallet ? (
                <ExitOfferForm
                  busy={sender.busy}
                  data={data}
                  gate={sender.gate}
                  onDone={() => setSelling(false)}
                  onSend={sender.send}
                  side={data.wallet}
                  wallet={sender.wallet}
                />
              ) : null}
            </>
          ) : null}
        </>
      )}
      <WalletStrip testIdPrefix="exit-sales" wallet={sender.wallet} />
      {sender.failure ? (
        <FailureNote message={sender.failure} testId="exit-sales-failure" />
      ) : null}
    </Card>
  );
}

function OfferItem({
  shown,
  side,
  wallet,
  exchange,
  usdc,
  blocked,
  busy,
  onSend,
  labelOf,
}: {
  shown: ShownOffer;
  side: ExitWallet | null;
  wallet: string | null;
  exchange: string;
  usdc: string;
  blocked: boolean;
  busy: string | null;
  onSend: Send;
  labelOf: (address: string) => string;
}) {
  const { offer, status } = shown;
  const key = status.digest.slice(2, 14);
  const own = wallet !== null && offer.seller === wallet;
  const short = side !== null && side.usdcBalance < offer.price;
  const buy = async () => {
    if (!side) return;
    if (side.usdcAllowance < offer.price) {
      const allowed = await onSend(
        `exit-pay-${key}`,
        usdc,
        encodeApproveBounty(exchange, offer.price),
      );
      if (!allowed) return;
    }
    await onSend(`exit-buy-${key}`, exchange, encodeFill(offer));
  };
  return (
    <li className="text-sm" data-testid="exit-sales-offer">
      <p>{offerLine(offer, own ? "you" : labelOf(offer.seller))}</p>
      {!status.fillable ? (
        <p className="text-xs text-muted-foreground">
          Can&apos;t be bought right now: the seller no longer has these Shares
          free to sell.
        </p>
      ) : null}
      <div className="mt-1 flex flex-wrap items-center gap-2">
        {own ? (
          <Button
            data-testid="exit-sales-cancel"
            disabled={blocked}
            onClick={() =>
              void onSend(
                `exit-cancel-${key}`,
                exchange,
                encodeCancelOffer(offer),
              )
            }
            size="sm"
            type="button"
            variant="outline"
          >
            {busy === `exit-cancel-${key}` ? "Cancelling…" : "Cancel"}
          </Button>
        ) : side && status.fillable ? (
          <>
            <Button
              data-testid="exit-sales-buy"
              disabled={blocked || short}
              onClick={() => void buy()}
              size="sm"
              type="button"
            >
              {busy === `exit-pay-${key}`
                ? "Allowing the payment…"
                : busy === `exit-buy-${key}`
                  ? "Buying…"
                  : "Buy"}
            </Button>
            {short ? (
              <span className="text-xs text-muted-foreground">
                You have {formatUnits(side.usdcBalance, 6)} USDC.
              </span>
            ) : null}
          </>
        ) : null}
      </div>
    </li>
  );
}
