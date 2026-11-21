/**
 * The Back sheet: what a person reads before the one press. It opens on an amount, reads the chain at that moment (the
 * quote, the fee, the door, what the account holds) and shows exactly what will be put into the call: what you pay, the
 * fee to the platform, the Shares you get and what taking out right now would give. The guard on the Shares comes from that
 * same quote. A shut door, an amount that buys nothing, or too few play dollars say what to do instead of offering the press.
 */
import { QUOTE_TOLERANCE_BPS } from "@creaton/core/pot/pot-plans.ts";
import { balanceOf } from "@creaton/core/pot/pot-reads.ts";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useAccount } from "../../lib/account";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import type { ProjectNumbers } from "../money/numbers";
import { potProblem } from "../money/pot-copy";
import { type BackRead, readBack } from "./back-read";
import { plannedBackLine } from "./back-tasks";
import {
  LINK_CHOICE,
  LINK_CHOICE_HINT,
  LINK_NEEDS_ACCOUNT,
} from "../room/room-words";
import {
  canLinkAfterBack,
  useLinkAfterBack,
} from "../room/use-link-after-back";
import { rememberStep } from "./own-history";
import { senderKind } from "../money/wallet";
import { PotSheet } from "./PotSheet";
import type { Ready } from "./use-pot";
import {
  NOT_A_RETURN,
  backLockedWords,
  exactDollarsText,
  rateWords,
  sharesWords,
  smallDollarsText,
} from "./pot-words";

/** What a typed amount's fee is as a percent: "2%". */
function percentWords(bps: number): string {
  const percent = bps / 100;
  return `${Number.isInteger(percent) ? percent : percent.toFixed(2)}%`;
}

function Line({
  label,
  value,
  testId,
  strong,
}: {
  label: string;
  value: string;
  testId: string;
  strong?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <dt className="text-sm text-muted">{label}</dt>
      <dd
        className={`num text-right ${strong ? "font-semibold" : ""}`}
        data-testid={testId}
      >
        {value}
      </dd>
    </div>
  );
}

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
  // The last step of a Back that landed: the account is linked to this wallet, so the project's room opens for it.
  const linkAfterBack = useLinkAfterBack(ready.wallet);
  // The link makes the wallet public, so it is a choice in plain sight, made before the Back and never silently afterwards. The
  // box starts unticked (a box that is already ticked is not consent); the room offers the same link as one press where it is needed.
  const [wantLink, setWantLink] = useState(false);
  const { pubkey } = useAccount();
  // The room link needs an account; with none the box is not offered (a ticked box would do nothing), and one sentence says why.
  const canLink = canLinkAfterBack(ready.wallet);
  const offerLink = canLink && pubkey !== null;
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
  const guard = good?.plan.minShares ?? 0n;
  // The fee as the chain charged it on this amount (the record's percent is hours old), to the nearest hundredth of a percent.
  const feeBps =
    good && amount !== null && amount > 0n
      ? Number(((good.fee * 20_000n) / amount + 1n) / 2n)
      : numbers.feeBps;
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
          The price could not be read from the network, so nothing can be sent
          now. Nothing was taken. {potProblem(reading.error, "back")}
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
          ? "The door to new backing is shut right now, so nothing can be sent. You can still take your money out. Look again when the team has checked in or opened the door."
          : "That amount is too small to buy any Shares at the price now. Nothing was taken. Go back and enter more."}
      </p>
    );
  else if (good && amount !== null)
    body = (
      <>
        <dl className="divide-y divide-white/10">
          <Line
            label="You pay"
            testId="back-pay"
            value={`${exactDollarsText(amount)} dollars`}
          />
          <Line
            label="Fee to the platform, part of that"
            testId="back-fee"
            value={`${exactDollarsText(good.fee)} dollars (${percentWords(feeBps)})`}
          />
          <Line
            label="You get"
            strong
            testId="back-shares"
            value={`${sharesWords(good.plan.quote.shares)} Shares`}
          />
          <Line
            label="Taking out right now would give you"
            testId="back-now"
            value={`${smallDollarsText(good.plan.quote.takeOutNow)} dollars`}
          />
        </dl>
        <p className="text-sm text-muted">{NOT_A_RETURN}</p>
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
            You hold {smallDollarsText(good.dollars)} play dollars, which is
            less than the {exactDollarsText(amount)} this needs. Nothing was
            taken. Get more play dollars on the project page, or enter less.
          </p>
        ) : null}
        {canLink && !offerLink ? (
          <p
            className="text-sm text-muted"
            data-testid="back-link-needs-account"
          >
            {LINK_NEEDS_ACCOUNT}
          </p>
        ) : null}
        {offerLink ? (
          <div className="flex flex-col gap-1">
            <label className="flex min-h-11 cursor-pointer items-start gap-2 text-sm">
              <input
                aria-describedby="back-link-hint"
                checked={wantLink}
                className="mt-0.5 size-5 shrink-0 accent-current"
                data-testid="back-link-choice"
                onChange={(event) => setWantLink(event.target.checked)}
                type="checkbox"
              />
              <span>{LINK_CHOICE}</span>
            </label>
            <p
              className="text-sm text-muted"
              data-testid="back-link-hint"
              id="back-link-hint"
            >
              {LINK_CHOICE_HINT}
            </p>
          </div>
        ) : null}
        <details className="text-sm">
          <summary className="min-h-11 cursor-pointer font-semibold">
            Details
          </summary>
          <ul className="mt-1 flex list-disc flex-col gap-1.5 pl-5 text-muted">
            <li>
              The team may take up to {rateWords(good.ratePpm)} of the project's
              money a day.
            </li>
            <li data-testid="back-locked">
              {backLockedWords(good.plan.quote.locked)}
            </li>
            <li data-testid="back-arriving">
              Money from outside still arriving:{" "}
              {good.plan.quote.arriving === 0n
                ? "none"
                : `${smallDollarsText(good.plan.quote.arriving)} dollars`}
              .
            </li>
            <li data-testid="back-guard">
              If the price moves against you by more than{" "}
              {percentWords(Number(QUOTE_TOLERANCE_BPS))} before this lands,
              nothing is taken. You are guaranteed at least {sharesWords(guard)}{" "}
              Shares.
            </li>
            <li>
              {good.plan.oneSignature
                ? "This is one signature."
                : senderKind(ready.wallet) === "passkey"
                  ? "Your passkey is asked once, for both steps: letting the project take the dollars, and backing. The server pays the network fee."
                  : "This is two signatures: one to let the project take the dollars, one to back."}
            </li>
          </ul>
        </details>
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
      description={`Backing ${projectName}`}
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
        void linkAfterBack(wantLink && offerLink);
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
