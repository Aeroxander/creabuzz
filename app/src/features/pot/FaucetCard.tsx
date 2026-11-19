/**
 * Get play dollars: the test network's faucet, once per account. It says what it gives and that it is play money, and an
 * account that already took its dollars is told so instead of being offered a press that would be refused.
 */
import { smallDollarsText } from "./pot-words";
import { faucetCall } from "@creaton/core/pot/pot-calls.ts";
import { faucetAmount, faucetUsedBy } from "@creaton/core/pot/pot-state.ts";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "../../ui/button";
import { PotSheet } from "./PotSheet";
import type { MoneyTarget } from "./target";
import type { Ready } from "./use-pot";

export function FaucetCard({
  target,
  ready,
}: {
  target: MoneyTarget;
  ready: Ready;
}) {
  const [open, setOpen] = useState(false);
  const dollar = target.dollar;
  const reading = useQuery({
    queryKey: ["pot", "faucet", dollar, ready.address],
    enabled: Boolean(dollar) && open,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: async () => ({
      used: await faucetUsedBy(ready.read, dollar ?? "", ready.address),
      amount: await faucetAmount(ready.read, dollar ?? ""),
    }),
  });
  if (!dollar || !target.playMoney) return null;
  const data = reading.data;
  return (
    <>
      <Button
        block
        data-testid="faucet-open"
        onClick={() => setOpen(true)}
        variant="secondary"
      >
        Get play dollars
      </Button>
      <PotSheet
        account={ready.address}
        action={`faucet:${target.chainId}:${dollar}`}
        blocked={!data || data.used}
        calls={data && !data.used ? [faucetCall(dollar)] : null}
        chainId={target.chainId}
        confirmLabel={
          data
            ? `Get ${smallDollarsText(data.amount)} play dollars`
            : "Get play dollars"
        }
        done="You have your play dollars."
        lookLabel="Look for your play dollars"
        onOpenChange={setOpen}
        open={open}
        playMoney
        problemAction="faucet"
        testId="faucet-sheet"
        title="Get play dollars"
      >
        {reading.isPending ? (
          <p className="text-sm text-muted">Looking…</p>
        ) : reading.isError || !data ? (
          <div className="flex flex-col gap-2" data-testid="faucet-read-failed">
            <p className="text-sm">
              The faucet could not be read, so nothing can be sent now. Try
              again.
            </p>
            <Button onClick={() => void reading.refetch()} variant="secondary">
              Try again
            </Button>
          </div>
        ) : data.used ? (
          <p className="text-sm" data-testid="faucet-used">
            This account already took its play dollars. The faucet gives them
            once to each account. Use another account to get more.
          </p>
        ) : (
          <p className="text-sm" data-testid="faucet-words">
            You get {smallDollarsText(data.amount)} play dollars, once for this
            account. Play dollars are for trying the app: they have no value
            outside it.
          </p>
        )}
      </PotSheet>
    </>
  );
}
