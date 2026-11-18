/**
 * How a screen with a sender picker sends (D144): on a contributor project, as the account the rest of the page acts as
 * (`useActingAccount().sendCalls`, the seam the Decisions tab uses); elsewhere, from the account its own picker is on
 * (`lib/picked-send.ts`). Either way the calls go out on the project's network only and the promise resolves once they
 * landed and succeeded. Raise screens only (see `ui/SenderPicker.tsx`); a new screen sends with `useChainSend`.
 */
import type { SenderCall } from "@/features/identity/lib/sponsoredSender";

import { networkLabel } from "./chain-config";
import { sendPicked } from "./lib/picked-send";
import type { SenderPickerState } from "./ui/SenderPicker";
import { useActingAccount } from "./use-acting-account";

export function usePickedSend(
  picker: SenderPickerState,
  chainId: number,
  followActingAccount: boolean,
): (calls: SenderCall[]) => Promise<string> {
  const acting = useActingAccount();
  return (calls: SenderCall[]) =>
    followActingAccount
      ? acting.sendCalls(calls, chainId)
      : sendPicked({
          kind: picker.kind,
          calls,
          chainId,
          // An unavailable passkey account refuses in its own words (what is missing, and what to do).
          passkey: {
            sendCalls: (c) => picker.sponsoredSender.sendCalls(c),
            chainId: picker.chainId,
          },
          wallet: picker.wallet,
          label: networkLabel,
        });
}
