/**
 * Banning and un-banning people, ending a community-wide mute early, and the list of who is banned or muted.
 *
 * Each write is a record the moderator signs (the server decides who may: an owner can ban anyone but themselves, an
 * admin only members). The list is the server's own, read by an owner or admin; anyone else is refused, so it is asked
 * only for one.
 */

import { useQuery } from "@tanstack/react-query";
import { useCallback } from "react";

import {
  buildBan,
  buildUnban,
  buildUntimeout,
} from "@/features/moderation/lib/moderationEvents";
import { makeNip98AuthHeader } from "@/shared/lib/nip98";
import { publishAsUser } from "@/shared/lib/publish-as-user";
import { relayHttpBaseUrl } from "@/shared/lib/relay-url";

import { existingUserPubkey } from "@/shared/lib/identity";

import { mayRemove } from "./lib/access";
import { banExpiry, parseBans, parseTimeouts } from "./lib/bans";
import { useCommunityPeople } from "./use-access";

async function fetchBans() {
  const url = `${relayHttpBaseUrl().replace(/\/+$/, "")}/moderation/restricted`;
  const authorization = await makeNip98AuthHeader(url, "GET");
  let response: Response;
  try {
    response = await fetch(url, { headers: { Authorization: authorization } });
  } catch {
    throw new Error(
      "Could not reach the server. Check your connection and try again.",
    );
  }
  if (!response.ok) {
    throw new Error(
      response.status === 401 || response.status === 403
        ? "Only an owner or admin can see who is banned."
        : "The server did not give the list of banned people. Try again in a moment.",
    );
  }
  const json: unknown = await response.json();
  const now = Math.floor(Date.now() / 1000);
  return { bans: parseBans(json, now), timeouts: parseTimeouts(json, now) };
}

/** The people banned from this community right now, and those muted everywhere in it. */
export function useBans(enabled: boolean) {
  return useQuery({
    queryKey: ["community-bans", relayHttpBaseUrl()],
    queryFn: fetchBans,
    enabled,
    // Read again each time People opens: a ban or mute given from a report elsewhere should show here at once.
    staleTime: 0,
    retry: 1,
    refetchOnWindowFocus: false,
  });
}

/**
 * Ban a person for good, or for `secs` seconds. They are signed out at once and told the reason given. Throws with the
 * server's own words when it refuses.
 */
export async function banPerson(
  pubkey: string,
  secs: number | null,
  reason: string,
): Promise<void> {
  await publishAsUser(
    buildBan({
      pubkey,
      expiresAt: banExpiry(Math.floor(Date.now() / 1000), secs),
      reason,
    }),
    "The server did not ban them.",
  );
}

/** Lift a ban. They can use the community again as before. */
export async function liftBan(pubkey: string): Promise<void> {
  await publishAsUser(
    buildUnban({ pubkey }),
    "The server did not lift the ban.",
  );
}

/**
 * End a community-wide mute early: they can write again at once. The server refuses when they are not muted any more
 * (it ran out, or someone else ended it), and says so.
 */
export async function endTimeout(pubkey: string): Promise<void> {
  await publishAsUser(
    buildUntimeout({ pubkey }),
    "The server did not end the mute.",
  );
}

/**
 * Whether the person using the app is offered "Ban" for an author they are reading. Only an owner or admin is, and
 * under the same rank rule as the People list: an owner for anyone but themselves, an admin for members only. Someone
 * who is not on the community's list (a visitor to an open community) counts as a member. The server decides again.
 */
export function useCanBan(): (author: string) => boolean {
  const { people, myRole } = useCommunityPeople();
  const me = existingUserPubkey();
  return useCallback(
    (author: string) => {
      const key = author.toLowerCase();
      const person = people.find((p) => p.pubkey === key) ?? {
        pubkey: key,
        role: "member" as const,
      };
      return mayRemove(myRole, me, person);
    },
    [people, myRole, me],
  );
}
