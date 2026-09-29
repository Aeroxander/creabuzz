/**
 * EVM binding records — kind:37017, the relay-side read that lets a team seat
 * resolve without its holder being logged into *this* browser.
 *
 * Why it exists: `summon-composer.ts` `localBindingMap` could only read the
 * viewer's own SIWE binding (`features/identity/lib/siwe.ts`), so every other
 * seat resolved to "unbound" and blocked the summon. The record contract the
 * relay now publishes (kind:37017) closes that hole:
 *
 * - **kind** 37017, **`d`** = the bound address as lowercase `0x…`
 *   (NIP-33 coordinate — one address, one thread, newest record wins);
 * - **authored by the bound npub** — the signature *is* the claim, which is
 *   why `authors` is the query's bound (`use-bindings.ts`);
 * - **tags** `["address", "0x…"]`, optional `["chain", id]`;
 * - **content** `{ v, address, siweMessageHash, attestation, revoked? }`.
 *
 * What this module guarantees (each rule has a test in
 * `bindings.test.mjs`):
 *
 * - A record parses only when its address is a real `0x…40` and the `d` tag
 *   (when present) says the same thing — a mismatched coordinate or a
 *   content/tag address conflict is refused rather than guessed.
 * - `revoked: true` is carried, never dropped: a revocation supersedes the
 *   whole thread for that pubkey (`canonicalBindingByPubkey` resolves the
 *   newest record first, so an older live record cannot resurface behind a
 *   newer revocation).
 * - One canonical record per pubkey, newest `created_at` first with the
 *   NIP-ORG tie rule (lowest event id) — the same resolution
 *   `lib/state.ts` uses for requests and grants.
 */
// Relative import, because the node:test runner imports this module directly
// and cannot resolve Vite's `@/` alias.
import { KIND_EVM_BINDING } from "../../../shared/constants/kinds.ts";

// Structural input, as `lib/manifest.ts` `parsePitch` does: the node:test
// runner imports this module directly, so it stays free of Vite-only aliases.
export interface BindingEvent {
  id?: string;
  kind: number;
  pubkey: string;
  created_at: number;
  tags: string[][];
  content: string;
}

/**
 * The binding kind is the shared registry constant (`crates/buzz-core`
 * `KIND_EVM_BINDING`), re-exported so this module's callers keep one import.
 */
export { KIND_EVM_BINDING };

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** One parsed kind:37017 binding. */
export interface BindingRecord {
  eventId: string;
  /** The bound npub — the record's author. */
  pubkey: string;
  /** Lowercased `0x…` — the address the seat would be minted to. */
  address: string;
  /** The `chain` tag, when the binding is chain-scoped. */
  chain: string | null;
  /** `content.revoked === true` — the binding was withdrawn. */
  revoked: boolean;
  createdAt: number;
}

function contentObject(event: BindingEvent): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(event.content);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Malformed content is a null parse, not a crash (org-money.ts:49).
  }
  return null;
}

function tagValue(event: BindingEvent, name: string): string | null {
  const tag = event.tags.find((t) => t[0] === name);
  return tag && tag.length >= 2 && tag[1] ? tag[1] : null;
}

/**
 * Parse one kind:37017 binding, or null when the record cannot be trusted
 * (wrong kind, unusable address, or the `d` coordinate / content address
 * contradicting the `address` tag).
 *
 * A null return is a *counted* refusal on the consumer side, never a silent
 * success: the seat stays an explicit unbound blocker.
 */
export function parseBindingRecord(event: BindingEvent): BindingRecord | null {
  if (event.kind !== KIND_EVM_BINDING) return null;
  const body = contentObject(event);
  if (!body) return null;

  const tagged = tagValue(event, "address");
  const inContent =
    typeof body.address === "string" && body.address ? body.address : null;
  const raw = tagged ?? inContent;
  if (!raw || !ADDRESS_RE.test(raw)) return null;
  const address = raw.toLowerCase();
  // A tag and a content field naming two different addresses means the record
  // is self-contradictory — refuse it instead of picking a side.
  if (inContent && inContent.toLowerCase() !== address) return null;
  const d = tagValue(event, "d");
  if (d && d.toLowerCase() !== address) return null;

  const chain = tagValue(event, "chain");
  return {
    eventId: event.id ?? "",
    pubkey: event.pubkey,
    address,
    chain: chain && chain.length > 0 ? chain : null,
    revoked: body.revoked === true,
    createdAt: event.created_at,
  };
}

function isNewer(a: BindingRecord, b: BindingRecord): boolean {
  if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt;
  // NIP-ORG tie rule: lowest event id wins (lib/state.ts:104).
  return a.eventId < b.eventId;
}

/**
 * The newest record per pubkey — including revoked ones, so a revocation
 * keeps the thread closed rather than exposing an older live binding.
 */
export function canonicalBindingByPubkey(
  records: readonly BindingRecord[],
): Map<string, BindingRecord> {
  const newest = new Map<string, BindingRecord>();
  for (const record of records) {
    const current = newest.get(record.pubkey);
    if (!current || isNewer(record, current)) newest.set(record.pubkey, record);
  }
  return newest;
}
