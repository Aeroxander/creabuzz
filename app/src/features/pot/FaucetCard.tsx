/**
 * Get play dollars: the test network's faucet, once per account, in one press. It is drawn only while the account has not
 * taken its dollars, so there is no press that would be refused.
 */
import { faucetCall } from "@creaton/core/pot/pot-calls.ts";
import { faucetUsedBy } from "@creaton/core/pot/pot-state.ts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "../../ui/button";
import { useToast } from "../../ui/toast";
import { potProblem } from "../money/problems";
import { useMoneySend } from "../money/use-money";
import type { MoneyTarget } from "./target";
import type { Ready } from "./use-pot";

export function FaucetCard({
  target,
  ready,
}: {
  target: MoneyTarget;
  ready: Ready;
}) {
  const dollar = target.dollar;
  const send = useMoneySend(`faucet:${target.chainId}:${dollar}`);
  const toast = useToast();
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<string | null>(null);
  const used = useQuery({
    queryKey: ["pot", "faucet", dollar, ready.address],
    enabled: Boolean(dollar) && target.playMoney,
    staleTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: () => faucetUsedBy(ready.read, dollar ?? "", ready.address),
  });
  // Nothing is drawn until the chain says this account has not taken its dollars (a read that fails draws nothing).
  if (!dollar || !target.playMoney || used.data !== false) return null;
  return (
    <div className="flex flex-col gap-2">
      <Button
        block
        data-testid="faucet-open"
        disabled={send.isPending}
        onClick={() => {
          setProblem(null);
          send.send(
            { chainId: target.chainId, build: () => [faucetCall(dollar)] },
            {
              onSuccess: () => {
                toast("You have your play dollars.", "done");
                void queryClient.invalidateQueries({ queryKey: ["pot"] });
              },
              onError: (error) => setProblem(potProblem(error, "faucet")),
            },
          );
        }}
        variant="secondary"
      >
        {send.isPending
          ? send.words.waiting
          : send.waiting
            ? "Look for your play dollars"
            : "Get play dollars"}
      </Button>
      {problem ? (
        <p
          className="text-sm text-danger"
          data-testid="faucet-problem"
          role="alert"
        >
          {problem}
        </p>
      ) : null}
    </div>
  );
}
