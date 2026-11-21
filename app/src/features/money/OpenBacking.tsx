import { useId, useState } from "react";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import { useToast } from "../../ui/toast";
import { DEFAULT_SHARES_PER_RAW_DOLLAR, openBackingCall } from "./calls-v1";
import { OwnershipLine } from "./OwnershipLine";
import { moneyProblem } from "./money-copy";
import {
  dollarsText,
  isRunner,
  type ProjectNumbers,
  sharesPerDollar,
} from "./numbers-v1";
import { useConnectWallet, useMoneySend } from "./use-money";

/**
 * The founder's one press to open a 24-hour backing round at the price every project has (1 dollar buys 3,000
 * Shares), sized to what is left under the stage's limit. The plan's budget: 1 press, nothing typed.
 */
export function OpenBacking({
  numbers,
  address,
}: {
  numbers: ProjectNumbers;
  /** The wallet account this site sees, or null. Only the wallet that runs the project can open a round. */
  address: string | null;
}) {
  const send = useMoneySend(
    `open:${numbers.chainId}:${numbers.launcher}:${numbers.key}`,
  );
  const connect = useConnectWallet();
  const toast = useToast();
  const [problem, setProblem] = useState<string | null>(null);
  const titleId = useId();
  const runner = isRunner(numbers, address);
  return (
    <Card
      aria-labelledby={titleId}
      className="flex flex-col gap-3"
      data-testid="open-backing"
      role="region"
    >
      <div>
        <h2 className="headline text-xl" id={titleId}>
          Open a backing round
        </h2>
        <p className="mt-1 text-sm text-muted">
          24 hours. 1 dollar buys{" "}
          {sharesPerDollar(DEFAULT_SHARES_PER_RAW_DOLLAR)} Shares, the same for
          every project. Up to {dollarsText(numbers.raised.left)} dollars, what
          is left under this stage's limit.
        </p>
      </div>
      <OwnershipLine />
      {problem ? (
        <p
          className="rounded-xl bg-white/8 px-3 py-2 text-sm text-danger"
          data-testid="open-backing-problem"
          role="alert"
        >
          {problem}
        </p>
      ) : null}
      {runner ? null : (
        <p className="text-sm" data-testid="open-backing-runner">
          {send.words.kind === "passkey"
            ? "This account does not run this project. Only the account that put the project on the network can open backing."
            : address
              ? "This wallet does not run this project. Switch your wallet to the account that put the project on the network to open backing."
              : "Connect the wallet that runs this project to open backing."}
        </p>
      )}
      {runner ? (
        <Button
          block
          data-testid="open-backing-press"
          disabled={send.isPending}
          onClick={() => {
            setProblem(null);
            send.send(
              {
                chainId: numbers.chainId,
                build: () => [openBackingCall(numbers.launcher, numbers.key)],
              },
              {
                onSuccess: () =>
                  toast("The round is open for 24 hours.", "done"),
                onError: (error) => setProblem(moneyProblem(error, "open")),
              },
            );
          }}
        >
          {send.isPending
            ? send.words.waiting
            : send.waiting
              ? "Look for your round"
              : "Open backing"}
        </Button>
      ) : address ? null : (
        <Button
          disabled={connect.isPending}
          onClick={() =>
            connect.mutate(undefined, {
              onError: (error) => setProblem(moneyProblem(error, "connect")),
            })
          }
          size="sm"
          variant="secondary"
        >
          Connect your wallet
        </Button>
      )}
    </Card>
  );
}
