/**
 * The injected wallet (`window.ethereum`) as React state: the connected
 * account and the chain it is on, kept current as the user switches either.
 *
 * Connecting is always an explicit click (`connect`): mounting only reads
 * accounts the site was already granted (`eth_accounts`, no prompt), so opening
 * a panel never pops a wallet dialog. Async reads are fenced — a response that
 * lands after unmount, or after a newer read, is dropped (Review-Proven
 * Rule 2) — and the wallet's event listeners are removed on unmount.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { walletError } from "./lib/wallet-effects";
import type { Eip1193ProviderLike } from "./lib/wallet-sender";
import type { ConnectedWallet } from "./use-auction-flow";

interface EventfulProvider extends Eip1193ProviderLike {
  on?: (event: string, handler: (...args: never[]) => void) => void;
  removeListener?: (event: string, handler: (...args: never[]) => void) => void;
}

function injectedProvider(): EventfulProvider | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { ethereum?: EventfulProvider }).ethereum;
}

/** A hex `eth_chainId` answer as a number, or null when it is not one. */
function parseChainId(value: unknown): number | null {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) return null;
  const n = Number(BigInt(value));
  return Number.isSafeInteger(n) ? n : null;
}

export interface ConnectedWalletState {
  /** The provider and account, or null until an account is connected. */
  wallet: ConnectedWallet | null;
  address: string | null;
  /** The chain the wallet is on, or null while unknown. */
  chainId: number | null;
  /** False when the browser has no injected wallet at all. */
  hasProvider: boolean;
  connecting: boolean;
  error: string | null;
  connect: () => Promise<void>;
}

export function useConnectedWallet(): ConnectedWalletState {
  const provider = useMemo(() => injectedProvider(), []);
  const [address, setAddress] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped by every read, so a slow earlier answer cannot overwrite a newer one.
  const generation = useRef(0);
  const mounted = useRef(true);

  const readChain = useCallback(async () => {
    if (!provider) return;
    const mine = ++generation.current;
    try {
      const value = parseChainId(
        await provider.request({ method: "eth_chainId" }),
      );
      if (mounted.current && mine === generation.current) setChainId(value);
    } catch {
      if (mounted.current && mine === generation.current) setChainId(null);
    }
  }, [provider]);

  useEffect(() => {
    mounted.current = true;
    if (!provider) return;
    let alive = true;

    void (async () => {
      try {
        const accounts = (await provider.request({
          method: "eth_accounts",
        })) as string[];
        if (alive) setAddress(accounts?.[0] ?? null);
      } catch {
        // Not granted yet: the user connects explicitly.
      }
      if (alive) await readChain();
    })();

    const onAccounts = (accounts: string[]) => {
      if (alive) setAddress(accounts?.[0] ?? null);
    };
    const onChain = (value: string) => {
      if (!alive) return;
      generation.current++;
      setChainId(parseChainId(value));
    };
    provider.on?.("accountsChanged", onAccounts as never);
    provider.on?.("chainChanged", onChain as never);
    return () => {
      alive = false;
      mounted.current = false;
      provider.removeListener?.("accountsChanged", onAccounts as never);
      provider.removeListener?.("chainChanged", onChain as never);
    };
  }, [provider, readChain]);

  const connect = useCallback(async () => {
    if (!provider) return;
    setConnecting(true);
    setError(null);
    try {
      const accounts = (await provider.request({
        method: "eth_requestAccounts",
      })) as string[];
      const first = accounts?.[0] ?? null;
      if (mounted.current) setAddress(first);
      if (!first && mounted.current) setError("No account was selected.");
      await readChain();
    } catch (err) {
      if (mounted.current) setError(walletError(err).message);
    } finally {
      if (mounted.current) setConnecting(false);
    }
  }, [provider, readChain]);

  const wallet = useMemo<ConnectedWallet | null>(
    () => (provider && address ? { provider, address } : null),
    [provider, address],
  );

  return {
    wallet,
    address,
    chainId,
    hasProvider: provider !== undefined,
    connecting,
    error,
    connect,
  };
}
