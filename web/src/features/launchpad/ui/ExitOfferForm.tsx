import { useId, useState } from "react";

import { existingUserPubkey } from "@/shared/lib/identity";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { formatUnits } from "../lib/dao-actions";
import { composeSellOffer, leavingLine } from "../lib/matched-exit-copy";
import { encodeApproveBounty } from "../lib/work-bounty";
import type { ConnectedWalletState } from "../use-connected-wallet";
import {
  type ExitWallet,
  type ShownOffer,
  usePublishOffer,
} from "../use-matched-exit";

type Send = (key: string, to: string, data: string) => Promise<boolean>;

/**
 * Offer Shares for sale (N5): how many, the price of one, and how long the offer lasts. The Shares stay in the seller's
 * wallet; the wallet allows the exchange to move them (once, for what the open offers need), then signs the offer, and
 * the app publishes it. Nothing moves until someone buys.
 */
export function ExitOfferForm({
  data,
  side,
  wallet,
  busy,
  gate,
  onSend,
  onDone,
}: {
  data: {
    chainId: number;
    exchange: string;
    shares: string;
    now: number;
    leavingPerShare: bigint | null;
    offers: readonly ShownOffer[];
  };
  side: ExitWallet;
  wallet: ConnectedWalletState;
  busy: string | null;
  gate: string | null;
  onSend: Send;
  onDone: () => void;
}) {
  const id = useId();
  const publish = usePublishOffer();
  const [amountText, setAmountText] = useState("");
  const [priceText, setPriceText] = useState("");
  const [daysText, setDaysText] = useState("7");
  const [problem, setProblem] = useState<string | null>(null);
  const [signing, setSigning] = useState(false);
  const seller = wallet.address ?? "";
  const result = composeSellOffer({
    amountText,
    priceText,
    daysText,
    free: side.free,
    chainTime: data.now,
    nowMs: Date.now(),
    minNonce: side.minNonce,
    chainId: data.chainId,
    exchange: data.exchange,
    sharesToken: data.shares,
    seller,
  });
  const dirty = amountText.trim() !== "" || priceText.trim() !== "";
  const openOfMine = data.offers
    .filter((o) => o.offer.seller === seller.toLowerCase())
    .reduce((sum, o) => sum + o.offer.amount, 0n);

  const submit = async () => {
    setProblem(null);
    if ("problem" in result) {
      setProblem(result.problem);
      return;
    }
    if (!existingUserPubkey()) {
      setProblem("Make an account to publish an offer.");
      return;
    }
    const needed = openOfMine + result.terms.amount;
    if (side.sharesAllowance < needed) {
      const allowed = await onSend(
        "exit-allow",
        data.shares,
        encodeApproveBounty(data.exchange, needed),
      );
      if (!allowed) return;
    }
    setSigning(true);
    try {
      await publish(wallet, result.terms);
      onDone();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setSigning(false);
    }
  };

  const leaving = leavingLine(data.leavingPerShare);
  return (
    <div className="mt-3 flex flex-col gap-3" data-testid="exit-offer-form">
      <div className="flex flex-col gap-1">
        <label className="text-sm font-medium" htmlFor={`${id}-amount`}>
          How many Shares
        </label>
        <Input
          className="w-40"
          data-testid="exit-offer-amount"
          id={`${id}-amount`}
          inputMode="decimal"
          onChange={(e) => setAmountText(e.target.value)}
          placeholder="10"
          value={amountText}
        />
        <p className="text-xs text-muted-foreground">
          You can sell up to {formatUnits(side.free, 18, 4)}.
        </p>
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-sm font-medium" htmlFor={`${id}-price`}>
          Price per Share (USDC)
        </label>
        <Input
          className="w-40"
          data-testid="exit-offer-price"
          id={`${id}-price`}
          inputMode="decimal"
          onChange={(e) => setPriceText(e.target.value)}
          placeholder="1.50"
          value={priceText}
        />
        {leaving ? (
          <p className="text-xs text-muted-foreground">{leaving}</p>
        ) : null}
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-sm font-medium" htmlFor={`${id}-days`}>
          Offer lasts (days)
        </label>
        <Input
          className="w-24"
          data-testid="exit-offer-days"
          id={`${id}-days`}
          inputMode="numeric"
          onChange={(e) => setDaysText(e.target.value)}
          value={daysText}
        />
      </div>
      {"total" in result ? (
        <p className="text-sm" data-testid="exit-offer-total">
          Buyers pay {formatUnits(result.total, 6)} USDC in all, to you.
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Your Shares stay in your wallet until someone buys them. Your wallet
        asks you to allow the exchange to move them, then to sign the offer;
        signing costs nothing. You can cancel any time.
      </p>
      {problem ? (
        <p
          className="text-sm text-red-700 dark:text-red-300"
          data-testid="exit-offer-problem"
          role="alert"
        >
          {problem}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          data-testid="exit-offer-publish"
          disabled={!dirty || signing || busy !== null || gate !== null}
          onClick={() => void submit()}
          size="sm"
          type="button"
        >
          {busy === "exit-allow"
            ? "Allowing…"
            : signing
              ? "Signing and publishing…"
              : "Publish offer"}
        </Button>
        <Button onClick={onDone} size="sm" type="button" variant="outline">
          Not now
        </Button>
      </div>
    </div>
  );
}
