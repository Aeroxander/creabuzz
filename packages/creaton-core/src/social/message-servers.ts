/**
 * The person's list of message servers (kind 10050, NIP-17): the servers other apps send their private messages to. It is
 * public, replaces itself on every write, and may list servers this app knows nothing about (put there from another app), so
 * a change keeps every tag it does not own: turning this server on or off touches only its own `relay` tag.
 *
 * Pure and alias-free: `message-servers.test.mjs` drives it under `node --test`.
 */

import { KIND_DM_RELAY_LIST } from "../kinds.ts";
import type { EventTemplate } from "./feed/feed-events.ts";

const same = (a: string, b: string) =>
  a.trim().replace(/\/+$/, "").toLowerCase() ===
  b.trim().replace(/\/+$/, "").toLowerCase();

const isRelayTag = (tag: readonly string[]) =>
  tag[0] === "relay" && typeof tag[1] === "string";

/** Whether the list names `community` as a server to send this person's messages to. */
export function listsServer(
  list: { tags: readonly string[][] } | null,
  community: string,
): boolean {
  return (list?.tags ?? []).some((t) => isRelayTag(t) && same(t[1], community));
}

/**
 * The list with `community` on it (`on`) or off it, from the person's newest list (null when there is none): every other
 * tag stays exactly as it was, in order, and a server already on the list is not added twice.
 */
export function messageServersChange(
  latest: { tags: readonly string[][]; content?: string } | null,
  community: string,
  on: boolean,
): EventTemplate {
  const kept = (latest?.tags ?? []).filter(
    (t) => !(isRelayTag(t) && same(t[1], community)),
  );
  return {
    kind: KIND_DM_RELAY_LIST,
    tags: on
      ? [...kept, ["relay", community.trim().replace(/\/+$/, "")]]
      : kept,
    content: latest?.content ?? "",
  };
}
