/**
 * Who may join this community, who is in it, and making invite links.
 *
 * The community says who may join in its public information (readable before anyone signs in, which is how a stranger
 * is told "ask for an invite" instead of seeing a broken page). Changing it is one signed record from the owner; the
 * server refuses anyone else and its reason is passed on as it is said. An invite link is made with a signed request,
 * and only an owner or admin gets one.
 */

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { existingUserPubkey } from "@/shared/lib/identity";
import { makeNip98AuthHeader } from "@/shared/lib/nip98";
import { queryEvents } from "@/shared/lib/nostr-client";
import { publishAsUser } from "@/shared/lib/publish-as-user";
import { relayHttpBaseUrl, relayWsUrl } from "@/shared/lib/relay-url";

import {
  type Access,
  KIND_MEMBER_LIST,
  type MintedInvite,
  inviteRequestBody,
  parseAccess,
  parseInvites,
  parseMintedInvite,
  peopleFromEvents,
  changeRoleRecord,
  removeMemberRecord,
  roleOf,
  setAccessRecord,
} from "./lib/access";

async function fetchAccess(): Promise<Access | null> {
  const response = await fetch(`${relayHttpBaseUrl()}/info`, {
    headers: { Accept: "application/nostr+json" },
  });
  if (!response.ok) return null;
  const body = (await response.json().catch(() => null)) as {
    access?: unknown;
  } | null;
  return parseAccess(body?.access);
}

/**
 * Who may join the community this browser is connected to. `null` means the server did not say (an older server, or
 * an unknown address), never "open".
 */
export function useCommunityAccess() {
  const url = relayHttpBaseUrl();
  return useQuery({
    queryKey: ["community-access", url],
    queryFn: fetchAccess,
    staleTime: 15_000,
    retry: 1,
    refetchOnWindowFocus: false,
  });
}

/** Set who may join. The owner's record is the only one the server accepts. */
export async function setCommunityAccess(access: Access): Promise<void> {
  await publishAsUser(
    setAccessRecord(access),
    "The server did not change who can join.",
  );
}

/** The people on the community's list, and where this person stands in it. */
export function useCommunityPeople() {
  const me = existingUserPubkey();
  const query = useQuery({
    queryKey: ["community-people", relayWsUrl()],
    queryFn: () =>
      queryEvents(relayWsUrl(), { kinds: [KIND_MEMBER_LIST], limit: 5 }),
    staleTime: 15_000,
    retry: 1,
  });
  const people = useMemo(
    () => peopleFromEvents(query.data ?? []),
    [query.data],
  );
  return {
    people,
    myRole: roleOf(people, me),
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
  };
}

/**
 * A signed request to one of the community's invite routes. Throws with the server's own words when it refuses, and
 * with a plain sentence when it cannot be reached or answers with something unexpected.
 */
async function signedPost(
  path: string,
  request: Record<string, unknown>,
): Promise<unknown> {
  const url = `${relayHttpBaseUrl().replace(/\/+$/, "")}${path}`;
  const body = JSON.stringify(request);
  const authorization = await makeNip98AuthHeader(url, "POST", {
    body,
    requireDurable: true,
  });
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
      },
      body,
    });
  } catch {
    throw new Error(
      "Could not reach the server. Check your connection and try again.",
    );
  }
  const json = (await response.json().catch(() => ({}))) as {
    error?: unknown;
  };
  if (!response.ok) {
    throw new Error(
      typeof json.error === "string" && json.error !== ""
        ? json.error
        : "The server did not accept that. Try again in a moment.",
    );
  }
  return json;
}

/** Make an invite link. Throws with the server's own words when it refuses. */
export async function mintInvite(
  secs: number,
  uses: number | null,
): Promise<MintedInvite> {
  const invite = parseMintedInvite(
    await signedPost("/api/invites", inviteRequestBody(secs, uses)),
  );
  if (!invite) {
    throw new Error(
      "The server's answer was not what we expected. Try again in a moment.",
    );
  }
  return invite;
}

/** The invites that can still be used. Only an owner or admin can read them, so it is asked only for one. */
export function useInvites(enabled: boolean) {
  return useQuery({
    queryKey: ["community-invites", relayHttpBaseUrl()],
    queryFn: async () =>
      parseInvites(await signedPost("/api/invites/list", {})),
    enabled,
    staleTime: 10_000,
    retry: 1,
    refetchOnWindowFocus: false,
  });
}

/** End an invite now. People who joined with it stay. */
export async function revokeInvite(id: string): Promise<void> {
  await signedPost("/api/invites/revoke", { id });
}

/** Remove a person from the community. The server refuses what the person asking may not do, in words. */
export async function removePerson(pubkey: string): Promise<void> {
  await publishAsUser(
    removeMemberRecord(pubkey),
    "The server did not remove them.",
  );
}

/** Make a member an admin, or an admin a member. The server refuses anyone but the owner, in words. */
export async function changeRole(
  pubkey: string,
  role: "admin" | "member",
): Promise<void> {
  await publishAsUser(
    changeRoleRecord(pubkey, role),
    "The server did not change their role.",
  );
}
