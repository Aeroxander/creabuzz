/**
 * Mention candidates for the composer: roster agents + people observed in
 * the channel (history authors resolved through kind-0 profiles).
 */

import { useMemo } from "react";

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

  const observed = useMemo(() => {
    let pubkeys: string[] = [];
    void queryEvents(relayWsUrl(), {
      kinds: TIMELINE_CONTENT_KINDS,
      "#h": [channelId ?? ""],
      limit: 60,
    })
      .then((events: NostrEvent[]) => {
        pubkeys = [...new Set(events.map((e) => e.pubkey))];
      })
      .catch(() => {});
    return pubkeys;
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
