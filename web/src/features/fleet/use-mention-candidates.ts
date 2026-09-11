/**
 * Mention candidates for the composer: roster agents + people observed in
 * the channel (history authors resolved through kind-0 profiles).
 */

import { useEffect, useMemo, useState } from "react";

import { queryEvents, type NostrEvent } from "@/shared/lib/nostr-client";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { useAgentRoster } from "@/features/fleet/use-agent-roster";
import {
  useProfiles,
  profileDisplayName,
} from "@/features/profiles/use-profiles";
import { TIMELINE_CONTENT_KINDS } from "@/features/channels/use-channel-messages";
import { userPubkey } from "@/shared/lib/identity";
import { truncatePubkey } from "@/shared/lib/pubkey";

export interface MentionCandidate {
  pubkey: string;
  name: string;
  agent?: boolean;
  me?: boolean;
}

export function useMentionCandidates(
  channelId: string | null,
): MentionCandidate[] {
  const { agents } = useAgentRoster();

  /**
   * People who have spoken in this channel.
   *
   * This used to run inside a `useMemo` and assign the query result to a local
   * variable, so it was discarded and re-derivation never happened — the
   * mention list only ever offered roster agents, never a human teammate.
   */
  const [observed, setObserved] = useState<string[]>([]);
  useEffect(() => {
    if (!channelId) {
      setObserved([]);
      return;
    }
    let disposed = false;
    void queryEvents(relayWsUrl(), {
      kinds: TIMELINE_CONTENT_KINDS,
      "#h": [channelId],
      limit: 60,
    })
      .then((events: NostrEvent[]) => {
        if (disposed) return;
        setObserved([...new Set(events.map((e) => e.pubkey))]);
      })
      .catch((error: unknown) => {
        console.warn("[mentions] channel authors unavailable", error);
      });
    return () => {
      disposed = true;
    };
  }, [channelId]);

  const me = userPubkey();
  const { data: profiles } = useProfiles(observed.length ? observed : []);
  const profileByName = new Map(
    (profiles ?? []).map((p, i) => [observed[i], p] as const),
  );

  return useMemo(() => {
    const result: MentionCandidate[] = [];
    for (const agent of agents) {
      result.push({ pubkey: agent.pubkey, name: agent.name, agent: true });
    }
    for (const pubkey of observed) {
      if (pubkey === me) {
        result.push({ pubkey, name: "me", me: true });
        continue;
      }
      const profile = profileByName.get(pubkey);
      result.push({
        pubkey,
        name: profileDisplayName(profile, pubkey),
      });
    }
    return result;
  }, [agents, observed, profileByName, me]);
}

export function candidateName(candidate: MentionCandidate): string {
  if (candidate.me) return "me";
  return candidate.agent
    ? candidate.name
    : candidate.name || truncatePubkey(candidate.pubkey);
}
