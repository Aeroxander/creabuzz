import { useId, useState } from "react";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import { useToast } from "../../ui/toast";
import { DEFAULT_SHARES_PER_RAW_DOLLAR, openBackingCall } from "./calls";
import { OwnershipLine } from "./MoneyTab";
import { moneyProblem } from "./money-copy";
import { dollarsText, type ProjectNumbers, sharesPerDollar } from "./numbers";
import { useMoneySend } from "./use-money";

/**
 * The founder's one press to open a 24-hour backing round at the price every project has (1 dollar buys 3,000
 * Shares), sized to what is left under the stage's limit. The plan's budget: 1 press, nothing typed.
 */
export function OpenBacking({ numbers }: { numbers: ProjectNumbers }) {
  const send = useMoneySend();
  const toast = useToast();
  const [problem, setProblem] = useState<string | null>(null);
  const titleId = useId();
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
      <Button
        block
        data-testid="open-backing-press"
        disabled={send.isPending}
        onClick={() => {
          setProblem(null);
          send.mutate(
            {
              chainId: numbers.chainId,
              build: () => [openBackingCall(numbers.launcher, numbers.key)],
            },
            {
              onSuccess: () => toast("The round is open for 24 hours.", "done"),
              onError: (error) => setProblem(moneyProblem(error, "open")),
            },
          );
        }}
      >
        {send.isPending ? "Waiting for your wallet…" : "Open backing"}
      </Button>
    </Card>
  );
}
