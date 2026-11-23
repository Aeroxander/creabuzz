/**
 * The team a grant can go to and a name for an account's address. A name comes from the person's own profile and an
 * account from the wallet they proved is theirs, so an account no one linked reads as its short address and never as a
 * name nobody chose. Both the Money tab and the Back sheet name an account this way: one person reads the same runner
 * named the same on every screen (the vote's sentences name them too).
 */
import {
  nameOf as profileNameOf,
  type ProfileMetadata,
} from "../../lib/profiles";
import type { TeamWallet } from "../team/use-wallets";
import type { GrantMember } from "./GrantSheet";

/** The wallets each member proved are theirs (`useTeamWallets`), by pubkey. */
type Wallets = Readonly<Record<string, TeamWallet>>;

/** The team a grant can go to (the founder first): a member with no linked wallet cannot be granted to yet. */
export function membersOf(
  team: readonly string[],
  wallets: Wallets | undefined,
  profiles: Record<string, ProfileMetadata> | undefined,
): GrantMember[] {
  return team.map((pubkey) => {
    const wallet = wallets?.[pubkey];
    return {
      pubkey,
      name: profileNameOf(profiles, pubkey),
      address: wallet?.state === "linked" ? wallet.address : null,
    };
  });
}

/** A name for an account's address: the member's own name, else the short form of the address. */
export function addressNameOf(members: readonly GrantMember[]) {
  return (address: string) =>
    members.find((m) => m.address === address.toLowerCase())?.name ??
    `${address.slice(0, 6)}…${address.slice(-4)}`;
}
