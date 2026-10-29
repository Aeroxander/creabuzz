/**
 * The account this browser acts as on chain (D139; `lib/acting-account.ts` says why one account for every step): a
 * passkey account with covered fees when the site offers one, else the browser's wallet. It has the shape of
 * `useConnectedWallet` (so `WalletStrip` and every reader of "my address" work unchanged) plus `sendCalls`, which sends
 * through whichever account acts and resolves only once the calls landed and succeeded.
 *
 * Every component reads the same choice: it lives in this browser's storage, and a change is announced to the others
 * on the page. The passkey account's address is derived once (a read of the account factory) and shared through the
 * query cache.
 */
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import { kernel033ChainRpcUrl } from "@/features/identity/lib/kernel033";
import {
  type PasskeyAccountKeys,
  publishedPasskeyAccount,
  rememberedPasskeyAccount,
  rememberPasskeyAccount,
  signInPasskeyKeys,
} from "@/features/identity/lib/passkey-account";
import {
  createSponsoredSender,
  type SenderCall,
  type SponsoredSender,
} from "@/features/identity/lib/sponsoredSender";
import { zerodevConfigFromEnv } from "@/features/identity/lib/zerodev";
import { KIND_EVM_BINDING } from "@/shared/constants/kinds";
import { existingUserPubkey } from "@/shared/lib/identity";
import { queryEvents } from "@/shared/lib/nostr-client";
import { relayWsUrl } from "@/shared/lib/relay-url";

import { networkLabel } from "./chain-config";
import {
  type ActingKind,
  actingErrorMessage,
  chooseActingKind,
  loadActingKind,
  PartialStepError,
  StepRevertedError,
  saveActingKind,
  sendAsAccount,
} from "./lib/acting-account";
import { makeWalletAuctionEffects } from "./lib/wallet-effects";
import {
  type ConnectedWalletState,
  useConnectedWallet,
} from "./use-connected-wallet";

export interface ActingAccountState extends ConnectedWalletState {
  /** Which account acts, or null when this browser has neither. */
  kind: ActingKind | null;
  /** What this browser could act as. */
  available: { wallet: boolean; passkey: boolean };
  /** Whether this site offers passkey accounts at all (so "set one up" is worth saying). */
  passkeyOffered: boolean;
  setKind: (kind: ActingKind) => void;
  /** The passkey account's sender, when there is one (for a picker that follows this choice). */
  sponsored: SponsoredSender | null;
  /** The passkey account's public details, when there is one (for linking it to the person's name). */
  passkeyKeys: PasskeyAccountKeys | null;
  /**
   * Send `calls` in order on `chainId`, as the acting account: one passkey prompt for all of them, or one wallet prompt
   * each. Resolves with the last transaction once they landed and succeeded; throws a `StepRevertedError` when the chain
   * refused one, or an error in plain words when they could not be sent.
   */
  sendCalls: (calls: SenderCall[], chainId: number) => Promise<string>;
}

const KIND_EVENT = "buzz:acting-account";

function subscribeKind(onChange: () => void): () => void {
  window.addEventListener(KIND_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(KIND_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/** The site's passkey account set-up: the network its fees are covered on, and that network's node. */
function passkeyNetwork(): { chainId: number; rpcUrl: string } | null {
  const config = zerodevConfigFromEnv();
  const chainId = config.chainId ?? 0;
  if (!config.projectId || !Number.isInteger(chainId) || chainId <= 0) {
    return null;
  }
  try {
    return { chainId, rpcUrl: kernel033ChainRpcUrl(chainId) };
  } catch {
    return null;
  }
}

export function useActingAccount(): ActingAccountState {
  const injected = useConnectedWallet();
  const saved = useSyncExternalStore(subscribeKind, loadActingKind, () => null);
  const network = useMemo(passkeyNetwork, []);
  const me = existingUserPubkey();
  const relay = relayWsUrl();
  // The person's name links: one may carry their passkey account's public details, for a browser that has none (D139).
  const links = useQuery({
    queryKey: ["identity", "payment-wallet", relay, me],
    queryFn: () =>
      queryEvents(relay, {
        kinds: [KIND_EVM_BINDING],
        authors: [me as string],
        limit: 50,
      }),
    enabled: network !== null && me !== null,
    staleTime: 15_000,
    retry: 1,
  });
  // Where the passkey account comes from: this browser's passkey sign-in, else what this browser kept for this person,
  // else what the person published with a name link (checked below against the address that link names).
  const own = signInPasskeyKeys();
  const kept = me ? rememberedPasskeyAccount(me) : null;
  const published = useMemo(() => {
    // Only the person's own links: a server's filter is not trusted to have applied the author.
    const newest = [...(links.data ?? [])]
      .filter((event) => event.pubkey === me)
      .sort((a, b) => b.created_at - a.created_at)
      .map((event) => publishedPasskeyAccount(event.content))
      .find(Boolean);
    return newest ?? null;
  }, [links.data, me]);
  const source = own
    ? { keys: own, mustBe: null }
    : kept
      ? { keys: kept, mustBe: null }
      : published
        ? { keys: published.keys, mustBe: published.address }
        : null;
  const keysId = source
    ? `${source.keys.credentialId}:${source.keys.publicKey}`
    : "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: the keys are identified by keysId
  const sender = useMemo<SponsoredSender | null>(
    () =>
      network && source
        ? createSponsoredSender({
            chainId: network.chainId,
            rpcUrl: network.rpcUrl,
            credentialId: source.keys.credentialId,
            r1OwnerKey: source.keys.publicKey,
          })
        : null,
    [network, keysId],
  );
  const passkeyReady = sender?.isAvailable() ?? false;
  const passkeyAddress = useQuery({
    queryKey: [
      "launchpad",
      "acting-account",
      network?.chainId ?? 0,
      keysId,
      source?.mustBe ?? "",
    ],
    enabled: passkeyReady,
    queryFn: async () => {
      const address = ((await sender?.getAddress()) ?? "").toLowerCase();
      if (!address) return null;
      if (source?.mustBe && source.mustBe !== address) {
        throw new Error(
          "The passkey account published with your name does not match its link, so it is not used here.",
        );
      }
      return address;
    },
    staleTime: Number.POSITIVE_INFINITY,
    retry: 1,
  });
  // Kept for this person, so signing out, or this browser forgetting its passkey sign-in, does not lose the account.
  useEffect(() => {
    if (!me || !source || !passkeyAddress.data) return;
    if (source.keys !== kept) rememberPasskeyAccount(me, source.keys);
  }, [me, source, kept, passkeyAddress.data]);

  const kind = chooseActingKind({
    saved,
    passkey: passkeyReady,
    wallet: injected.hasProvider,
  });

  const setKind = useCallback((next: ActingKind) => {
    saveActingKind(next);
    window.dispatchEvent(new Event(KIND_EVENT));
  }, []);

  const sendCalls = useCallback(
    async (calls: SenderCall[], chainId: number): Promise<string> => {
      if (kind === "passkey" && network && network.chainId !== chainId) {
        throw new Error(
          `Your passkey account works on ${networkLabel(network.chainId)}, but this is on ${networkLabel(chainId)}.`,
        );
      }
      const effects =
        kind === "wallet" && injected.wallet
          ? makeWalletAuctionEffects({
              provider: injected.wallet.provider,
              deployer: injected.wallet.address,
              chainId,
            })
          : null;
      if (
        kind === null ||
        (kind === "passkey" && !sender) ||
        (kind === "wallet" && !effects)
      ) {
        throw new Error("There is no account in this browser to send this.");
      }
      let txHash: string;
      try {
        txHash = await sendAsAccount({
          kind,
          calls,
          sponsored: sender ?? undefined,
          walletSend: effects
            ? async (call) => {
                const receipt = await effects.send({
                  to: call.to,
                  data: call.data,
                  value: call.value ?? "0x0",
                });
                return {
                  txHash: receipt.txHash,
                  status: receipt.status === "success" ? "success" : "reverted",
                };
              }
            : undefined,
        });
      } catch (error) {
        if (
          error instanceof StepRevertedError ||
          error instanceof PartialStepError
        ) {
          throw error;
        }
        throw new Error(actingErrorMessage(error));
      }
      // The account that acted stays the one that acts here, so a passkey set up later, or a wallet added, does not
      // quietly move this person to an account that holds none of what they did.
      if (loadActingKind() === null) setKind(kind);
      return txHash;
    },
    [kind, sender, network, injected.wallet, setKind],
  );

  const available = { wallet: injected.hasProvider, passkey: passkeyReady };
  const passkeyOffered = network !== null;
  if (kind === "passkey") {
    return {
      wallet: null,
      address: passkeyAddress.data ?? null,
      chainId: network?.chainId ?? null,
      hasProvider: true,
      accountsChecked: !passkeyAddress.isPending,
      connecting: false,
      error: passkeyAddress.error
        ? actingErrorMessage(passkeyAddress.error)
        : null,
      connect: async () => {},
      kind,
      available,
      passkeyOffered,
      setKind,
      sponsored: sender,
      passkeyKeys: passkeyAddress.data ? (source?.keys ?? null) : null,
      sendCalls,
    };
  }
  return {
    ...injected,
    kind,
    available,
    passkeyOffered,
    setKind,
    sponsored: sender,
    passkeyKeys: passkeyAddress.data ? (source?.keys ?? null) : null,
    sendCalls,
  };
}
