/**
 * Which account acts on a page, said in plain words (no address, no network id), with the step to take when there is
 * none: set up passkey sign-in right here when the site offers passkey accounts, so a form filled in above keeps what
 * was typed; connect a wallet when the browser has one.
 */

import { type ReactNode, useState } from "react";

import { setupPasskey } from "@/features/identity/lib/passkey-identity";
import { useUserNames } from "@/features/profiles/use-profiles";
import { existingUserPubkey } from "@/shared/lib/identity";
import { Button } from "@/shared/ui/button";

import { plainNetworkName } from "../lib/test-network";
import {
  feesCoveredOn,
  passkeyActingLine,
  passkeyChainId,
} from "../lib/acting-account";
import type { ActingAccountState } from "../use-acting-account";
import type { ConnectedWalletState } from "../use-connected-wallet";
import { AccountMoneyNote } from "./AccountMoneyNote";
import { AccountNameLink } from "./AccountNameLink";

const NO_WALLET =
  "To take part here you need a wallet in this browser. Add one, then reload this page.";

/** Who is connected, with the connect button when nobody is. */
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
        className="mt-2 text-sm text-muted-foreground"
        data-testid={`${testIdPrefix}-no-wallet`}
      >
        {NO_WALLET}
      </p>
    );
  }
  if (!wallet.address) {
    return (
      <ConnectButton
        connect={wallet.connect}
        connecting={wallet.connecting}
        error={wallet.error}
        testIdPrefix={testIdPrefix}
      />
    );
  }
  return <WalletLine chainId={wallet.chainId} testIdPrefix={testIdPrefix} />;
}

function WalletLine({
  chainId,
  testIdPrefix,
  other,
}: {
  chainId: number | null;
  testIdPrefix: string;
  other?: ReactNode;
}) {
  return (
    <p
      className="mt-2 text-sm text-muted-foreground"
      data-testid={`${testIdPrefix}-wallet`}
    >
      Your wallet is connected
      {chainId !== null ? ` to ${plainNetworkName(chainId)}` : ""}.{other}
    </p>
  );
}

function ConnectButton({
  connect,
  connecting,
  error,
  testIdPrefix,
  other,
}: {
  connect: () => unknown;
  connecting: boolean;
  error: string | null;
  testIdPrefix: string;
  other?: ReactNode;
}) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <Button
        aria-busy={connecting}
        data-testid={`${testIdPrefix}-connect`}
        disabled={connecting}
        onClick={() => void connect()}
        size="sm"
        type="button"
        variant="outline"
      >
        {connecting ? "Waiting for your wallet…" : "Connect wallet"}
      </Button>
      {error ? (
        <span className="text-sm text-destructive" role="alert">
          {error}
        </span>
      ) : null}
      {other}
    </div>
  );
}

/**
 * No account in this browser yet. Where the site offers passkey accounts, set one up here: the page stays as it is,
 * and the account acts as soon as it exists.
 */
function NoAccount({
  account,
  testIdPrefix,
}: {
  account: ActingAccountState;
  testIdPrefix: string;
}) {
  const me = existingUserPubkey();
  const nameOf = useUserNames(me ? [me] : []);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const fees = feesCoveredOn(passkeyChainId());
  if (!account.passkeyOffered) {
    return (
      <p
        className="mt-2 text-sm text-muted-foreground"
        data-testid={`${testIdPrefix}-no-wallet`}
      >
        {NO_WALLET}
      </p>
    );
  }
  const setUp = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await setupPasskey(me ? nameOf(me) : "");
      account.setKind("passkey");
    } catch (error) {
      setProblem(
        error instanceof Error && error.message
          ? error.message
          : "Your passkey could not be set up. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className="mt-2 flex flex-col gap-2 text-sm text-muted-foreground"
      data-testid={`${testIdPrefix}-no-wallet`}
    >
      <p>
        To take part, sign in with a passkey. You need no wallet
        {fees ? `, and the fees are covered on ${fees}` : ""}.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          aria-busy={busy}
          data-testid={`${testIdPrefix}-set-up-passkey`}
          disabled={busy}
          onClick={() => void setUp()}
          size="sm"
          type="button"
        >
          {busy ? "Waiting for your passkey…" : "Set up passkey sign-in"}
        </Button>
        {problem ? (
          <span className="text-destructive" role="alert">
            {problem}
          </span>
        ) : null}
      </div>
    </div>
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
    return <NoAccount account={account} testIdPrefix={testIdPrefix} />;
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
      <ConnectButton
        connect={account.connect}
        connecting={account.connecting}
        error={account.error}
        other={other}
        testIdPrefix={testIdPrefix}
      />
    );
  }
  if (account.kind === "passkey") {
    return (
      <div className="mt-2 text-sm text-muted-foreground">
        <p data-testid={`${testIdPrefix}-wallet`}>
          {account.address ? (
            passkeyActingLine(account.chainId)
          ) : account.error ? (
            <span className="text-destructive" role="alert">
              {account.error}
            </span>
          ) : (
            "Reading your passkey account…"
          )}
          {other}
        </p>
        {account.address ? (
          <>
            <p className="text-xs" data-testid={`${testIdPrefix}-passkey-only`}>
              Only this passkey can reach what this account holds, so keep it
              saved in your password manager.
            </p>
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
    <WalletLine
      chainId={account.chainId}
      other={other}
      testIdPrefix={testIdPrefix}
    />
  );
}
