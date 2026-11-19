/**
 * Which sender sends a person's money steps, and the choice between them. Two exist: the wallet in this browser
 * (`wallet.ts`, the default and exactly as it was) and the person's own passkey account with the network fee paid by the
 * server (`passkey-sender.ts`). The passkey one is only ever used when the build turned it on
 * (`VITE_CREATON_PASSKEY_ACCOUNT=1`); with it off, `useSender` is `injectedWallet()` and nothing else.
 */
import { useMemo, useSyncExternalStore } from "react";
import { useAccount } from "../../lib/account";
import {
  createPasskeySender,
  passkeySendingOn,
  passkeySettings,
} from "./passkey-sender";
import {
  injectedWallet,
  type MoneyWallet,
  type SenderKind,
  senderAvailability,
} from "./wallet";

const CHOICE_KEY = "creaton.money.sender";
const CHOICE_EVENT = "creaton:sender-choice";

/** The sender this browser's person chose when both can send, or null. */
export function readSenderChoice(): SenderKind | null {
  try {
    const value = localStorage.getItem(CHOICE_KEY);
    return value === "wallet" || value === "passkey" ? value : null;
  } catch {
    return null;
  }
}

/** Remember the choice (storage that cannot be used only loses it). */
export function writeSenderChoice(choice: SenderKind): void {
  try {
    localStorage.setItem(CHOICE_KEY, choice);
  } catch {
    // Storage is off: the choice holds for this page only, through the event below.
  }
  window.dispatchEvent(new CustomEvent(CHOICE_EVENT, { detail: choice }));
}

let pageChoice: SenderKind | null = null;

function subscribeChoice(onChange: () => void): () => void {
  const handler = (event: Event) => {
    pageChoice = (event as CustomEvent<SenderKind>).detail ?? null;
    onChange();
  };
  window.addEventListener(CHOICE_EVENT, handler);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHOICE_EVENT, handler);
    window.removeEventListener("storage", onChange);
  };
}

const currentChoice = (): SenderKind | null => readSenderChoice() ?? pageChoice;

/**
 * The sender for these two, by the rule: a browser with a wallet uses it (today's way) unless the person chose their
 * passkey account and that can send; with no wallet the passkey account is the sender when the build has it. The
 * passkey sender is returned even when it cannot send, so the reason it cannot (`senderAvailability`) can be told.
 */
export function chooseSender(input: {
  wallet: MoneyWallet;
  passkey: MoneyWallet | null;
  preferred: SenderKind | null;
}): MoneyWallet {
  const { wallet, passkey, preferred } = input;
  if (!passkey) return wallet;
  if (!wallet.isAvailable()) return passkey;
  return preferred === "passkey" && passkey.isAvailable() ? passkey : wallet;
}

/** The two senders of this page and the choice between them, for the screens that show it. */
export function useSenders(): {
  wallet: MoneyWallet;
  passkey: MoneyWallet | null;
  preferred: SenderKind | null;
  chosen: MoneyWallet;
} {
  // A passkey made, restored or removed here changes what the passkey sender can do: this re-renders on it.
  const { pubkey } = useAccount();
  const preferred = useSyncExternalStore(
    subscribeChoice,
    currentChoice,
    () => null,
  );
  const wallet = useMemo(() => injectedWallet(), []);
  const passkey = useMemo(
    () => (passkeySendingOn() ? createPasskeySender(passkeySettings()) : null),
    [],
  );
  // `pubkey` is read so the choice below is made again when the account changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  const chosen = useMemo(
    () => chooseSender({ wallet, passkey, preferred }),
    [wallet, passkey, preferred, pubkey],
  );
  return { wallet, passkey, preferred, chosen };
}

/** The sender that sends this person's money steps. */
export function useSender(): MoneyWallet {
  return useSenders().chosen;
}

/** What to tell a person whose passkey sender cannot send, in plain words, or null when nothing needs saying. */
export function passkeyUnavailableSentence(sender: MoneyWallet): string | null {
  const now = senderAvailability(sender);
  if (now.ok) return null;
  if (now.reason === "not-set-up")
    return "Backing from this phone is not switched on for this server yet. Open this page in a browser with a wallet to back now.";
  if (now.reason === "no-passkey")
    return "To back from this phone you need to be signed in with a passkey. Or open this page in a browser with a wallet.";
  return null;
}
