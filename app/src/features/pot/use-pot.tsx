/**
 * What every money screen of a project needs from the person's side: the sender (wallet or passkey account), the account
 * it shows, whether it is on the project's network, and a `read` for the chain. `WalletGate` stands in front of a screen
 * that needs them and says, in plain words and with the one press that fixes it, which one is missing.
 */
import type { ReadCall } from "@creaton/core/pot/pot-reads.ts";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useCallback, useState } from "react";
import { useAccount } from "../../lib/account";
import { potNetwork } from "../../lib/pot-network";
import { Button } from "../../ui/button";
import {
  ACCOUNT_MISMATCH_WORDS,
  PASSKEY_WRONG_NETWORK_WORDS,
} from "../money/copy";
import { potProblem } from "../money/problems";
import { passkeyUnavailableSentence } from "../money/sender";
import {
  useConnectWallet,
  useWallet,
  useWalletAddress,
  useWalletOnChain,
} from "../money/use-money";
import {
  isAccountMismatch,
  type MoneyWallet,
  senderAvailability,
  senderKind,
} from "../money/wallet";

/** The sender, its account and network, and a chain read, for one project's chain. */
export interface PotWallet {
  wallet: MoneyWallet;
  /** The account the sender shows without asking, or null until the person connects. */
  address: string | null;
  /** True while a passkey account's address is being read, and false once it is known or could not be. */
  addressPending: boolean;
  /** True when the server's address for a passkey account is not the one this phone works out: nothing is shown or sent. */
  addressMismatch: boolean;
  /** True on the project's network, false on another, undefined while not known. */
  onChain: boolean | undefined;
  /** A read-only call through the sender. */
  read: ReadCall;
}

export function usePotWallet(chainId: number | undefined): PotWallet {
  const wallet = useWallet();
  const account = useWalletAddress();
  const address = account.data ?? null;
  const onChain = useWalletOnChain(chainId);
  const read = useCallback<ReadCall>(
    (to, data) => wallet.readCall(to, data),
    [wallet],
  );
  return {
    wallet,
    address,
    addressPending: account.isPending,
    addressMismatch: isAccountMismatch(account.error),
    onChain,
    read,
  };
}

/**
 * Whether this build can take part in a project on `chainId`: it names a test network and the project lives on it.
 * A build that names none offers no money step; one for another network says so.
 */
function buildFits(chainId: number): "yes" | "no-network" | "other" {
  const network = potNetwork();
  if (!network) return "no-network";
  return network.chainId === chainId ? "yes" : "other";
}

/**
 * Whether a record's contracts belong to this build's network: the Launcher it names is the build's own, and so is its
 * dollar when the build names one. A record that names another Launcher or dollar (a redeploy this build does not know, or a
 * wrong record) is never sent money from: a press would go to contracts nobody here has looked at.
 */
export function recordFitsBuild(numbers: {
  launcher: string;
  contracts: { dollar: string };
}): boolean {
  const network = potNetwork();
  // A build that names no network is told so by the gate; there is nothing to compare with.
  if (!network) return true;
  if (numbers.launcher.toLowerCase() !== network.launcher) return false;
  return (
    network.dollar === null ||
    numbers.contracts.dollar.toLowerCase() === network.dollar
  );
}

const BUILD_WORDS = {
  "no-network":
    "Money steps are not switched on in this version of the app, so nothing can be sent from here.",
  other:
    "This version of the app is for a different test network than this project, so nothing can be sent from here.",
} as const;

/** What the gate hands its children once the sender is ready. */
export interface Ready {
  address: string;
  read: ReadCall;
  wallet: MoneyWallet;
}

/**
 * `Ready` for a part of a page that says nothing until it is: no prompt to connect, to switch network or to open the page
 * elsewhere (the Back box says those). Null while anything is missing.
 */
export function useQuietReady(chainId: number): Ready | null {
  const pot = usePotWallet(chainId);
  if (
    buildFits(chainId) !== "yes" ||
    !pot.wallet.isAvailable() ||
    !pot.address ||
    pot.onChain !== true
  )
    return null;
  return { address: pot.address, read: pot.read, wallet: pot.wallet };
}

/** Whether this is a phone that signs up with a passkey and has no account here yet: it holds nothing to show or take out. */
function isSignedOutPhone(wallet: PotWallet["wallet"], pubkey: string | null) {
  const now = senderAvailability(wallet);
  return (
    !pubkey &&
    senderKind(wallet) === "passkey" &&
    !now.ok &&
    now.reason === "no-passkey"
  );
}

/** The same, as a hook for a card that has nothing to say to such a visitor. */
export function useSignedOutPhone(chainId: number): boolean {
  const pot = usePotWallet(chainId);
  const { pubkey } = useAccount();
  return isSignedOutPhone(pot.wallet, pubkey);
}

/**
 * Children when the sender is ready (a sender that can send, an account it shows, on the project's network); otherwise the
 * one thing missing and the press that fixes it.
 */
export function WalletGate({
  chainId,
  what,
  signedOut,
  children,
}: {
  chainId: number;
  /** What it is needed for, said after "to": "back this project". */
  what: string;
  /**
   * Shown in place of "open this page in a browser with a wallet" to someone with no account here on a phone that signs
   * up with a passkey: signing up is the way forward, so the screen can offer it. A wallet browser never sees it.
   */
  signedOut?: ReactNode;
  children: (ready: Ready) => ReactNode;
}) {
  const pot = usePotWallet(chainId);
  const { pubkey } = useAccount();
  const connect = useConnectWallet();
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const fits = buildFits(chainId);
  if (fits !== "yes")
    return (
      <p className="text-sm text-muted" data-testid="pot-build-words">
        {BUILD_WORDS[fits]}
      </p>
    );
  if (signedOut && isSignedOutPhone(pot.wallet, pubkey))
    return <>{signedOut}</>;
  if (!pot.wallet.isAvailable())
    return (
      <p className="text-sm text-muted" data-testid="pot-no-wallet">
        {passkeyUnavailableSentence(pot.wallet) ??
          `Open this page in a browser with a wallet to ${what}.`}
      </p>
    );
  const note = problem ? (
    <p className="text-sm text-danger" role="alert">
      {problem}
    </p>
  ) : null;
  const passkey = senderKind(pot.wallet) === "passkey";
  if (!pot.address && pot.addressMismatch)
    return (
      <p
        className="text-sm text-danger"
        data-testid="pot-account-mismatch"
        role="alert"
      >
        {ACCOUNT_MISMATCH_WORDS}
      </p>
    );
  // A passkey account is read from the passkey, never connected: it says it is being read, or that it could not be.
  if (!pot.address && passkey)
    return (
      <div className="flex flex-col gap-2" data-testid="pot-connect">
        <p className="text-sm text-muted">
          {pot.addressPending
            ? `Reading your account to ${what}…`
            : `Your account could not be read just now, so you cannot ${what} yet.`}
        </p>
        {note}
        {pot.addressPending ? null : (
          <Button
            block
            disabled={connect.isPending}
            onClick={() =>
              connect.mutate(undefined, {
                onError: (error) => setProblem(potProblem(error, "connect")),
              })
            }
            variant="secondary"
          >
            {connect.isPending ? "Reading your account…" : "Try again"}
          </Button>
        )}
      </div>
    );
  if (!pot.address)
    return (
      <div className="flex flex-col gap-2" data-testid="pot-connect">
        <p className="text-sm text-muted">Connect your wallet to {what}.</p>
        {note}
        <Button
          block
          disabled={connect.isPending}
          onClick={() =>
            connect.mutate(undefined, {
              onError: (error) => setProblem(potProblem(error, "connect")),
            })
          }
          variant="secondary"
        >
          {connect.isPending
            ? "Waiting for your wallet…"
            : "Connect your wallet"}
        </Button>
      </div>
    );
  if (pot.onChain === false && passkey)
    return (
      <p className="text-sm text-muted" data-testid="pot-wrong-network">
        {PASSKEY_WRONG_NETWORK_WORDS}
      </p>
    );
  if (pot.onChain === false)
    return (
      <div className="flex flex-col gap-2" data-testid="pot-wrong-network">
        <p className="text-sm text-muted">
          Your wallet is on another network. Switch it to this project's test
          network to {what}.
        </p>
        {note}
        <Button
          block
          disabled={switching}
          onClick={() => {
            setSwitching(true);
            setProblem(null);
            pot.wallet
              .ensureChain(chainId)
              // The page asks the wallet which network it is on again: without this it would go on saying "another network".
              .then(() =>
                queryClient.invalidateQueries({
                  queryKey: ["money", "wallet-chain"],
                }),
              )
              .catch((error) => setProblem(potProblem(error, "connect")))
              .finally(() => setSwitching(false));
          }}
          variant="secondary"
        >
          {switching ? "Waiting for your wallet…" : "Switch network"}
        </Button>
      </div>
    );
  if (pot.onChain === undefined)
    return (
      <p className="text-sm text-muted" data-testid="pot-checking-network">
        Checking your wallet's network…
      </p>
    );
  return (
    <>
      {children({
        address: pot.address,
        read: pot.read,
        wallet: pot.wallet,
      })}
    </>
  );
}
