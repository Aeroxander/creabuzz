/**
 * Gathers what the room needs to know about the person (their wallet link, what their wallets hold of the project, whether
 * they took out lately, whether the team stopped them) and gives it to the rule (`room-standing.ts`). The holding is read from
 * the network through the person's own sender, so it is as fresh as the network; the server's own view is a little behind
 * (it counts only blocks that are final), which is why a person who backed seconds ago may be told to try again in a minute.
 */
import { serverSmartAccountLinks } from "@creaton/core/client/server-settings.ts";
import { balanceOf } from "@creaton/core/pot/pot-reads.ts";
import { useQuery } from "@tanstack/react-query";
import { useAccount } from "../../lib/account";
import type { ProjectNumbers } from "../money/numbers";
import { senderKind } from "../money/wallet";
import { ownSteps } from "../pot/own-history";
import { usePotWallet } from "../pot/use-pot";
import type { Project } from "../project/project-record";
import { useTeamWallets } from "../team/use-wallets";
import { mutedUntil } from "./room-records";
import { atFloor, type Standing, standingOf } from "./room-standing";
import { useRoomMutes } from "./use-room";

/** When the account last took its money out of the project on this device, or null. */
function lastTakeOut(addresses: readonly string[], key: string): number | null {
  let at: number | null = null;
  for (const address of addresses)
    for (const step of ownSteps(address, key))
      if (step.kind !== "back") at = Math.max(at ?? 0, step.at);
  return at;
}

export function useRoomStanding(
  project: Project,
  numbers: ProjectNumbers | null,
  team: readonly string[],
): {
  standing: Standing;
  mutes: ReturnType<typeof useRoomMutes>["data"];
  /** Reads what the wallets hold again (the press offered when it could not be read). */
  retry: () => void;
} {
  const { pubkey: me } = useAccount();
  const pot = usePotWallet(numbers?.chainId);
  const links = useTeamWallets(me ? [me] : []);
  const mutes = useRoomMutes(project.coordinate, team, true);
  const link = me
    ? (links.data?.[me] ??
      (links.isError ? { state: "unchecked" as const } : undefined))
    : undefined;
  const linked = link?.state === "linked" ? link.address.toLowerCase() : null;
  const connected = pot.address?.toLowerCase() ?? null;
  // The server counts only the wallet the account linked, never the wallet this browser happens to be connected to. Where there
  // is no link yet, the connected wallet only decides whether the person is offered the press that makes one.
  const own = linked ?? connected;
  const addresses = [
    ...new Set([linked, connected].filter((a): a is string => !!a)),
  ];
  const canRead =
    numbers !== null &&
    pot.wallet.isAvailable() &&
    addresses.length > 0 &&
    pot.onChain === true;
  const holding = useQuery({
    queryKey: [
      "room",
      "holding",
      numbers?.contracts.shares ?? "",
      numbers?.contracts.team ?? "",
      ...addresses,
    ],
    enabled: canRead,
    staleTime: 30_000,
    retry: false,
    queryFn: async () => {
      const held: Record<string, { shares: bigint; team: bigint }> = {};
      if (!numbers) return held;
      await Promise.all(
        addresses.map(async (address) => {
          held[address] = {
            shares: await balanceOf(
              pot.read,
              numbers.contracts.shares,
              address,
            ),
            team: await balanceOf(pot.read, numbers.contracts.team, address),
          };
        }),
      );
      return held;
    },
  });
  // A read that failed, or a wallet on another network, is "could not check": never "does not hold", which would send a holder
  // back to spend more.
  const unreadable =
    numbers !== null &&
    pot.wallet.isAvailable() &&
    addresses.length > 0 &&
    (pot.onChain === false || holding.isError);
  const cannotRead =
    numbers === null ||
    !pot.wallet.isAvailable() ||
    addresses.length === 0 ||
    pot.onChain === false ||
    holding.isError;
  const ownHolds = cannotRead || !own ? null : holding.data?.[own];
  const elsewhere =
    !cannotRead && linked && connected && connected !== linked
      ? holding.data?.[connected]
      : undefined;
  // The account is linked to one wallet and the Shares are in the one this browser is connected to: the server will not see
  // them until the account is confirmed again, so the person is offered that press (never a composer the server would refuse).
  const moved = Boolean(
    ownHolds && !atFloor(ownHolds) && elsewhere && atFloor(elsewhere),
  );
  const holds = moved ? elsewhere : ownHolds;
  const seen = moved && connected ? [connected] : own ? [own] : [];
  const claimable = Boolean(
    numbers?.team.grants.some(
      (g) => g.claimable > 0n && seen.includes(g.member.toLowerCase()),
    ),
  );
  const now = Math.floor(Date.now() / 1000);
  const standing = standingOf({
    me,
    holds,
    unreadable,
    claimable,
    tookOutAt: numbers ? lastTakeOut(seen, numbers.key) : null,
    unit: numbers?.unit ?? 0,
    now,
    link: moved ? { state: "none" } : link,
    phoneUnsupported:
      senderKind(pot.wallet) === "passkey" &&
      serverSmartAccountLinks() === false,
    mutedUntil: me ? mutedUntil(mutes.data ?? [], me, seen) : null,
  });
  return {
    standing,
    mutes: mutes.data,
    retry: () => void holding.refetch(),
  };
}
