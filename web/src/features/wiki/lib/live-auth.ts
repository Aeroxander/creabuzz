/**
 * Authenticated live co-editing for the wiki (Trystero room `wiki:<slug>`).
 *
 * The room is a public rendezvous: with `BUZZ_P2P_SIGNALING` the relay carries
 * anonymous signalling events, so anyone who knows the relay and a slug can
 * join it. A Yjs update applied from such a peer lands in a page that this
 * member's autosave then publishes under THEIR signature. Nothing in the
 * transport says who wrote it, so every message carries its own proof.
 *
 * Envelope (JSON, one per Trystero message):
 *
 *   { v: 1,
 *     room: "wiki:<slug>",   // the room the update is for
 *     ts: <unix seconds>,    // signing time; also the signed event's created_at
 *     update: "<base64>",    // the Yjs update bytes (may be empty: a "hello")
 *     pk: "<64-hex>",        // signer's Nostr pubkey
 *     peer: "<peer id>",     // Trystero id of the SENDING peer
 *     sig: "<128-hex>" }     // BIP-340 signature, see below
 *
 * `sig` is the signature of a Nostr event that is never published:
 *
 *   kind        LIVE_SIGNED_KIND
 *   created_at  ts
 *   tags        []
 *   content     "buzz-wiki-live/1\nroom:<room>\nts:<ts>\npeer:<peer>\nsha256:<hex(update)>"
 *
 * so the signature covers the room, the time, the sending peer and the exact
 * update bytes. Binding the peer id stops a stranger from replaying a member's
 * envelope as its own (the receiver compares `peer` with the transport's own
 * sender id) — that is what makes "this peer has proved it is a member" a
 * statement about the peer and not about a captured message.
 *
 * A receiver applies an update only when ALL of these hold, cheapest first:
 * the sender is under its rate cap; the envelope is well formed, for this room
 * and this sender, within the size cap and at most MAX_ENVELOPE_AGE_SECS from
 * now; the signature verifies; and the signer is a community member
 * (`live-members.ts`). Anything else is dropped and counted. There is no replay
 * set: with the peer id signed, only the sending peer can resend its own
 * envelope, and re-applying a Yjs update is idempotent.
 *
 * Deliberately free of `@/` imports so `node --test` can exercise it.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { getEventHash, verifyEvent } from "nostr-tools/pure";

import type { MemberDirectory } from "./live-members.ts";

export const LIVE_ENVELOPE_VERSION = 1;

/**
 * Kind of the signed (never published) event that carries the signature. It
 * only domain-separates these signatures from every other use of the key, so
 * an envelope signature cannot be replayed as a relay event of a real kind.
 */
export const LIVE_SIGNED_KIND = 24451;

/** Largest Yjs update accepted or sent, in bytes. */
export const MAX_UPDATE_BYTES = 256 * 1024;
const MAX_UPDATE_CHARS = Math.ceil(MAX_UPDATE_BYTES / 3) * 4;

/** Envelopes further than this from now (either direction) are dropped. */
export const MAX_ENVELOPE_AGE_SECS = 300;

/** Per-peer message cap: at most this many messages per window. */
export const RATE_LIMIT_MAX_MESSAGES = 120;
export const RATE_LIMIT_WINDOW_MS = 10_000;

const MAX_TRACKED_PEERS = 256;

const HEX_PUBKEY = /^[0-9a-f]{64}$/;
const HEX_SIG = /^[0-9a-f]{128}$/;
const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export interface LiveEnvelope {
  v: 1;
  room: string;
  ts: number;
  update: string;
  pk: string;
  peer: string;
  sig: string;
}

export function liveRoomId(slug: string): string {
  return `wiki:${slug}`;
}

// ── base64 ─────────────────────────────────────────────────────────────────

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array | null {
  if (!BASE64.test(value)) return null;
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

// ── canonical signed string ────────────────────────────────────────────────

/** The exact string a signer signs (as event content) for one message. */
export function canonicalContent(input: {
  room: string;
  ts: number;
  peer: string;
  update: Uint8Array;
}): string {
  return [
    `buzz-wiki-live/${LIVE_ENVELOPE_VERSION}`,
    `room:${input.room}`,
    `ts:${input.ts}`,
    `peer:${input.peer}`,
    `sha256:${bytesToHex(sha256(input.update))}`,
  ].join("\n");
}

// ── signing ────────────────────────────────────────────────────────────────

/** What a signer receives: an unsigned Nostr event template. */
export interface LiveSignTemplate {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

/** What a signer returns: the template, signed (a `SignedNostrEvent`). */
export interface LiveSignedEvent extends LiveSignTemplate {
  pubkey: string;
  sig: string;
}

export type LiveSigner = (
  template: LiveSignTemplate,
) => Promise<LiveSignedEvent>;

export class LiveSignError extends Error {
  readonly reason: "too-large" | "signer-altered-event";

  constructor(reason: "too-large" | "signer-altered-event", message: string) {
    super(message);
    this.name = "LiveSignError";
    this.reason = reason;
  }
}

/**
 * Sign one outgoing update. The signer is the app's identity signer
 * (`signAsUser`): a stored key, a passkey, or a NIP-07 extension.
 *
 * The result is verified before it is returned, so a signer that rewrote the
 * event (some extensions normalise `created_at` or tags) fails here, loudly,
 * instead of producing an envelope every receiver would drop.
 */
export async function signEnvelope(input: {
  room: string;
  peer: string;
  update: Uint8Array;
  sign: LiveSigner;
  nowSecs: number;
}): Promise<LiveEnvelope> {
  if (input.update.length > MAX_UPDATE_BYTES) {
    throw new LiveSignError(
      "too-large",
      `update is ${input.update.length} bytes; the live-edit limit is ${MAX_UPDATE_BYTES}`,
    );
  }
  const template: LiveSignTemplate = {
    kind: LIVE_SIGNED_KIND,
    created_at: input.nowSecs,
    tags: [],
    content: canonicalContent({
      room: input.room,
      ts: input.nowSecs,
      peer: input.peer,
      update: input.update,
    }),
  };
  const signed = await input.sign(template);
  const envelope: LiveEnvelope = {
    v: LIVE_ENVELOPE_VERSION,
    room: input.room,
    ts: signed.created_at,
    update: bytesToBase64(input.update),
    pk: signed.pubkey,
    peer: input.peer,
    sig: signed.sig,
  };
  if (!signatureHolds(envelope, input.update)) {
    throw new LiveSignError(
      "signer-altered-event",
      "the signer returned an event other than the one it was asked to sign",
    );
  }
  return envelope;
}

// ── verification ───────────────────────────────────────────────────────────

function signatureHolds(envelope: LiveEnvelope, update: Uint8Array): boolean {
  const unsigned = {
    kind: LIVE_SIGNED_KIND,
    created_at: envelope.ts,
    tags: [] as string[][],
    content: canonicalContent({
      room: envelope.room,
      ts: envelope.ts,
      peer: envelope.peer,
      update,
    }),
    pubkey: envelope.pk,
  };
  try {
    return verifyEvent({
      ...unsigned,
      id: getEventHash(unsigned),
      sig: envelope.sig,
    });
  } catch {
    return false;
  }
}

export type EnvelopeRejection =
  | "unsigned"
  | "malformed"
  | "oversized"
  | "wrong-room"
  | "wrong-peer"
  | "stale"
  | "bad-signature";

/** Structural parse only — no crypto. Anything that is not an envelope is null. */
export function parseEnvelope(
  data: unknown,
): { envelope: LiveEnvelope } | { rejection: EnvelopeRejection } {
  // Binary payloads are the pre-authentication wire format: unsigned by
  // construction.
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return { rejection: "unsigned" };
  }
  if (ArrayBuffer.isView(data) || data instanceof ArrayBuffer) {
    return { rejection: "unsigned" };
  }
  const record = data as Record<string, unknown>;
  if (typeof record.sig !== "string" || typeof record.pk !== "string") {
    return { rejection: "unsigned" };
  }
  if (
    typeof record.update === "string" &&
    record.update.length > MAX_UPDATE_CHARS
  ) {
    return { rejection: "oversized" };
  }
  if (
    record.v !== LIVE_ENVELOPE_VERSION ||
    typeof record.room !== "string" ||
    record.room.length === 0 ||
    record.room.length > 300 ||
    typeof record.ts !== "number" ||
    !Number.isSafeInteger(record.ts) ||
    typeof record.update !== "string" ||
    typeof record.peer !== "string" ||
    record.peer.length === 0 ||
    record.peer.length > 128 ||
    !HEX_PUBKEY.test(record.pk) ||
    !HEX_SIG.test(record.sig)
  ) {
    return { rejection: "malformed" };
  }
  return {
    envelope: {
      v: LIVE_ENVELOPE_VERSION,
      room: record.room,
      ts: record.ts,
      update: record.update,
      pk: record.pk,
      peer: record.peer,
      sig: record.sig,
    },
  };
}

export type VerifyResult =
  | { ok: true; envelope: LiveEnvelope; update: Uint8Array }
  | { ok: false; reason: EnvelopeRejection };

/**
 * Everything that can be decided without the member list: shape, room, sender,
 * age, size and signature. `peerId` is the transport's id for the sender (not
 * anything the message claims).
 */
export function verifyEnvelope(
  data: unknown,
  context: { room: string; peerId: string; nowSecs: number },
): VerifyResult {
  const parsed = parseEnvelope(data);
  if ("rejection" in parsed) return { ok: false, reason: parsed.rejection };
  const { envelope } = parsed;
  if (envelope.room !== context.room)
    return { ok: false, reason: "wrong-room" };
  if (envelope.peer !== context.peerId) {
    return { ok: false, reason: "wrong-peer" };
  }
  if (Math.abs(context.nowSecs - envelope.ts) > MAX_ENVELOPE_AGE_SECS) {
    return { ok: false, reason: "stale" };
  }
  const update = base64ToBytes(envelope.update);
  if (!update) return { ok: false, reason: "malformed" };
  if (update.length > MAX_UPDATE_BYTES)
    return { ok: false, reason: "oversized" };
  if (!signatureHolds(envelope, update)) {
    return { ok: false, reason: "bad-signature" };
  }
  return { ok: true, envelope, update };
}

// ── receiver state: rate cap, replay set, membership ───────────────────────

/** Sliding-window message counter per peer; bounded in the peers it tracks. */
export class PeerRateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly maxMessages: number;
  private readonly windowMs: number;

  constructor(
    maxMessages = RATE_LIMIT_MAX_MESSAGES,
    windowMs = RATE_LIMIT_WINDOW_MS,
  ) {
    this.maxMessages = maxMessages;
    this.windowMs = windowMs;
  }

  /** Record one message from `peerId`; false when it is over the cap. */
  allow(peerId: string, nowMs: number): boolean {
    const recent = (this.hits.get(peerId) ?? []).filter(
      (at) => nowMs - at < this.windowMs,
    );
    // Re-insert so the least recently active peer is the first key.
    this.hits.delete(peerId);
    if (recent.length >= this.maxMessages) {
      this.hits.set(peerId, recent);
      this.evict();
      return false;
    }
    recent.push(nowMs);
    this.hits.set(peerId, recent);
    this.evict();
    return true;
  }

  private evict(): void {
    while (this.hits.size > MAX_TRACKED_PEERS) {
      const oldest = this.hits.keys().next().value;
      if (oldest === undefined) return;
      this.hits.delete(oldest);
    }
  }
}

export type AcceptRejection =
  | EnvelopeRejection
  | "rate-limited"
  | "not-member"
  | "membership-unknown";

export type AcceptResult =
  | { ok: true; update: Uint8Array; signer: string; envelope: LiveEnvelope }
  | { ok: false; reason: AcceptRejection };

export interface LiveReceiver {
  accept(data: unknown, peerId: string): Promise<AcceptResult>;
}

/**
 * The production accept path for one room. `accept` resolves to the update to
 * apply, or the reason it must not be applied.
 */
export function createLiveReceiver(options: {
  room: string;
  members: MemberDirectory;
  nowMs?: () => number;
}): LiveReceiver {
  const now = options.nowMs ?? (() => Date.now());
  const limiter = new PeerRateLimiter();

  return {
    async accept(data, peerId) {
      const nowMs = now();
      // Cheapest check first: a flood costs the sender a counter increment,
      // not a signature verification.
      if (!limiter.allow(peerId, nowMs)) {
        return { ok: false, reason: "rate-limited" };
      }
      const verified = verifyEnvelope(data, {
        room: options.room,
        peerId,
        nowSecs: Math.floor(nowMs / 1000),
      });
      if (!verified.ok) return verified;

      const verdict = await options.members.check(verified.envelope.pk);
      if (verdict === "not-member") return { ok: false, reason: "not-member" };
      if (verdict === "unknown") {
        return { ok: false, reason: "membership-unknown" };
      }

      return {
        ok: true,
        update: verified.update,
        signer: verified.envelope.pk,
        envelope: verified.envelope,
      };
    },
  };
}
