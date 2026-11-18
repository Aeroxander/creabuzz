import * as React from "react";

import { DoorOpen, KeyRound, Loader2 } from "lucide-react";

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
import { cn } from "@/shared/lib/cn";
import { DropdownMenuItem } from "@/shared/ui/dropdown-menu";

import { useOrgEvmStatusQuery, useOrgRagequitMutation } from "../hooks";
import type { OrgNodeOnchain } from "../orgModels";
import { truncateAddress } from "./OnchainChip";

/**
 * "Exit (ragequit)" affordance for a bound org (NIP-ORG "Opt-in onchain
 * binding"). Read-by-default: the menu entry renders only when the org root
 * carries `content.onchain`, and without a configured EVM value layer it
 * degrades to a hint — no gates, no network calls until the user confirms.
 *
 * DEV mapping (stated inline in the dialog): the configured value-layer
 * spender key (BUZZ_SPENDER_KEY) IS the shareholder. The
 * Nostr-holder ↔ EVM identity mapping is a documented simplification until
 * the governance/DAO-proposal handover replaces it with the DAO's own
 * member registry.
 */

type OrgRagequitActionProps = {
  onchain: OrgNodeOnchain;
};

export function OrgRagequitAction({ onchain }: OrgRagequitActionProps) {
  const [open, setOpen] = React.useState(false);
  const evmStatus = useOrgEvmStatusQuery().data;
  const evmConfigured = Boolean(
    evmStatus?.rpcConfigured && evmStatus?.spenderConfigured,
  );

  if (!evmConfigured) {
    // Hint, not a gate: nothing is disabled that was otherwise possible.
    return (
      <DropdownMenuItem
        className="text-muted-foreground"
        data-testid="org-ragequit-hint"
        disabled
      >
        <KeyRound aria-hidden="true" className="mr-2 h-3.5 w-3.5" />
        Configure EVM key (BUZZ_EVM_RPC_URL / BUZZ_SPENDER_KEY) to exit
      </DropdownMenuItem>
    );
  }

  return (
    <>
      <DropdownMenuItem
        className="text-destructive focus:text-destructive"
        data-testid="org-ragequit-open"
        onSelect={(event) => {
          event.preventDefault();
          setOpen(true);
        }}
      >
        <DoorOpen aria-hidden="true" className="mr-2 h-3.5 w-3.5" />
        Exit (ragequit)…
      </DropdownMenuItem>
      <OrgRagequitDialog onOpenChange={setOpen} onchain={onchain} open={open} />
    </>
  );
}

function OrgRagequitDialog({
  onchain,
  open,
  onOpenChange,
}: OrgRagequitActionProps & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const ragequit = useOrgRagequitMutation();
  const [result, setResult] = React.useState<{
    txHash: string;
    sharesRemaining: string;
  } | null>(null);

  const close = () => {
    onOpenChange(false);
    // The settlement result is reported inline while open; after close the
    // audit tab carries the durable record.
    setResult(null);
    ragequit.reset();
  };

  return (
    <AlertDialog
      onOpenChange={(next) => (next ? onOpenChange(true) : close())}
      open={open}
    >
      <AlertDialogContent data-testid="org-ragequit-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>Exit (ragequit)?</AlertDialogTitle>
          <AlertDialogDescription>
            You burn your shares and withdraw your share of the treasury. This
            is final.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-2 text-xs text-muted-foreground">
          <p>
            DAO:{" "}
            <span className="font-mono">{truncateAddress(onchain.dao)}</span> on{" "}
            {onchain.chain}
          </p>
          <p>
            DEV mapping: the configured value-layer key (BUZZ_SPENDER_KEY) is
            treated as the shareholder. Mapping Nostr holders to EVM share
            balances through governance is a later upgrade.
          </p>
          {ragequit.isError && (
            <p
              className="text-destructive"
              data-testid="org-ragequit-error"
              role="alert"
            >
              {ragequit.error.message}
            </p>
          )}
          {result && (
            <p className="text-foreground" data-testid="org-ragequit-result">
              Exit settled. tx:{" "}
              <span className="break-all font-mono">{result.txHash}</span>
              {result.sharesRemaining !== "" && (
                <> · shares remaining: {result.sharesRemaining}</>
              )}
            </p>
          )}
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel data-testid="org-ragequit-cancel" onClick={close}>
            {result ? "Done" : "Keep my shares"}
          </AlertDialogCancel>
          {!result && (
            <AlertDialogAction
              className={cn(
                "bg-destructive text-white hover:bg-destructive/90",
              )}
              data-testid="org-ragequit-confirm"
              disabled={ragequit.isPending}
              onClick={(event) => {
                event.preventDefault(); // keep the dialog open for the tx report
                ragequit.mutate(
                  { dao: onchain.dao },
                  {
                    onSuccess: (data) =>
                      setResult({
                        txHash: data.txHash,
                        sharesRemaining: data.sharesRemaining,
                      }),
                  },
                );
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
      </AlertDialogContent>
    </AlertDialog>
  );
}

export type { OrgRagequitActionProps };
