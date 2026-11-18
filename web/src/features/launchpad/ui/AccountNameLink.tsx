/**
 * "Show your name with this account" (D139): a passkey account is a new address nobody knows, so until its owner links
 * it to their name, reviewers and voters see only the address, and a founder cannot pick them by name. The link is the
 * person's payment wallet record, so it is asked for the way the payment wallet card asks: with what it means said, and
 * a box ticked. When their name already shows with another wallet, that is said first, because linking moves it (and
 * what projects pay by name) to this account. One link runs at a time on a page, however many strips offer it.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";

import type { PasskeyAccountKeys } from "@/features/identity/lib/passkey-account";
import { linkPasskeyAccount } from "@/features/identity/lib/passkey-wallet";
import { readPendingWalletProof } from "@/features/identity/lib/public-wallet";
import { usePaymentWallet } from "@/features/identity/use-payment-wallet";
import { existingUserPubkey } from "@/shared/lib/identity";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { Button } from "@/shared/ui/button";

import { actingErrorMessage } from "../lib/acting-account";

/** The link being made on this page, so a second strip's button does not start a second one. */
let linking: Promise<unknown> | null = null;

export function AccountNameLink({
  account,
  keys,
  testIdPrefix,
}: {
  account: string;
  keys: PasskeyAccountKeys | null;
  testIdPrefix: string;
}) {
  const me = existingUserPubkey() ?? "";
  const link = usePaymentWallet(me);
  const queryClient = useQueryClient();
  const consentId = useId();
  const [open, setOpen] = useState(false);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const result = link.data;
  const current = result && "wallet" in result ? result.wallet : null;
  const linked = current?.address.toLowerCase() === account.toLowerCase();
  if (!me || !keys || link.isLoading) return null;
  if (linked) {
    return done ? (
      <p
        aria-live="polite"
        className="mt-1"
        data-testid={`${testIdPrefix}-link-name-done`}
        role="status"
      >
        Your name now shows with this account.
      </p>
    ) : null;
  }
  // The newest record already published, so the new link replaces it rather than losing to it.
  const newerThan = Math.max(
    readPendingWalletProof(me)?.created_at ?? 0,
    current?.event.created_at ??
      (result && "event" in result ? (result.event?.created_at ?? 0) : 0),
  );
  const run = () => {
    setBusy(true);
    setProblem(null);
    linking ??= linkPasskeyAccount({ newerThan, keys }).finally(() => {
      linking = null;
    });
    void linking
      .then(async () => {
        setDone(true);
        setOpen(false);
        await queryClient.invalidateQueries({ queryKey: ["identity"] });
      })
      .catch((error: unknown) => setProblem(actingErrorMessage(error)))
      .finally(() => setBusy(false));
  };
  if (!open) {
    return (
      <p className="mt-1">
        {current ? (
          <span data-testid={`${testIdPrefix}-link-name-elsewhere`}>
            Your name shows with another wallet,{" "}
            <span className="font-mono">{truncatePubkey(current.address)}</span>
            .{" "}
          </span>
        ) : null}
        <button
          className="underline"
          data-testid={`${testIdPrefix}-link-name`}
          onClick={() => {
            setConsent(false);
            setOpen(true);
          }}
          type="button"
        >
          {current
            ? "Show it with this passkey account instead"
            : "Show your name with this account, so others know it is you and your other devices can find it"}
        </button>
      </p>
    );
  }
  return (
    <div
      className="mt-2 rounded-md border border-black/10 p-2 dark:border-white/10"
      data-testid={`${testIdPrefix}-link-name-panel`}
    >
      <p>
        {current
          ? "Your name will show with this account instead, and projects that pay you by name will pay it."
          : "Your name will show with this account, and projects that pay you by name will pay it."}{" "}
        Work you already submitted keeps the account it was submitted from.
      </p>
      <label className="mt-2 flex items-start gap-2" htmlFor={consentId}>
        <input
          checked={consent}
          className="mt-1"
          data-testid={`${testIdPrefix}-link-name-consent`}
          disabled={busy}
          id={consentId}
          onChange={(e) => setConsent(e.target.checked)}
          type="checkbox"
        />
        <span>
          Show this account's address on my profile. Anyone can then see its
          history.
        </span>
      </label>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button
          aria-busy={busy}
          data-testid={`${testIdPrefix}-link-name-confirm`}
          disabled={busy || !consent}
          onClick={run}
          size="sm"
          type="button"
        >
          {busy ? "Confirm with your passkey…" : "Show my name with it"}
        </Button>
        <Button
          disabled={busy}
          onClick={() => setOpen(false)}
          size="sm"
          type="button"
          variant="ghost"
        >
          Cancel
        </Button>
      </div>
      {problem ? (
        <p
          className="mt-1 text-red-700 dark:text-red-300"
          data-testid={`${testIdPrefix}-link-name-problem`}
          role="alert"
        >
          {problem}
        </p>
      ) : null}
    </div>
  );
}
