/**
 * The Back sheet: what a person reads before the one press. It opens on an amount, reads the chain at that moment (the
 * quote, the door, what the account holds) and shows what will be put into the call: what you pay, the Shares you get and
 * what taking out right now would give. The guard on the Shares comes from that same quote. A shut door, an amount that buys nothing, or too few play dollars say what to do instead of offering the press.
 */
import { balanceOf } from "@creaton/core/pot/pot-reads.ts";
import { useQuery } from "@tanstack/react-query";
import { Button } from "../../ui/button";
import { Row } from "../../ui/row";
import { Card } from "../../ui/card";
import type { ProjectNumbers } from "../money/numbers";
import { type BackRead, readBack } from "./back-read";
import { plannedBackLine } from "./back-tasks";
import { FaucetCard } from "./FaucetCard";
import { rememberStep } from "./own-history";
import { PotSheet } from "./PotSheet";
import { targetOf } from "./target";
import type { Ready } from "./use-pot";
import {
  NOT_A_RETURN,
  backLockedWords,
  exactDollarsText,
  rateWords,
  sharesWords,
  smallDollarsText,
} from "../money/copy";

export function BackSheet({
  numbers,
  projectName,
  amount,
  ready,
  onClose,
}: {
  numbers: ProjectNumbers;
  projectName: string;
  /** The amount in dollar units; null while the sheet is shut. */
  amount: bigint | null;
  ready: Ready;
  onClose: () => void;
}) {
  const { treasury, shares } = numbers.contracts;
  const open = amount !== null;
  // From the record's rows, which the page already holds: never a read of the sheet's own.
  const planned = plannedBackLine(numbers);
  const reading = useQuery({
    queryKey: [
      "pot",
      "back",
      treasury,
      amount?.toString() ?? "",
      ready.address,
    ],
    enabled: open,
    // A quote is read afresh every time the sheet opens, and never kept for the next one.
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: () => readBack(ready.read, numbers, amount ?? 0n, ready.address),
  });
  const data: BackRead | undefined = reading.data;
  const good = data?.ok ? data : null;
  const short = good !== null && good.dollars < (amount ?? 0n);
  const calls = good && !short ? good.plan.calls : null;
  // The fee as the chain charged it on this amount (the record's percent is hours old), to the nearest hundredth of a percent.
  const feePercent =
    good && amount !== null && amount > 0n
      ? `${Number(((good.fee * 20_000n) / amount + 1n) / 2n) / 100}%`
      : "";
  const detail =
    good && amount !== null
      ? `${amount}:${good.sharesBefore}`.slice(0, 80)
      : undefined;

  let body: React.ReactNode;
  if (reading.isPending)
    body = <Card className="h-32 animate-pulse" data-testid="back-reading" />;
  else if (reading.isError)
    body = (
      <div className="flex flex-col gap-3" data-testid="back-read-failed">
        <p className="text-sm">
          The price could not be read, so nothing was taken.
        </p>
        <Button onClick={() => void reading.refetch()} variant="secondary">
          Try again
        </Button>
      </div>
    );
  else if (data && !data.ok)
    body = (
      <p className="text-sm" data-testid={`back-${data.why}`}>
        {data.why === "door-shut"
          ? "Backing is shut right now. You can still take your money out."
          : "That is too small to buy any Shares. Enter more."}
      </p>
    );
  else if (good && amount !== null)
    body = (
      <>
        <dl className="divide-y divide-white/10">
          <Row
            label="You pay"
            testId="back-pay"
            value={`${exactDollarsText(amount)} dollars`}
          />
          <Row
            label="You get"
            strong
            testId="back-shares"
            value={`${sharesWords(good.plan.quote.shares)} Shares`}
          />
          <Row
            label="Taking out now would give"
            testId="back-now"
            value={`${smallDollarsText(good.plan.quote.takeOutNow)} dollars`}
          />
        </dl>
        <p className="text-sm text-muted">{NOT_A_RETURN}</p>
        <p className="text-sm" data-testid="back-rate">
          The team may take up to {rateWords(good.ratePpm)} of the money a day.
        </p>
        {good.fee > 0n ? (
          <p className="text-sm" data-testid="back-fee">
            Creaton keeps {feePercent} of what you pay.
          </p>
        ) : null}
        {good.plan.quote.locked > 0n ? (
          <p className="text-sm" data-testid="back-locked">
            {backLockedWords(good.plan.quote.locked)}
          </p>
        ) : null}
        {planned ? (
          <p className="text-sm" data-testid="back-planned">
            {planned}
          </p>
        ) : null}
        {short ? (
          <p
            className="text-sm text-danger"
            data-testid="back-short"
            role="alert"
          >
            You hold {smallDollarsText(good.dollars)} play dollars, less than{" "}
            {exactDollarsText(amount)}.
          </p>
        ) : null}
        {/* The way out of a shortfall is in the sheet itself: the press is drawn only while the faucet is unused. */}
        {short ? <FaucetCard ready={ready} target={targetOf(numbers)} /> : null}
      </>
    );
  else body = null;

  return (
    <PotSheet
      account={ready.address}
      action={`back:${numbers.chainId}:${treasury}`}
      blocked={short}
      calls={calls}
      chainId={numbers.chainId}
      confirmLabel={
        amount === null
          ? "Back"
          : `Back with ${exactDollarsText(amount)} dollars`
      }
      detail={detail}
      done="Backed. Your new Shares show on this page."
      landed={async (wallet, from, earlier) => {
        // A call replaced in the wallet may have landed under another hash: the Shares this account holds now say.
        const [paid, before] = (earlier.detail ?? "").split(":");
        if (!paid || !before || !/^\d+$/.test(before)) return false;
        const now = await balanceOf(
          (to, data) => wallet.readCall(to, data),
          shares,
          from,
        );
        return now > BigInt(before);
      }}
      lookLabel="Look for your backing"
      onLanded={(txHash, landed) => {
        // An earlier press that was looked up is not this amount: it is not written down as if it were.
        if (good && amount !== null && landed === detail)
          rememberStep(ready.address, {
            kind: "back",
            project: numbers.key,
            at: Math.floor(Date.now() / 1000),
            dollars: amount.toString(),
            shares: good.plan.quote.shares.toString(),
            txHash,
          });
      }}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      open={open}
      playMoney={numbers.playMoney}
      problemAction="back"
      testId="back-sheet"
      title={`Back ${projectName}`}
    >
      {/* What arrives after the sheet opened (the quote, a refusal) is read out. */}
      <div aria-live="polite" className="flex flex-col gap-4">
        {body}
      </div>
    </PotSheet>
  );
}
