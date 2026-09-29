import { toast } from "sonner";

import { truncatePubkey } from "@/shared/lib/pubkey";
import { Button } from "@/shared/ui/button";
import type { ConnectedWalletState } from "../use-connected-wallet";
import type { SendGate } from "../lib/auction-copy";

/**
 * Small pieces shared by the auction deploy and graduation panels: a step row,
 * a copyable address, and the wallet strip. Copy for the steps and failures
 * lives in `lib/auction-copy.ts` (pure, unit-tested); this file only renders.
 */

/** One row of a step list. The marker is decorative — the status text carries the meaning. */
export function StepRow({
  testId,
  marker,
  label,
  detail,
  status,
}: {
  testId: string;
  marker: string;
  label: string;
  detail: string;
  status: string;
}) {
  return (
    <li
      className="grid grid-cols-[1.25rem_1fr] items-baseline gap-x-2 text-sm text-black/80 dark:text-white/80"
      data-testid={testId}
    >
      <span aria-hidden className="text-black/50 dark:text-white/50">
        {marker}
      </span>
      <span>
        <span className="font-medium">{label}</span>{" "}
        <span className="text-black/60 dark:text-white/60">{detail}</span>{" "}
        <span className="font-medium">{status}</span>
      </span>
    </li>
  );
}

/** A contract address or hash with a copy button. */
export function AddressRow({
  label,
  value,
  copyLabel,
}: {
  label: string;
  value: string;
  copyLabel: string;
}) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`${label} copied.`);
    } catch {
      toast.error("Copy failed — select the text manually.");
    }
  };
  return (
    <div className="mt-2 flex min-w-0 items-start gap-2 rounded-lg bg-black/5 px-2 py-1.5 dark:bg-white/10">
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium text-black/60 dark:text-white/60">
          {label}
        </div>
        <div className="break-all font-mono text-xs">{value}</div>
      </div>
      <Button
        aria-label={copyLabel}
        onClick={copy}
        size="sm"
        type="button"
        variant="ghost"
      >
        Copy
      </Button>
    </div>
  );
}

/** Who is connected and on which chain, with the connect button when nobody is. */
export function WalletStrip({
  wallet,
  testIdPrefix,
}: {
  wallet: ConnectedWalletState;
  testIdPrefix: string;
}) {
  if (!wallet.hasProvider) {
    return (
      <p
        className="mt-2 text-sm text-black/60 dark:text-white/60"
        data-testid={`${testIdPrefix}-no-wallet`}
      >
        No wallet found in this browser. Install a wallet extension, then reload
        this page.
      </p>
    );
  }
  if (!wallet.address) {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button
          aria-busy={wallet.connecting}
          data-testid={`${testIdPrefix}-connect`}
          disabled={wallet.connecting}
          onClick={() => void wallet.connect()}
          size="sm"
          type="button"
          variant="outline"
        >
          {wallet.connecting ? "Waiting for your wallet…" : "Connect wallet"}
        </Button>
        {wallet.error ? (
          <span className="text-sm text-red-700 dark:text-red-300" role="alert">
            {wallet.error}
          </span>
        ) : null}
      </div>
    );
  }
  return (
    <p
      className="mt-2 text-sm text-black/60 dark:text-white/60"
      data-testid={`${testIdPrefix}-wallet`}
    >
      Connected as{" "}
      <span className="font-mono">{truncatePubkey(wallet.address)}</span>
      {wallet.chainId !== null ? ` on chain ${wallet.chainId}` : ""}.
    </p>
  );
}

/** The reason a panel cannot send yet, when there is one. */
export function GateNote({ gate, testId }: { gate: SendGate; testId: string }) {
  if (gate.ok) return null;
  return (
    <p
      className="mt-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100"
      data-testid={testId}
      role="status"
    >
      {gate.message}
    </p>
  );
}

/** A failure message box (an alert: the user needs to act on it). */
export function FailureNote({
  message,
  testId,
}: {
  message: string;
  testId: string;
}) {
  return (
    <p
      className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-200"
      data-testid={testId}
      role="alert"
    >
      {message}
    </p>
  );
}
