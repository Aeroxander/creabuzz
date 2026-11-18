/**
 * The small field readers the launchpad model modules share: a tag's value,
 * the JSON body of an event, and the type-narrowing `str`/`int`/`strs`
 * helpers. Alias-free with `.ts` specifiers (only the type-only `NostrEvent`
 * import uses one), so the modules `node --test` drives can use them.
 */

import type { NostrEvent } from "@/shared/lib/nostr-client";
import { eventContentObject } from "../../../shared/lib/event-fields.ts";

/** The mirror's JSON body; malformed mirrors read as empty and are dropped by the caller. */
export function contentObject(event: NostrEvent): Record<string, unknown> {
  return eventContentObject(event) ?? {};
}

export function tagValue(event: NostrEvent, name: string): string | null {
  const tag = event.tags.find((t) => t[0] === name);
  return tag && tag.length >= 2 ? tag[1] : null;
}

export function tagValues(event: NostrEvent, name: string): string[] {
  return event.tags
    .filter((t) => t[0] === name && t.length >= 2)
    .map((t) => t[1]);
}

export function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function int(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : null;
}

export function strs(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}
