/**
 * Relay read for kind:37017 binding records.
 *
 * Bounded on purpose: one REQ per summon dialog, over the *team's* pubkeys
 * only (`authors`), an explicit kind, and a hard author cap — a project's
 * roster cannot turn into an unbounded scan of the relay (review rule:
 * bound every resource). `enabled` keeps the query silent for a project with
 * no team, and a failure surfaces as a warning in the dialog rather than as
 * "these seats are unbound": an unreachable lookup must never be read as
 * evidence that no binding exists.
 */
import { useQuery } from "@tanstack/react-query";

import { queryEvents } from "@/shared/lib/nostr-client";
import { relayWsUrl } from "@/shared/lib/relay-url";

import {
  KIND_EVM_BINDING,
  parseBindingRecord,
  type BindingRecord,
} from "./lib/bindings";

/** One team cannot exceed this many author probes per lookup. */
const MAX_BINDING_AUTHORS = 64;
const RECORDS_LIMIT = 200;

export const bindingRecordsQueryKey = ["projects", "binding-records"] as const;

/** Sorted, deduped, capped — the stable query key is built from this. */
function authorKey(pubkeys: readonly string[]): string {
  const valid = new Set<string>();
  for (const pubkey of pubkeys) {
    if (/^[0-9a-f]{64}$/i.test(pubkey)) valid.add(pubkey.toLowerCase());
  }
  return [...valid].sort().slice(0, MAX_BINDING_AUTHORS).join(",");
}

async function queryBindingAuthors(
  authors: readonly string[],
): Promise<BindingRecord[]> {
  if (authors.length === 0) return [];
  const events = await queryEvents(relayWsUrl(), {
    kinds: [KIND_EVM_BINDING],
    authors: [...authors],
    limit: RECORDS_LIMIT,
  });
  const out: BindingRecord[] = [];
  for (const event of events) {
    const record = parseBindingRecord(event);
    if (record) out.push(record);
  }
  return out;
}

export async function fetchBindingRecords(
  pubkeys: readonly string[],
): Promise<BindingRecord[]> {
  const key = authorKey(pubkeys);
  return queryBindingAuthors(key ? key.split(",") : []);
}

/**
 * Binding records for `pubkeys` (the summon dialog's team), newest-per-npub
 * resolution done later by the composer. While this loads — or after it
 * fails — the seat map falls back to whatever `localBindingMap` can prove
 * locally, so the unbound blocker still holds.
 */
export function useBindingRecords(pubkeys: readonly string[]) {
  // Keyed on content, not identity: `project.team` is a fresh array every
  // render, so an array-valued memo/key would refetch on each render.
  const authors = authorKey(pubkeys);
  return useQuery({
    queryKey: [...bindingRecordsQueryKey, authors],
    queryFn: () => queryBindingAuthors(authors ? authors.split(",") : []),
    enabled: authors.length > 0,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    retry: 1,
  });
}
