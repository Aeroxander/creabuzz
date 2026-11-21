/**
 * The Park sheet: park some of the Shares in your wallet in the project's pause contract. The sheet reads the chain when it
 * opens (`park-read.ts`), shows what parking does to the share parked, and sends `approve` then `park` through the one money
 * sheet every press goes through. Parking moves no money and costs no fee; the Shares stay the person's.
 */
import { balanceOf } from "@creaton/core/pot/pot-reads.ts";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import { potProblem } from "../money/pot-copy";
import { useSenderWords } from "../money/use-money";
import { PotSheet } from "../pot/PotSheet";
import { sharesWords } from "../pot/pot-words";
import type { Portion } from "../pot/takeout-read";
import type { MoneyTarget } from "../pot/target";
import type { Ready } from "../pot/use-pot";
import {
  PARK_CANNOT_READ,
  PARK_DONE,
  PARK_FIRST,
  PARK_NONE,
  PARK_ONE_PRESS,
  PARK_PASSKEY,
  PARK_SECOND,
  PARK_TITLE,
  PARK_WALLET,
  parkSummary,
} from "./pause-words";
import { PortionPicker } from "./PortionPicker";
import { type ParkRead, readPark } from "./park-read";

export default function ParkSheet({
  open,
  onClose,
  ready,
  target,
  projectName,
  recordReadable,
}: {
  open: boolean;
  onClose: () => void;
  ready: Ready;
  target: MoneyTarget;
  projectName: string;
  /** The record's pause key read (not null): false means the sheet says it could not be read and offers no press. */
  recordReadable: boolean;
}) {
  const [portion, setPortion] = useState<Portion>("all");
  const words = useSenderWords();
  const passkey = words.kind === "passkey";
  const reading = useQuery({
    queryKey: ["pot", "park", target.treasury, ready.address, portion],
    enabled: open,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: () =>
      readPark(ready.read, target, ready.address, portion, recordReadable),
  });
  const data: ParkRead | undefined = reading.data;
  const good = data?.ok ? data : null;
  const close = () => {
    setPortion("all");
    onClose();
  };

  let body: React.ReactNode;
  if (reading.isPending)
    body = <Card className="h-32 animate-pulse" data-testid="park-reading" />;
  else if (reading.isError)
    body = (
      <div className="flex flex-col gap-3" data-testid="park-read-failed">
        <p className="text-sm">
          {PARK_CANNOT_READ} {potProblem(reading.error, "park")}
        </p>
        <Button onClick={() => void reading.refetch()} variant="secondary">
          Try again
        </Button>
      </div>
    );
  else if (data && !data.ok)
    body = (
      <>
        {data.why === "tiny" ? (
          <PortionPicker
            legend="How much to park"
            name="park-portion"
            onChange={setPortion}
            testIdPrefix="park-portion"
            value={portion}
          />
        ) : null}
        <p className="text-sm" data-testid={`park-${data.why}`}>
          {data.why === "none"
            ? PARK_NONE
            : data.why === "tiny"
              ? "That part is too small to park. Choose a bigger part."
              : PARK_CANNOT_READ}
        </p>
      </>
    );
  else if (good)
    body = (
      <>
        <PortionPicker
          legend="How much to park"
          name="park-portion"
          onChange={setPortion}
          testIdPrefix="park-portion"
          value={portion}
        />
        <p className="text-sm" data-testid="park-summary">
          {parkSummary({
            n: good.shares,
            parkedAfter: good.state.parked + good.shares,
            backers: good.state.backerShares,
            divisor: good.lineDivisor,
            dayLength: good.dayLength,
          })}
        </p>
        <p className="text-sm text-muted" data-testid="park-second">
          {PARK_SECOND}
        </p>
      </>
    );
  else body = null;

  return (
    <PotSheet
      account={ready.address}
      action={`park:${target.chainId}:${target.treasury}`}
      calls={good ? good.calls : null}
      chainId={target.chainId}
      confirmLabel="Park"
      description={`Parking Shares in ${projectName}`}
      detail={good ? `${good.shares}:${good.wallet}`.slice(0, 80) : undefined}
      done={PARK_DONE}
      landed={async (wallet, from, earlier) => {
        // A call replaced in the wallet may have landed under another hash: fewer Shares in the wallet now say so.
        const [shares, before] = (earlier.detail ?? "").split(":");
        if (!shares || !before || !/^\d+$/.test(before)) return false;
        const now = await balanceOf(
          (to, data) => wallet.readCall(to, data),
          target.shares,
          from,
        );
        return now < BigInt(before);
      }}
      lookLabel="Look for your parking"
      onOpenChange={(next) => {
        if (!next) close();
      }}
      open={open}
      playMoney={target.playMoney}
      problemAction="park"
      recheck={async () => {
        // What the sheet showed stands on the wallet's Shares: if they moved since, nothing is parked on the old numbers.
        if (!good) return null;
        const now = await balanceOf(ready.read, target.shares, ready.address);
        return now === good.wallet
          ? null
          : "Your Shares changed since this was shown. Nothing was sent. Close this and open it again.";
      }}
      testId="park-sheet"
      title={PARK_TITLE}
    >
      <div aria-live="polite" className="flex flex-col gap-4">
        <p className="text-sm" data-testid="park-first">
          {PARK_FIRST}
          {passkey ? ` ${PARK_ONE_PRESS}` : ""}
        </p>
        <p className="text-sm text-muted" data-testid="park-account-line">
          {passkey ? PARK_PASSKEY : PARK_WALLET}
        </p>
        {good ? (
          <p className="text-sm text-muted">
            You hold {sharesWords(good.wallet)} Shares in {words.own}.
          </p>
        ) : null}
        {body}
      </div>
    </PotSheet>
  );
}
