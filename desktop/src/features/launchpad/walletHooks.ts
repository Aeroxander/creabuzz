import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { invokeTauri } from "@/shared/api/tauri";
import { truncatePubkey } from "@/shared/lib/pubkey";

/**
 * Launchpad in-app EVM wallet + chain status hooks.
 *
 * The wallet is macOS Keychain-backed and managed by the Tauri backend
 * (`evm_wallet_*` / `evm_chain_status` commands). A rejected command
 * propagates into query/mutation error state and is surfaced to the user —
 * never rendered as an empty success.
 *
 * This module is the single home of the wallet- and chain-status queries.
 * (`mintHooks.useEvmChainStatusQuery`, the Manage panel's explicit-gating
 * variant, shares {@link chainStatusQueryKey} so both variants read one cache
 * entry.)
 */

/** `evm_wallet_status` reply. */
export type EvmWalletStatus = {
  hasWallet: boolean;
  address: string | null;
};

/** `evm_wallet_create` / `evm_wallet_import` reply. */
export type EvmWalletAddress = {
  address: string;
};

/** `evm_chain_status` reply. */
export type EvmChainStatus = {
  chainId: number;
};

export const walletStatusQueryKey = ["launchpad", "wallet", "status"] as const;

/**
 * Chain-status key. The endpoint is part of the key so editing the RPC URL
 * refetches — including revisiting a cached URL within staleTime.
 */
export function chainStatusQueryKey(rpcUrl: string) {
  return ["launchpad", "wallet", "chain-status", rpcUrl] as const;
}

const WALLET_STALE_TIME_MS = 30_000;

/**
 * Whether the machine already holds a Keychain-backed wallet. `address` is
 * null when no wallet exists.
 */
export function useWalletStatusQuery() {
  return useQuery({
    queryKey: [...walletStatusQueryKey],
    queryFn: () => invokeTauri<EvmWalletStatus>("evm_wallet_status"),
    staleTime: WALLET_STALE_TIME_MS,
  });
}

/**
 * Chain id reported by the configured RPC endpoint. Disabled until a
 * non-empty URL is supplied.
 */
export function useChainStatusQuery(rpcUrl: string) {
  const endpoint = rpcUrl.trim();
  return useQuery({
    queryKey: chainStatusQueryKey(endpoint),
    queryFn: () =>
      invokeTauri<EvmChainStatus>("evm_chain_status", { rpcUrl: endpoint }),
    enabled: endpoint !== "",
    refetchOnMount: "always",
    staleTime: WALLET_STALE_TIME_MS,
  });
}

/** Create a fresh Keychain-backed wallet. Fails if one already exists. */
export function useWalletCreateMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => invokeTauri<EvmWalletAddress>("evm_wallet_create"),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: [...walletStatusQueryKey],
      });
    },
  });
}

/**
 * Import a secp256k1 private key as 64 lowercase hex characters with no 0x
 * prefix (see `parsePrivateKeyHexInput`). Fails if a wallet already exists.
 */
export function useWalletImportMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { privateKeyHex: string }) =>
      invokeTauri<EvmWalletAddress>("evm_wallet_import", {
        privateKeyHex: input.privateKeyHex,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: [...walletStatusQueryKey],
      });
    },
  });
}

// ── Pure helpers (unit-tested in walletHooks.test.mjs) ──────────────────────

/** Why a pasted private key was rejected. */
export type PrivateKeyParseReason = "empty" | "length" | "charset";

/** Result of normalizing import input for `evm_wallet_import`. */
export type PrivateKeyParse =
  | { ok: true; privateKeyHex: string }
  | { ok: false; reason: PrivateKeyParseReason };

const HEX_64_RE = /^[0-9a-fA-F]{64}$/;

/**
 * Normalize pasted import input to the IPC form: 64 lowercase hex characters
 * with no 0x prefix. Accepts surrounding whitespace and an optional 0x/0X
 * prefix (both common when pasting from a keystore). Structural validation
 * only — scalar-range validity is the Rust command's call to make.
 */
export function parsePrivateKeyHexInput(raw: string): PrivateKeyParse {
  const trimmed = raw.trim();
  const body = trimmed.replace(/^0[xX]/, "");
  if (body === "") return { ok: false, reason: "empty" };
  if (body.length !== 64) return { ok: false, reason: "length" };
  if (!HEX_64_RE.test(body)) return { ok: false, reason: "charset" };
  return { ok: true, privateKeyHex: body.toLowerCase() };
}

/**
 * Display form for a wallet address: canonical `truncatePubkey` shortening
 * (8-char head … 4-char tail) or an em dash when absent. Copy actions use
 * the full address, never this display form.
 */
export function formatWalletAddress(
  address: string | null | undefined,
): string {
  const trimmed = address?.trim() ?? "";
  return trimmed === "" ? "—" : truncatePubkey(trimmed);
}
