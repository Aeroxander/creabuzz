/**
 * The browser agent's chat-plane contract: which plane it POSTS on and which
 * planes it READS. Alias-free so `agent-planes.test.mjs` can drive it under
 * `node --test`.
 *
 * Two chat planes exist and both stay live: kind 9 (`KIND_STREAM_MESSAGE`) is
 * the agent-harness wire plane every producer speaks (buzz-acp, workflow,
 * feed), and kind 40002 (`KIND_STREAM_MESSAGE_V2`) is the v2 line with
 * edit/diff satellites. The agent posts on the live plane and reads both, so
 * history and v2 posts still render in its context.
 */
import {
  KIND_STREAM_MESSAGE,
  KIND_STREAM_MESSAGE_V2,
} from "../../../shared/constants/kinds.ts";

/** The one plane the agent posts its turns on. */
export const AGENT_POST_KIND = KIND_STREAM_MESSAGE;

/**
 * What the agent reads for channel context: plain kind-1 notes plus both chat
 * planes (kind 9 history, kind 40002 v2 posts).
 */
export const AGENT_CONTEXT_READ_KINDS = [
  1,
  KIND_STREAM_MESSAGE,
  KIND_STREAM_MESSAGE_V2,
] as const;

/**
 * The turn event the agent publishes: a kind-9 stream message with the caller's
 * channel/thread tags. This builder is the single source of the post kind.
 */
export function buildAgentTurnEvent(
  content: string,
  tags: string[][],
): { kind: number; tags: string[][]; content: string } {
  return { kind: AGENT_POST_KIND, tags, content };
}

/** The channel-context read filter: both chat planes plus kind-1 notes. */
export function agentContextFilter(
  channelId: string,
  limit = 25,
): {
  kinds: number[];
  "#h": string[];
  limit: number;
} {
  return {
    kinds: [...AGENT_CONTEXT_READ_KINDS],
    "#h": [channelId],
    limit,
  };
}
