import { toast } from "sonner";

import { truncatePubkey } from "@/shared/lib/pubkey";
import { Button } from "@/shared/ui/button";
import { networkLabel } from "../chain";
import type { ActingAccountState } from "../use-acting-account";
import type { ConnectedWalletState } from "../use-connected-wallet";
import { AccountMoneyNote } from "./AccountMoneyNote";
import { AccountNameLink } from "./AccountNameLink";

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
      toast.error("Copy failed. Select the text and copy it manually.");
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
  wallet: ConnectedWalletState | ActingAccountState;
  testIdPrefix: string;
}) {
  if ("kind" in wallet) {
    return <ActingStrip account={wallet} testIdPrefix={testIdPrefix} />;
  }
  if (!wallet.hasProvider) {
    return (
      <p
        className="mt-2 text-sm text-black/60 dark:text-white/60"
        data-testid={`${testIdPrefix}-no-wallet`}
      >
        To take part here you need a wallet in this browser. Add one, then
        reload this page.
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
      Your wallet:{" "}
      <span className="font-mono">{truncatePubkey(wallet.address)}</span>
      {wallet.chainId !== null ? ` (${networkLabel(wallet.chainId)})` : ""}
    </p>
  );
}

/**
 * The acting account (D139): which account acts here, and a way to the other when this browser has both. A passkey
 * account says its fees are covered, and offers to show the person's name with it.
 */
function ActingStrip({
  account,
  testIdPrefix,
}: {
  account: ActingAccountState;
  testIdPrefix: string;
}) {
  if (account.kind === null) {
    return (
      <p
        className="mt-2 text-sm text-black/60 dark:text-white/60"
        data-testid={`${testIdPrefix}-no-wallet`}
      >
        {account.passkeyOffered
          ? "To take part here, set up passkey sign-in from your profile menu: fees are covered on the test network, so you need no wallet. Or add a wallet to this browser and reload."
          : "To take part here you need a wallet in this browser. Add one, then reload this page."}
      </p>
    );
  }
  const other =
    account.kind === "passkey" && account.available.wallet ? (
      <button
        className="ml-2 underline"
        data-testid={`${testIdPrefix}-use-wallet`}
        onClick={() => account.setKind("wallet")}
        type="button"
      >
        Use my browser wallet instead
      </button>
    ) : account.kind === "wallet" && account.available.passkey ? (
      <button
        className="ml-2 underline"
        data-testid={`${testIdPrefix}-use-passkey`}
        onClick={() => account.setKind("passkey")}
        type="button"
      >
        Use my passkey account instead
      </button>
    ) : null;
  if (account.kind === "wallet" && !account.address) {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button
          aria-busy={account.connecting}
          data-testid={`${testIdPrefix}-connect`}
          disabled={account.connecting}
          onClick={() => void account.connect()}
          size="sm"
          type="button"
          variant="outline"
        >
          {account.connecting ? "Waiting for your wallet…" : "Connect wallet"}
        </Button>
        {account.error ? (
          <span className="text-sm text-red-700 dark:text-red-300" role="alert">
            {account.error}
          </span>
        ) : null}
        {other}
      </div>
    );
  }
  if (account.kind === "passkey") {
    return (
      <div className="mt-2 text-sm text-black/60 dark:text-white/60">
        <p data-testid={`${testIdPrefix}-wallet`}>
          {account.address ? (
            <>
              Your account:{" "}
              <span className="font-mono">
                {truncatePubkey(account.address)}
              </span>{" "}
              (passkey; fees are covered on the test network)
            </>
          ) : account.error ? (
            <span className="text-red-700 dark:text-red-300" role="alert">
              {account.error}
            </span>
          ) : (
            "Reading your passkey account…"
          )}
          {other}
        </p>
        {account.address ? (
          <>
            <AccountNameLink
              account={account.address}
              keys={account.passkeyKeys}
              testIdPrefix={testIdPrefix}
            />
            <AccountMoneyNote
              account={account.address}
              chainId={account.chainId}
              testIdPrefix={testIdPrefix}
            />
          </>
        ) : null}
      </div>
    );
  }
  return (
    <p
      className="mt-2 text-sm text-black/60 dark:text-white/60"
      data-testid={`${testIdPrefix}-wallet`}
    >
      Your wallet:{" "}
      <span className="font-mono">{truncatePubkey(account.address ?? "")}</span>
      {account.chainId !== null ? ` (${networkLabel(account.chainId)})` : ""}
      {other}
    </p>
  );
}

/** The reason a panel cannot send yet, when there is one. */
export function GateNote({
  gate,
  testId,
}: {
  gate: { ok: true } | { ok: false; message: string };
  testId: string;
}) {
  if (gate.ok) return null;
  return (
    <p
      className="mt-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-900 [overflow-wrap:anywhere] dark:bg-amber-950 dark:text-amber-100"
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
      className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-800 [overflow-wrap:anywhere] dark:bg-red-950 dark:text-red-200"
      data-testid={testId}
      role="alert"
    >
      {message}
    </p>
  );
}

/**
 * The polite status line. The live region is always in the document (a region
 * that appears together with its text is not announced), but it takes no room
 * while empty: it is visually hidden until it has something to say.
 */
export function StatusLine({ text, testId }: { text: string; testId: string }) {
  return (
    <p
      aria-live="polite"
      className={
        text ? "mt-2 text-sm text-black/60 dark:text-white/60" : "sr-only"
      }
      data-testid={testId}
      role="status"
    >
      {text}
    </p>
  );
}
