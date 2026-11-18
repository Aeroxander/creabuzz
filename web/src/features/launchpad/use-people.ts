import { useQuery } from "@tanstack/react-query";

import {
  canonicalBindingByPubkey,
  parseBindingRecord,
} from "@/features/projects/lib/bindings";
import { KIND_EVM_BINDING } from "@/shared/constants/kinds";
import { queryEvents } from "@/shared/lib/nostr-client";
import { relayWsUrl } from "@/shared/lib/relay-url";

export interface PersonWithWallet {
  /** The person's key on this server, so a name can be looked up. */
  pubkey: string;
  /** The wallet address they have bound, in lower case. */
  address: string;
}

/** How many binding records one lookup reads: a bound, not a scan of everything the server holds. */
const MAX_RECORDS = 200;

/**
 * The people on this server who have bound a wallet, newest binding per person, withdrawn ones left out. A decision form
 * asks for wallet addresses (a reviewer, a manager, someone to pay); nobody knows those by heart, so the forms offer
 * these by name instead. The server checks a binding when it is published, so nothing is verified again here.
 */
export function usePeopleWithWallets() {
  return useQuery({
    queryKey: ["launchpad", "people-with-wallets", relayWsUrl()],
    queryFn: async (): Promise<PersonWithWallet[]> => {
      const events = await queryEvents(relayWsUrl(), {
        kinds: [KIND_EVM_BINDING],
        limit: MAX_RECORDS,
      });
      const records = events.flatMap((event) => {
        const record = parseBindingRecord(event);
        return record ? [record] : [];
      });
      return [...canonicalBindingByPubkey(records).values()]
        .filter((record) => !record.revoked)
        .map(({ pubkey, address }) => ({ pubkey, address }));
    },
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    retry: 1,
  });
}
