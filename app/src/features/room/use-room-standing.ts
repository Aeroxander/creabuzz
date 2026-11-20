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
import { type Standing, standingOf } from "./room-standing";
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
): { standing: Standing; mutes: ReturnType<typeof useRoomMutes>["data"] } {
  const { pubkey: me } = useAccount();
  const pot = usePotWallet(numbers?.chainId);
  const links = useTeamWallets(me ? [me] : []);
  const mutes = useRoomMutes(project.coordinate, team, true);
  const link = me
    ? (links.data?.[me] ??
      (links.isError ? { state: "unchecked" as const } : undefined))
    : undefined;
  const linked = link?.state === "linked" ? link.address.toLowerCase() : null;
  const addresses = [
    ...new Set(
      [linked, pot.address?.toLowerCase()].filter((a): a is string => !!a),
    ),
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
      if (!numbers) return { shares: 0n, team: 0n };
      // The most any one of the person's wallets holds: the server counts a seat for any one of them.
      const most = (values: bigint[]) =>
        values.reduce((m, v) => (v > m ? v : m), 0n);
      const reads = await Promise.all(
        addresses.map(async (address) => ({
          shares: await balanceOf(pot.read, numbers.contracts.shares, address),
          team: await balanceOf(pot.read, numbers.contracts.team, address),
        })),
      );
      return {
        shares: most(reads.map((r) => r.shares)),
        team: most(reads.map((r) => r.team)),
      };
    },
  });
  const cannotRead =
    numbers === null ||
    !pot.wallet.isAvailable() ||
    addresses.length === 0 ||
    pot.onChain === false ||
    holding.isError;
  const holds = cannotRead ? null : holding.data;
  const claimable = Boolean(
    numbers?.team.grants.some(
      (g) => g.claimable > 0n && addresses.includes(g.member.toLowerCase()),
    ),
  );
  const now = Math.floor(Date.now() / 1000);
  const standing = standingOf({
    me,
    holds,
    claimable,
    tookOutAt: numbers ? lastTakeOut(addresses, numbers.key) : null,
    unit: numbers?.unit ?? 0,
    now,
    link,
    phoneUnsupported:
      senderKind(pot.wallet) === "passkey" &&
      serverSmartAccountLinks() === false,
    mutedUntil: me ? mutedUntil(mutes.data ?? [], me, addresses) : null,
  });
  return { standing, mutes: mutes.data };
}
