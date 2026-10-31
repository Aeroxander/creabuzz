import { useQuery } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";

import { useUserNames } from "@/features/profiles/use-profiles";
import { KIND_EVM_BINDING } from "@/shared/constants/kinds";
import { queryEvents } from "@/shared/lib/nostr-client";
import { failureWords } from "@/shared/lib/readable-error";
import { relayWsUrl } from "@/shared/lib/relay-url";

import { mapLimit, walletChainChecker } from "../lib/wallet-chain";
import { resolvePaymentWalletChecked } from "../lib/wallet-proof";

/** Named payment recipients, verified again on selection and scoped to the project's network. */
export function PaymentRecipientPicker({
  chainId,
  onPick,
}: {
  chainId: number | undefined;
  onPick: (address: string) => void;
}) {
  const relay = relayWsUrl();
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const running = useRef(false);
  const query = useQuery({
    queryKey: ["identity", "payment-people", relay, chainId],
    enabled: Number.isSafeInteger(chainId) && Number(chainId) > 0,
    queryFn: async () => {
      const events = await queryEvents(relay, {
        kinds: [KIND_EVM_BINDING],
        limit: 200,
      });
      const authors = [...new Set(events.map((e) => e.pubkey))];
      const checker = walletChainChecker();
      // A smart account's proof is settled by asking the chain, a few at a time.
      const results = await mapLimit(authors, 6, (author) =>
        resolvePaymentWalletChecked(
          events,
          author,
          Math.floor(Date.now() / 1000),
          checker,
        ),
      );
      return results.flatMap((result) =>
        result.state === "verified" && result.wallet.chain === chainId
          ? [result.wallet]
          : [],
      );
    },
    staleTime: 15_000,
    retry: 1,
  });
  const keys = useMemo(
    () => query.data?.map((w) => w.event.pubkey) ?? [],
    [query.data],
  );
  const nameOf = useUserNames(keys);
  const pick = async (pubkey: string) => {
    if (!pubkey || running.current) return;
    running.current = true;
    setChecking(true);
    setError(null);
    try {
      const fresh = await query.refetch({ throwOnError: true });
      const wallet = fresh.data?.find((w) => w.event.pubkey === pubkey);
      if (!wallet)
        throw new Error(
          "This person's wallet proof changed, expired or was removed. Ask them to confirm their payment wallet.",
        );
      onPick(wallet.address);
    } catch (e) {
      setError(
        failureWords(
          e,
          "Couldn't check that payment wallet. Refresh the list and try again.",
        ).text,
      );
    } finally {
      running.current = false;
      setChecking(false);
    }
  };
  return (
    <div className="text-xs text-muted-foreground">
      {query.isLoading ? (
        <p>Checking payment wallets…</p>
      ) : query.isError ? (
        <p role="alert">
          Couldn't look up verified payment wallets.{" "}
          <button
            className="underline"
            onClick={() => void query.refetch()}
            type="button"
          >
            Try again
          </button>
        </p>
      ) : query.data?.length ? (
        <select
          aria-label="Choose a verified payment wallet"
          className="h-8 max-w-full rounded-md border border-input bg-background px-2 text-xs"
          data-testid="pay-recipient-people"
          disabled={checking}
          onChange={(e) => void pick(e.target.value)}
          value=""
        >
          <option value="">
            {checking
              ? "Checking the latest proof…"
              : "Choose a verified payment wallet…"}
          </option>
          {query.data.map((w) => (
            <option key={w.event.pubkey} value={w.event.pubkey}>
              {nameOf(w.event.pubkey)} · {w.address}
            </option>
          ))}
        </select>
      ) : (
        <p>No verified payment wallets are shared on this project's network.</p>
      )}
      {error ? (
        <p className="mt-1 text-destructive" role="alert">
          {error}{" "}
          <button
            className="underline"
            disabled={checking}
            onClick={() => {
              setError(null);
              void query.refetch();
            }}
            type="button"
          >
            Refresh payment wallets
          </button>
        </p>
      ) : null}
      <p className="mt-1">
        You can also paste an agreed address. Check the full recipient, token
        and network in the payment proposal.
      </p>
    </div>
  );
}
