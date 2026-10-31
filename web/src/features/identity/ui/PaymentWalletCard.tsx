import { Check, Copy, Fingerprint, Wallet } from "lucide-react";
import { useRef, useState } from "react";

import { CHAIN_PRESETS } from "@/features/launchpad/chain";
import { shortAddress } from "@/features/launchpad/lib/record-people";
import { raisesOffered } from "@/features/launchpad/lib/raises-offered";
import { Modal } from "@/features/launchpad/ui/Modal";
import { resolveUserName, useProfiles } from "@/features/profiles/use-profiles";
import { Button } from "@/shared/ui/button";

import {
  readPendingWalletProof,
  publishPendingWalletProof,
  removePublicWallet,
} from "../lib/public-wallet";
import { explainPasskeyError } from "../lib/passkey";
import { hasPasskeyIdentity, setupPasskey } from "../lib/passkey-identity";
import { linkPasskeyAccount, passkeyAccountSetup } from "../lib/passkey-wallet";
import { signInWithWallet } from "../lib/siwe";
import { walletChainChecker } from "../lib/wallet-chain";
import { resolvePaymentWalletChecked } from "../lib/wallet-proof";
import { usePaymentWallet } from "../use-payment-wallet";
import { SignRecovery } from "./SignRecovery";

/** A wallet that did not connect, in words: what happened and what to do next. */
function walletProblem(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : "";
  if (code === 4001 || /reject|denied|cancel/i.test(message)) {
    return "You cancelled in your wallet. Try again when you are ready.";
  }
  if (/chain|network/i.test(message)) {
    return `Your wallet is on another network. ${message}`;
  }
  return message
    ? `Could not connect the wallet: ${message}`
    : "Could not connect the wallet. Try again.";
}

/** The network a payment wallet is on, in plain words: a test network is just that, whatever it is called. */
function networkWords(chainId: number): string {
  const preset = CHAIN_PRESETS.find((p) => p.chainId === chainId);
  if (!preset) return `Network ${chainId}`;
  return preset.mainnet ? preset.label : "Test network";
}

/** Public, dual-signed payment address on a person's social profile. */
export function PaymentWalletCard({
  pubkey,
  isSelf,
}: {
  pubkey: string;
  isSelf: boolean;
}) {
  const query = usePaymentWallet(pubkey);
  const [dialog, setDialog] = useState<"link" | "remove" | null>(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(() => readPendingWalletProof(pubkey));
  const [copied, setCopied] = useState(false);
  // Bumped after passkey sign-in is set up here, so the dialog reads the new passkey account.
  const [, setPasskeyGeneration] = useState(0);
  const [settingUpPasskey, setSettingUpPasskey] = useState(false);
  const profiles = useProfiles(isSelf ? [pubkey] : []);
  const running = useRef(false);
  const result = query.data;
  const wallet = result?.state === "verified" ? result.wallet : null;
  const chain = CHAIN_PRESETS.find((p) => p.chainId === wallet?.chain);
  const close = () => {
    if (!running.current) setDialog(null);
  };
  const run = async (action: () => Promise<unknown>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
      setCopied(false);
      setDialog(null);
      await query.refetch();
    } catch (e) {
      setError(walletProblem(e));
    } finally {
      setPending(readPendingWalletProof(pubkey));
      running.current = false;
      setBusy(false);
    }
  };
  const passkeySetup = passkeyAccountSetup();
  // An account made without a passkey has no passkey account to be paid at: the way to one is right here.
  const canSetUpPasskey = !passkeySetup.ok && !hasPasskeyIdentity();
  const setUpPasskey = async () => {
    if (running.current) return;
    running.current = true;
    setSettingUpPasskey(true);
    setError(null);
    try {
      await setupPasskey(resolveUserName(profiles.data?.[pubkey], pubkey));
      setPasskeyGeneration((n) => n + 1);
    } catch (e) {
      setError(explainPasskeyError(e));
    } finally {
      running.current = false;
      setSettingUpPasskey(false);
    }
  };
  // The newest record this account has already published, so a new link replaces it.
  const newerThan = Math.max(
    pending?.created_at ?? 0,
    wallet?.event.created_at ??
      (result && "event" in result ? (result.event?.created_at ?? 0) : 0),
  );
  const link = () => {
    setConsent(false);
    setError(null);
    setDialog("link");
  };
  const copy = async () => {
    if (!wallet || running.current) return;
    running.current = true;
    setBusy(true);
    try {
      const fresh = await query.refetch({ throwOnError: true });
      const checked = await resolvePaymentWalletChecked(
        fresh.data ?? [],
        pubkey,
        Math.floor(Date.now() / 1000),
        walletChainChecker(),
      );
      if (checked.state !== "verified")
        throw new Error(
          "This wallet is no longer confirmed. Ask them to connect it again.",
        );
      if (
        checked.wallet.address !== wallet.address ||
        checked.wallet.chain !== wallet.chain
      )
        throw new Error(
          "The payment wallet changed. Check the updated address and network, then copy again.",
        );
      await navigator.clipboard.writeText(wallet.address);
      setCopied(true);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't copy the address.");
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  return (
    <section
      aria-label="Payment wallet"
      className="mt-3 rounded-xl border border-border bg-muted/30 p-3 text-sm"
      data-testid="payment-wallet"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 font-semibold">
          <Wallet aria-hidden className="h-4 w-4" />
          Payment wallet
        </h3>
        {wallet && !query.isError ? (
          <span className="flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-400">
            <Check aria-hidden className="h-3.5 w-3.5" />
            Verified
          </span>
        ) : null}
      </div>
      {query.isLoading ? (
        <p className="mt-2 text-muted-foreground">Checking the wallet…</p>
      ) : query.isError ? (
        <div className="mt-2">
          <SignRecovery
            message="Couldn't check this account's payment wallet."
            onUnlocked={() => void query.refetch()}
            autoResume
          />
          <Button
            className="mt-2"
            onClick={() => void query.refetch()}
            size="sm"
            variant="outline"
          >
            Try again
          </Button>
        </div>
      ) : wallet ? (
        <>
          <p className="mt-2 text-xs text-muted-foreground">
            {networkWords(wallet.chain)}
          </p>
          {/* The start and end to read at a glance; the whole address for screen readers, Copy and hover. */}
          <code
            aria-hidden
            className="mt-1 block text-sm"
            title={wallet.address}
          >
            {shortAddress(wallet.address)}
          </code>
          <span className="sr-only" data-testid="payment-wallet-address">
            {wallet.address}
          </span>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              aria-label="Copy payment address"
              disabled={busy}
              onClick={() => void copy()}
              size="sm"
              variant="outline"
            >
              <Copy aria-hidden className="h-3.5 w-3.5" />
              {copied ? "Copied" : "Copy address"}
            </Button>
            {chain?.explorer ? (
              <a
                className="self-center text-xs underline"
                href={`${chain.explorer}/address/${wallet.address}`}
                rel="noopener noreferrer"
                target="_blank"
              >
                View on explorer
              </a>
            ) : null}
            {isSelf && !pending ? (
              <Button
                disabled={busy}
                onClick={() => setDialog("remove")}
                size="sm"
                variant="outline"
              >
                Disconnect
              </Button>
            ) : null}
          </div>
          {raisesOffered() ? (
            <p className="mt-2 text-xs text-muted-foreground">
              Before sending anything, check you are on the same network.
            </p>
          ) : null}
        </>
      ) : (
        <p className="mt-2 text-muted-foreground">
          {result?.state === "expired"
            ? "This wallet needs to be connected again before anyone pays it."
            : result?.state === "invalid"
              ? "This wallet could not be confirmed. Ask them to connect it again before paying."
              : result?.state === "unreachable"
                ? "This account linked a smart account, which has to be checked on the network, and that check could not be made just now. Try again in a moment."
                : result?.state === "revoked"
                  ? "This account removed its public payment wallet."
                  : "No verified payment wallet has been shared."}
        </p>
      )}
      {isSelf ? (
        <div className="mt-2">
          {pending ? (
            <>
              <p className="mb-2 text-xs text-muted-foreground">
                A signed wallet update is saved in this browser but has not been
                confirmed by the server.
              </p>
              <Button
                disabled={busy}
                onClick={() =>
                  void run(() => publishPendingWalletProof(pubkey))
                }
                size="sm"
                variant="outline"
              >
                {busy ? "Publishing…" : "Retry wallet update"}
              </Button>
              <Button
                className="ml-2"
                disabled={busy}
                onClick={link}
                size="sm"
                variant="ghost"
              >
                Link again
              </Button>
            </>
          ) : (
            <Button
              disabled={busy || query.isLoading || query.isError}
              onClick={link}
              size="sm"
              variant="outline"
            >
              {wallet ? "Change payment wallet" : "Connect payment wallet"}
            </Button>
          )}
        </div>
      ) : null}
      {error && !dialog ? (
        <SignRecovery
          className="mt-2"
          message={error}
          onUnlocked={() => setError(null)}
        />
      ) : null}
      {dialog ? (
        <Modal
          label={
            dialog === "link"
              ? "Connect payment wallet"
              : "Disconnect payment wallet"
          }
          onClose={close}
        >
          <h2 className="text-lg font-semibold">
            {dialog === "link"
              ? "Connect your payment wallet"
              : "Disconnect your payment wallet?"}
          </h2>
          {dialog === "link" ? (
            <>
              <p className="mt-2 text-sm text-muted-foreground">
                Projects send what you earn to this wallet. Connecting it does
                not let anyone spend from it.
              </p>
              <p className="mt-4 text-sm" id="payment-wallet-public">
                Projects pay you at a public address: anyone can see its
                history.
              </p>
              <label className="mt-2 flex items-center gap-2 text-sm font-medium">
                <input
                  aria-describedby="payment-wallet-public"
                  checked={consent}
                  disabled={busy}
                  onChange={(e) => setConsent(e.target.checked)}
                  type="checkbox"
                />
                I understand
              </label>
              <p
                className="mt-3 text-xs text-muted-foreground"
                data-testid="payment-wallet-how"
              >
                {passkeySetup.ok
                  ? "Use your passkey account, or a wallet in this browser. The first time, your passkey account is set up for you at no cost."
                  : canSetUpPasskey
                    ? "Set up passkey sign-in to be paid at your passkey account, or use a wallet in this browser."
                    : `${passkeySetup.reason} You can use a wallet in this browser.`}
              </p>
              {canSetUpPasskey ? (
                <Button
                  className="mt-2"
                  data-testid="payment-wallet-setup-passkey"
                  disabled={busy || settingUpPasskey}
                  onClick={() => void setUpPasskey()}
                  size="sm"
                  variant="outline"
                >
                  <Fingerprint aria-hidden className="h-3.5 w-3.5" />
                  {settingUpPasskey
                    ? "Waiting for your passkey…"
                    : "Set up passkey sign-in"}
                </Button>
              ) : null}
              {!consent ? (
                <p
                  className="mt-3 text-xs text-muted-foreground"
                  data-testid="payment-wallet-consent-hint"
                  id="payment-wallet-consent-hint"
                >
                  Tick "I understand" to continue.
                </p>
              ) : null}
            </>
          ) : (
            <p className="mt-2 text-sm text-muted-foreground">
              Your profile will stop showing this wallet. Work you already
              submitted keeps the wallet it was submitted from.
            </p>
          )}
          {error ? (
            <SignRecovery
              className="mt-3"
              message={error}
              onUnlocked={() => setError(null)}
              testId="wallet-sign-recovery"
            />
          ) : null}
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <Button disabled={busy} onClick={close} variant="outline">
              Cancel
            </Button>
            {dialog === "link" && passkeySetup.ok ? (
              <Button
                aria-describedby={
                  consent ? undefined : "payment-wallet-consent-hint"
                }
                data-testid="link-passkey-account"
                disabled={busy || !consent}
                onClick={() =>
                  void run(() => linkPasskeyAccount({ newerThan }))
                }
                variant="outline"
              >
                {busy
                  ? "Waiting for signatures…"
                  : "Sign with my passkey account"}
              </Button>
            ) : null}
            <Button
              aria-describedby={
                dialog === "link" && !consent
                  ? "payment-wallet-consent-hint"
                  : undefined
              }
              disabled={
                busy || settingUpPasskey || (dialog === "link" && !consent)
              }
              onClick={() =>
                void run(async () => {
                  if (dialog === "remove" && wallet)
                    await removePublicWallet(wallet);
                  else
                    await signInWithWallet({
                      publicProof: true,
                      newerThan,
                    });
                })
              }
            >
              {busy
                ? "Waiting for signatures…"
                : dialog === "link"
                  ? "Connect wallet"
                  : "Disconnect"}
            </Button>
          </div>
        </Modal>
      ) : null}
    </section>
  );
}
