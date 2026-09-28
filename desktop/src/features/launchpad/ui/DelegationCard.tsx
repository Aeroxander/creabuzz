import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "@/shared/ui/button";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { invokeTauri } from "@/shared/api/tauri";
import { usePublishLaunchMirrorMutation } from "@/features/launchpad/hooks";
import { KIND_LAUNCH_RECEIPT } from "@/shared/constants/kinds";
import { encodeDelegate } from "@/features/launchpad/lib/voteTx";
import { SELECTOR_SHARES } from "@/features/launchpad/lib/enforcedCheck";
import { HashPicker } from "@/features/launchpad/ui/HashPicker";

export interface DelegateOption {
  value: string;
  label: string;
}

/**
 * The delegation surface, desktop parity with web's `DelegationCard`
 * (agentic-governance D3/A2): revocable by design — re-delegate to yourself
 * any time (majeur's `delegates()` defaults to self). The delegation mirrors
 * a 47005 `delegate` receipt (D4); a mirror failure is reported and the tx
 * is NEVER re-sent. Delegation is the owner's own voting power — deliberately
 * NOT a budget-gated class (rule 5).
 */
export function DelegationCard({
  dao,
  members,
  author,
  launchId,
  rpcUrl,
  chainId,
}: {
  dao: string | null;
  members: readonly DelegateOption[];
  author: string;
  launchId: string;
  rpcUrl: string | null;
  chainId: string | null;
}) {
  const queryClient = useQueryClient();
  const mirror = usePublishLaunchMirrorMutation();
  const [delegatee, setDelegatee] = useState("");
  const [error, setError] = useState<string | null>(null);

  // shares() resolution: the votes live on the DAO's Shares token. (The
  // holder's CURRENT delegate is a wallet/explorer read — desktop's sender
  // model doesn't expose the signing address here, so the card states the
  // reclaim semantics rather than half-guessing an account.)
  const current = useQuery({
    queryKey: ["launchpad", "shares", rpcUrl, dao],
    queryFn: async () => {
      const sharesWord = await invokeTauri<{ returnData: string }>("evm_call", {
        rpcUrl,
        to: dao,
        data: SELECTOR_SHARES,
      });
      return `0x${sharesWord.returnData.slice(-40)}`;
    },
    enabled: Boolean(rpcUrl && dao),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const action = useMutation({
    mutationFn: async () => {
      const shares = current.data;
      if (!shares) throw new Error("no shares token");
      const call = {
        to: shares,
        data: encodeDelegate(delegatee),
        value: "0x0",
      };
      const receipt = await invokeTauri<{ status: string; txHash: string }>(
        "evm_send_transaction",
        { rpcUrl, chainId, to: call.to, data: call.data, value: call.value },
      );
      if (receipt.status === "success") {
        // D4: the assignment is a governance action — mirror it (47005,
        // table `delegate`). A mirror failure is reported; the tx already
        // landed and is never re-sent.
        try {
          await mirror.mutateAsync({
            kind: KIND_LAUNCH_RECEIPT,
            author,
            launchId,
            extraTags: [
              ["kind", "delegate"],
              ["delegate", delegatee],
              ["tx", receipt.txHash],
            ],
            content: { table: "delegate", delegate: delegatee },
          });
        } catch (err) {
          setError(
            `Delegation landed (tx ${receipt.txHash.slice(0, 10)}…) but its receipt mirror failed: ${
              err instanceof Error ? err.message : "unknown error"
            }`,
          );
        }
      }
      return receipt;
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: ["launchpad", "delegates"],
      });
    },
  });

  return (
    <section className="rounded-2xl border border-border/70 bg-card/60 px-4 py-3">
      <h3 className="text-sm font-semibold">Vote delegation</h3>
      <p className="mt-1 text-2xs text-muted-foreground">
        Your votes are cast by your delegate until you re-delegate — revocable
        at any time, including back to yourself. Agent seats may hold
        delegations (their authority is grant-scoped and named in receipts).
      </p>
      {!dao ? (
        <p className="mt-2 text-sm text-muted-foreground">
          Record-only: delegation opens when the launch is bound to a DAO.
        </p>
      ) : (
        <div className="mt-2">
          <HashPicker
            id="delegate-target"
            label="Delegate to"
            onValueChange={setDelegatee}
            options={members}
            placeholder="0x… (delegate address)"
            testId="delegate-target"
            value={delegatee}
          />
          <p className="mt-1 text-2xs text-muted-foreground">
            To reclaim, delegate to your own address (choose “Enter manually…”
            with your wallet address).
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <Button
              data-testid="delegate-send"
              disabled={action.isPending || delegatee === "" || !current.data}
              onClick={() => {
                setError(null);
                action.mutate();
              }}
              size="sm"
              type="button"
            >
              Delegate votes
            </Button>
            {delegatee !== "" ? (
              <span className="text-2xs text-muted-foreground">
                to{" "}
                <span className="font-mono">{truncatePubkey(delegatee)}</span>
              </span>
            ) : null}
          </div>
          {error ? (
            <p
              className="mt-1 text-xs text-red-700 dark:text-red-400"
              role="alert"
            >
              {error}
            </p>
          ) : null}
          <p className="mt-1 text-2xs text-muted-foreground">
            Mirrors a 47005 `delegate` receipt — the assignment is public
            record; the votes remain yours to reclaim.
          </p>
        </div>
      )}
    </section>
  );
}
