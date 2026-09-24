/**
 * The launchpad money-action sender picker: wallet vs sponsored passkey,
 * exactly the `ui/RecordBidDialog.tsx` pattern extracted so the exit/claim and
 * mint flows share one picker implementation. The COMPOSER stays outside —
 * each flow builds its `SenderCall[]` once and hands the same bytes to either
 * sender (`identity/lib/sponsoredSender.test.mjs` binds that parity for bids;
 * `lib/exit-claim.test.mjs` binds it for exit/claim/mint).
 */
import { useEffect, useMemo, useState } from "react";

import { kernel033ChainRpcUrl } from "@/features/identity/lib/kernel033";
import {
  createSponsoredSender,
  type SponsoredSender,
  type SponsoredSenderAvailability,
} from "@/features/identity/lib/sponsoredSender";
import { zerodevConfigFromEnv } from "@/features/identity/lib/zerodev";
import { truncatePubkey } from "@/shared/lib/pubkey";

import type { Eip1193ProviderLike } from "../lib/wallet-sender";
import {
  resolveSender,
  senderErrorMessage,
  type SenderKind,
} from "../lib/sender-choice";

// Re-exported so dialogs keep one import site; the testable seam lives in
// `lib/sender-choice.ts` (node --test cannot load this .tsx).
export { resolveSender, senderErrorMessage };
export type { SenderKind };

/** Everything a dialog needs to render the picker and resolve a sender. */
export interface SenderPickerState {
  kind: SenderKind;
  setKind: (kind: SenderKind) => void;
  wallet: Eip1193ProviderLike | undefined;
  sponsoredSender: SponsoredSender;
  sponsoredStatus: SponsoredSenderAvailability;
  passkeyAccount: string | null;
  passkeyNote: string | null;
  passkeyStatusText: string;
  chainId: number;
}

/**
 * Picker state: chosen sender, sponsored availability, and the derived
 * passkey account (fenced — a stale derivation must not write state after the
 * user switches away, Review-Proven Rule 2).
 */
export function useSenderPicker(): SenderPickerState {
  const [kind, setKind] = useState<SenderKind>("wallet");
  const [passkeyAccount, setPasskeyAccount] = useState<string | null>(null);
  const [passkeyNote, setPasskeyNote] = useState<string | null>(null);

  const wallet =
    typeof window === "undefined"
      ? undefined
      : (window as unknown as { ethereum?: Eip1193ProviderLike }).ethereum;

  // The passkey sender runs on the sponsored stack's chain (Sepolia in this
  // wave): the ZeroDev chain id plus `kernel033ChainRpcUrl`'s RPC for the
  // kernel reads. Missing config is an explicit unavailable state below.
  const chainId = zerodevConfigFromEnv().chainId ?? 0;
  const sponsoredRpcUrl = useMemo(() => {
    if (!Number.isInteger(chainId) || chainId <= 0) return "";
    try {
      return kernel033ChainRpcUrl(chainId);
    } catch {
      return "";
    }
  }, [chainId]);
  const sponsoredSender = useMemo(
    () => createSponsoredSender({ chainId, rpcUrl: sponsoredRpcUrl }),
    [chainId, sponsoredRpcUrl],
  );
  const sponsoredStatus = useMemo(
    () => sponsoredSender.availability(),
    [sponsoredSender],
  );

  useEffect(() => {
    if (kind !== "passkey") return;
    let alive = true;
    setPasskeyAccount(null);
    setPasskeyNote(null);
    sponsoredSender.getAddress().then(
      (address) => {
        if (alive) setPasskeyAccount(address);
      },
      (err: unknown) => {
        if (alive) {
          setPasskeyNote(
            err instanceof Error
              ? err.message
              : "Could not derive the account.",
          );
        }
      },
    );
    return () => {
      alive = false;
    };
  }, [kind, sponsoredSender]);

  let passkeyStatusText = "Deriving the account address…";
  if (!sponsoredStatus.available) {
    passkeyStatusText =
      `${sponsoredStatus.reason ?? ""} ${sponsoredStatus.action ?? ""}`.trim();
  } else if (passkeyNote) {
    passkeyStatusText = passkeyNote;
  } else if (passkeyAccount) {
    passkeyStatusText = `Account ${truncatePubkey(passkeyAccount)} — tokens and refunds settle there. Gas is sponsored on chain ${chainId}.`;
  }

  return {
    kind,
    setKind,
    wallet,
    sponsoredSender,
    sponsoredStatus,
    passkeyAccount,
    passkeyNote,
    passkeyStatusText,
    chainId,
  };
}

/**
 * The radio pair, mirrored from `RecordBidDialog`'s "Send with" fieldset.
 * `testIdPrefix` keeps each surface's testids distinct (`bid-`, `mybids-`,
 * `mint-`).
 */
export function SenderPickerControls({
  state,
  testIdPrefix,
  legend = "Send with",
}: {
  state: SenderPickerState;
  testIdPrefix: string;
  legend?: string;
}) {
  return (
    <fieldset className="mt-3 rounded-lg border border-black/10 p-3 dark:border-white/10">
      <legend className="text-sm font-medium">{legend}</legend>
      <label className="flex items-start gap-2 text-sm text-black/80 dark:text-white/80">
        <input
          checked={state.kind === "wallet"}
          data-testid={`${testIdPrefix}sender-wallet`}
          name={`${testIdPrefix}sender`}
          onChange={() => state.setKind("wallet")}
          type="radio"
        />
        <span>
          Injected wallet (current)
          {!state.wallet ? (
            <span className="block text-xs text-black/60 dark:text-white/60">
              No injected wallet in this browser — pick the passkey account
              instead.
            </span>
          ) : null}
        </span>
      </label>
      <label className="mt-2 flex items-start gap-2 text-sm text-black/80 dark:text-white/80">
        <input
          checked={state.kind === "passkey"}
          data-testid={`${testIdPrefix}sender-passkey`}
          name={`${testIdPrefix}sender`}
          onChange={() => state.setKind("passkey")}
          type="radio"
        />
        <span>
          Passkey account — gas sponsored (Sepolia)
          {state.kind === "passkey" ? (
            <span
              className="block text-xs text-black/60 dark:text-white/60"
              data-testid={`${testIdPrefix}sender-passkey-status`}
            >
              {state.passkeyStatusText}
            </span>
          ) : null}
        </span>
      </label>
    </fieldset>
  );
}
