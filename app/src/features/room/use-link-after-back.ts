/**
 * The last step of Back: link the account to the wallet that made it, so the server can see that this account backs the
 * project and the room opens (plan section 4.7), when the person chose that in the Back box (which says the link is public).
 * Nothing to find, no wall after Back: a passkey account does it with one more touch of the device, a wallet with one signature. It asks for nothing when the account is already linked to this wallet for a
 * good while yet, and it never undoes or delays the Back: a person who declines or fails is told where to finish it, and the
 * Room tab has the same press.
 */
import { isUserRejection } from "@creaton/core/launchpad/wallet-errors.ts";
import { serverSmartAccountLinks } from "@creaton/core/client/server-settings.ts";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { useAccount } from "../../lib/account";
import { investingOn } from "../../lib/server";
import { useToast } from "../../ui/toast";
import {
  type MoneyWallet,
  senderCapabilities,
  senderKind,
} from "../money/wallet";
import { linkWalletNow, readWalletLinks } from "../team/use-wallets";
import { RENEW_WITHIN } from "./room-standing";

/** Whether a failure is the person saying no: a wallet's rejection, or a passkey prompt that was closed. */
function declined(error: unknown): boolean {
  const text =
    error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return (
    isUserRejection(text) || /NotAllowedError|not allowed|cancel/i.test(text)
  );
}

/**
 * Whether Back can end by linking the account: the server has the room on for this kind of account and the sender can sign a
 * message. The Back box shows its choice (and what the link makes public) only then.
 */
export function canLinkAfterBack(wallet: MoneyWallet): boolean {
  if (!investingOn()) return false;
  if (senderKind(wallet) === "passkey" && serverSmartAccountLinks() === false)
    return false;
  return senderCapabilities(wallet).signsMessages;
}

export type AfterBack =
  | "skipped"
  | "already"
  | "linked"
  | "declined"
  | "failed";

export function useLinkAfterBack(
  wallet: MoneyWallet,
): (wanted: boolean) => Promise<AfterBack> {
  const { pubkey } = useAccount();
  const toast = useToast();
  const queryClient = useQueryClient();
  return useCallback(
    async (wanted: boolean) => {
      // The Back landed: what the room thinks the person holds is read again, whatever happens to the link.
      void queryClient.invalidateQueries({ queryKey: ["room"] });
      // The link makes the wallet public: it is made only when the person chose it in the Back box.
      if (!wanted || !pubkey || !canLinkAfterBack(wallet)) return "skipped";
      try {
        const address = (await wallet.getAddress()).toLowerCase();
        const now = Math.floor(Date.now() / 1000);
        const known = (await readWalletLinks(wallet, [pubkey]))[pubkey];
        if (
          known?.state === "linked" &&
          known.address === address &&
          known.expires - now > RENEW_WITHIN
        )
          return "already";
      } catch {
        // Not known whether it is linked: it is linked now, which does no harm.
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await linkWalletNow(wallet, pubkey);
          void queryClient.invalidateQueries({ queryKey: ["team"] });
          void queryClient.invalidateQueries({ queryKey: ["room"] });
          toast("Your account is confirmed for the room.", "done");
          return "linked";
        } catch (error) {
          // A "no" is final; anything else gets one more try.
          if (declined(error)) {
            toast(
              "Backed. To write in the room, confirm this account on the Room tab.",
              "info",
            );
            return "declined";
          }
        }
      }
      toast(
        "Backed. To write in the room, confirm this account on the Room tab.",
        "problem",
      );
      return "failed";
    },
    [pubkey, wallet, toast, queryClient],
  );
}
