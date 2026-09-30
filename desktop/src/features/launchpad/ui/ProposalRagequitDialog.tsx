/**
 * The dissent door (D2, `docs/agentic-governance-design.md`): the ragequit
 * shortcut every proposal card carries, and its exit dialog.
 *
 * Ragequit is always visible on every governance surface — the exit is the
 * market that disciplines the rest of the machinery. What is happening /
 * does it need me / what do I do about it, in that order (the paperclip UX
 * stance). The burn runs through the desktop's existing exit command
 * (`org_ragequit`, the majeur `ragequit` from the configured value-layer
 * key — the same DEV shareholder mapping the org board states); the settled
 * exit mirrors into the kind:47005 `ragequit` word (NIP-LP) with the tx the
 * flow already holds. A failed mirror never re-sends the burn.
 */

import * as React from "react";

import { Loader2 } from "lucide-react";

import {
  useOrgEvmStatusQuery,
  useOrgRagequitMutation,
} from "@/features/org/hooks";
import { usePublishLaunchMirrorMutation } from "@/features/launchpad/hooks";
import type { ProposalDaoBinding } from "@/features/launchpad/lib/decisionRouting";
import { KIND_LAUNCH_RECEIPT } from "@/shared/constants/kinds";
import { truncatePubkey } from "@/shared/lib/pubkey";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/shared/ui/alert-dialog";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ProposalRagequitDialog({
  binding,
  author,
  launchId,
  chainId,
  onClose,
}: {
  /** The DAO the exit would burn against, or null when none is bound. */
  binding: ProposalDaoBinding | null;
  /** The launch record author (the 47005 mirror's `a` scope). */
  author: string;
  /** The launch id (the 47005 mirror's `a` scope). */
  launchId: string;
  /** Chain id for the mirror's `chain` tag. */
  chainId: number;
  onClose: () => void;
}) {
  const evmStatus = useOrgEvmStatusQuery().data;
  const evmConfigured = Boolean(
    evmStatus?.rpcConfigured && evmStatus?.spenderConfigured,
  );
  const ragequit = useOrgRagequitMutation();
  const mirror = usePublishLaunchMirrorMutation();
  const [result, setResult] = React.useState<{
    txHash: string;
    sharesBurned: string;
    sharesRemaining: string;
  } | null>(null);
  const [mirrorError, setMirrorError] = React.useState<string | null>(null);

  const close = () => {
    onClose();
    setResult(null);
    setMirrorError(null);
    ragequit.reset();
  };

  const run = () => {
    if (!binding) return;
    setMirrorError(null);
    ragequit.mutate(
      { dao: binding.dao },
      {
        onSuccess: (data) => {
          setResult({
            txHash: data.txHash,
            sharesBurned: data.sharesBurned,
            sharesRemaining: data.sharesRemaining,
          });
          // The NIP-LP `ragequit` word (kind:47005) — a record-only write
          // bound to the tx the flow already holds. No hash pasting.
          mirror
            .mutateAsync({
              kind: KIND_LAUNCH_RECEIPT,
              author,
              launchId,
              extraTags: [
                ["kind", "ragequit"],
                ["tx", data.txHash],
                ["chain", String(chainId)],
                ["contract", binding.dao],
              ],
              content: {
                table: "ragequit",
                dao: binding.dao,
                sharesBurned: data.sharesBurned,
                sharesRemaining: data.sharesRemaining,
              },
            })
            .catch((err: unknown) => {
              // The burn settled; only the legible record failed. Say so —
              // never re-send the exit to fix a mirror.
              setMirrorError(errorText(err));
            });
        },
      },
    );
  };

  return (
    <AlertDialog onOpenChange={(next) => (next ? undefined : close())} open>
      <AlertDialogContent data-testid="proposal-ragequit-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>
            Exit (ragequit) — the dissent door
          </AlertDialogTitle>
          <AlertDialogDescription>
            Disagreeing is legitimate. Burning your DAO shares pays out your
            proportional share of the treasury and closes your position — the
            exit is always available and is the market that disciplines every
            vote here.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-2 text-xs text-muted-foreground">
          {binding ? (
            <p data-testid="proposal-ragequit-dao">
              DAO:{" "}
              <span className="font-mono">{truncatePubkey(binding.dao)}</span>{" "}
              (from{" "}
              {binding.source === "summon-receipt"
                ? "the launch's summon receipt"
                : "this record's onchain binding"}
              ).
            </p>
          ) : (
            <p data-testid="proposal-ragequit-unbound">
              No DAO is bound to this proposal&apos;s launch yet — there is
              nothing to exit. The door opens when the launch graduates into a
              DAO (its summon receipt names the DAO contract).
            </p>
          )}
          <p>
            DEV mapping: the configured value-layer key (BUZZ_SPENDER_KEY) is
            treated as the shareholder. Mapping Nostr holders to EVM share
            balances through governance is a later upgrade.
          </p>
          {ragequit.isError && (
            <p
              className="text-destructive"
              data-testid="proposal-ragequit-error"
              role="alert"
            >
              {errorText(ragequit.error)}
            </p>
          )}
          {result && (
            <p
              className="text-foreground"
              data-testid="proposal-ragequit-result"
            >
              Exit settled — burned {result.sharesBurned} shares, tx{" "}
              <span className="break-all font-mono">{result.txHash}</span>
              {result.sharesRemaining !== "" && (
                <> · shares remaining: {result.sharesRemaining}</>
              )}
              . Recorded on this launch.
            </p>
          )}
          {mirrorError && (
            <p className="text-destructive" role="alert">
              The exit settled, but the 47005 mirror failed: {mirrorError}. The
              chain is the ledger — the receipt record will catch up on refetch.
            </p>
          )}
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel
            data-testid="proposal-ragequit-cancel"
            onClick={close}
          >
            {result ? "Done" : "Keep my shares"}
          </AlertDialogCancel>
          {!result && (
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              data-testid="proposal-ragequit-confirm"
              disabled={!binding || !evmConfigured || ragequit.isPending}
              onClick={(event) => {
                event.preventDefault(); // keep the dialog open for the tx report
                run();
              }}
            >
              {ragequit.isPending && (
                <Loader2
                  aria-hidden="true"
                  className="mr-1.5 h-3.5 w-3.5 animate-spin"
                />
              )}
              {ragequit.isPending ? "Burning…" : "Burn shares & exit"}
            </AlertDialogAction>
          )}
        </AlertDialogFooter>
        {!evmConfigured && (
          <p
            className="text-xs text-muted-foreground"
            data-testid="proposal-ragequit-hint"
          >
            Configure the EVM value layer (BUZZ_EVM_RPC_URL / BUZZ_SPENDER_KEY)
            to run the exit from this app.
          </p>
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** The persistent D2 shortcut every card carries (never hidden). */
export function ProposalRagequitShortcut({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="mt-2 border-t border-border/50 pt-2">
      <p className="text-2xs text-muted-foreground">
        Disagree with how this is going? The dissent door is always open:
        ragequit burns your shares and takes your proportional treasury share
        with you.
      </p>
      <button
        className="mt-1 text-2xs font-medium text-destructive hover:underline"
        data-testid="proposal-ragequit-shortcut"
        onClick={onOpen}
        type="button"
      >
        Exit (ragequit)…
      </button>
    </div>
  );
}
