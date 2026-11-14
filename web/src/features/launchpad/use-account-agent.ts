import { useQuery } from "@tanstack/react-query";

import { existingUserPubkey } from "@/shared/lib/identity";
import { queryEvents } from "@/shared/lib/nostr-client";
import { relayWsUrl } from "@/shared/lib/relay-url";

import { type AgentMark, agentMark } from "./lib/agent-label";

/**
 * Whether an account is an agent, from its own profile record: the profile says so (`["agent", <its own key>]`) and
 * carries the signature of the person who runs it. The server keeps such an account to a helper's powers: it may
 * not confirm work, give more time, or sign goals and promises, even on a team. Null: not an agent. `owner` is the
 * person proven to run it, or null when the profile says "agent" without a proof this app can check.
 */
export function useAccountAgent(pubkey: string | null): {
  mark: AgentMark | null;
  /** The profile was read: until then nothing is said either way. */
  known: boolean;
} {
  const relay = relayWsUrl();
  const read = useQuery({
    queryKey: ["launchpad", "account-agent", relay, pubkey],
    enabled: pubkey !== null,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    queryFn: async (): Promise<AgentMark | null> => {
      const events = await queryEvents(relay, {
        kinds: [0],
        authors: [pubkey as string],
        limit: 5,
      });
      const newest = events
        .filter((event) => event.kind === 0 && event.pubkey === pubkey)
        .sort((a, b) => b.created_at - a.created_at)[0];
      return newest ? agentMark(newest, 0) : null;
    },
  });
  return { mark: read.data ?? null, known: read.data !== undefined };
}

/** Whether the signed-in account is an agent. False until its profile is read. */
export function useViewerIsAgent(): boolean {
  return useAccountAgent(existingUserPubkey()).mark !== null;
}

/** Said wherever a control is left out for an agent account. */
export const AGENT_NEEDS_PERSON =
  "This account is an agent. Confirming work, giving more time, and setting goals and promises need a person, so the server takes those only from one.";
