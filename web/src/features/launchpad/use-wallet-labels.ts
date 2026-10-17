import { useMemo } from "react";

import { useProfiles } from "@/features/profiles/use-profiles";
import { pickUserName } from "@/features/profiles/lib/user-label";

import { personLabeler, pubkeysToName } from "./lib/record-people";
import { usePeopleWithWallets } from "./use-people";

/**
 * How to write a wallet on screen: `Name (0xabcd…1234)` when exactly one person on this server bound that wallet to their
 * account and has a name, otherwise just the short address. Pass the wallets about to be shown (the names are one
 * batched, bounded lookup); the returned function is safe to call for any address, named or not.
 */
export function useWalletLabels(
  addresses: readonly string[],
): (address: string) => string {
  const wallets = usePeopleWithWallets();
  const named = useMemo(
    () => pubkeysToName(wallets.data ?? [], addresses),
    [wallets.data, addresses],
  );
  const profiles = useProfiles(named);
  return useMemo(
    () =>
      personLabeler(wallets.data ?? [], (pubkey) =>
        pickUserName(profiles.data?.[pubkey]),
      ),
    [wallets.data, profiles.data],
  );
}
