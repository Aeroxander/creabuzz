/**
 * Transport-pluggable live-sync core for a wiki page's Yjs document.
 *
 * The document layer never knows how bytes travel: it hands coalesced Yjs
 * updates to a `WikiSyncTransport` and applies whatever that transport hands
 * back. Today the transport is the community relay (short-lived kind:20003
 * events scoped to the page); a native/Iroh transport can slot in later without
 * touching this file. That is the whole point of the seam.
 *
 * Convergence protocol (y-webrtc-style): local edits are coalesced and
 * published (bounded rate and size); every received update that advanced our
 * document triggers a throttled echo of our full state so a late joiner
 * converges. Applying an update we already had advances nothing, so we do not
 * echo — that is what stops two converged peers from trading state forever.
 *
 * Deliberately free of `@/` imports so `node --test` can exercise it.
 */

import * as Y from "yjs";

import { applyPeerUpdate } from "./sync-loop.ts";

/** How bytes leave and enter this document. One page = one transport. */
export interface WikiSyncTransport {
  /** Publish one coalesced Yjs update to everyone else on the page. */
  publish(update: Uint8Array): void;
  /** Tear the transport down. */
  close(): void;
}

export interface WikiDocSyncOptions {
  /** Minimum gap between outbound publishes (coalesce window), in ms. */
  throttleMs?: number;
  /** Bound on one published batch; a larger merged batch is split. */
  maxBatchBytes?: number;
  /** Delay before a throttled full-state echo, in ms. */
  echoMs?: number;
  /** Reported when the local text changed because a remote update landed. */
  onRemoteChange?: () => void;
  /** Called when a received update advanced the doc (used to track peers). */
  onPeerUpdate?: (author: string) => void;
}

const DEFAULT_THROTTLE_MS = 150;
const DEFAULT_MAX_BATCH_BYTES = 32 * 1024;
const DEFAULT_ECHO_MS = 500;

/**
 * Wires one Yjs document to one transport. Create it, call `start()`, feed
 * inbound updates via `handleRemoteUpdate`, and call `stop()` on teardown.
 */
export class WikiDocSync {
  private readonly doc: Y.Doc;
  private readonly transport: WikiSyncTransport;
  private readonly throttleMs: number;
  private readonly maxBatchBytes: number;
  private readonly echoMs: number;
  private readonly onRemoteChange?: () => void;
  private readonly onPeerUpdate?: (author: string) => void;

  private pending: Uint8Array[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private echoTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  /** Authors we have already answered, so a newcomer is answered only once. */
  private readonly seenAuthors = new Set<string>();
  /** Origin marker so our own echo is not re-broadcast as a local edit. */
  private static readonly REMOTE = "remote";

  constructor(
    doc: Y.Doc,
    transport: WikiSyncTransport,
    options: WikiDocSyncOptions = {},
  ) {
    this.doc = doc;
    this.transport = transport;
    this.throttleMs = options.throttleMs ?? DEFAULT_THROTTLE_MS;
    this.maxBatchBytes = options.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES;
    this.echoMs = options.echoMs ?? DEFAULT_ECHO_MS;
    this.onRemoteChange = options.onRemoteChange;
    this.onPeerUpdate = options.onPeerUpdate;
    this.onDocUpdate = this.onDocUpdate.bind(this);
  }

  /** Begin publishing local edits and echo responses. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.doc.on("update", this.onDocUpdate);
  }

  /** Stop publishing and release timers + the transport. */
  stop(): void {
    this.running = false;
    this.doc.off("update", this.onDocUpdate);
    if (this.flushTimer != null) clearTimeout(this.flushTimer);
    if (this.echoTimer != null) clearTimeout(this.echoTimer);
    this.flushTimer = null;
    this.echoTimer = null;
    this.pending = [];
    this.transport.close();
  }

  /**
   * Apply a remote peer's update. Returns true when it advanced our document
   * (caller may use that to echo / count the peer). An update we already had
   * returns false and schedules no echo.
   */
  handleRemoteUpdate(author: string, update: Uint8Array): boolean {
    const advanced = applyPeerUpdate(this.doc, update);
    const isNew = !this.seenAuthors.has(author);
    this.seenAuthors.add(author);
    if (advanced) {
      this.onPeerUpdate?.(author);
      this.onRemoteChange?.();
      this.scheduleEcho();
      return true;
    }
    // A peer we have not answered before is announcing itself. Its state taught
    // us nothing (we are ahead), so without a nudge it would never converge on
    // what it missed — send ours once. This is the "late joiner converges" path.
    if (isNew) this.scheduleEcho();
    return false;
  }

  private onDocUpdate(update: Uint8Array, origin: unknown): void {
    if (origin === WikiDocSync.REMOTE) return;
    this.pending.push(update);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer != null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, this.throttleMs);
  }

  /** Publish every coalesced update, split into bounded batches. */
  private flush(): void {
    if (!this.running) return;
    const merged = Y.mergeUpdates(this.pending);
    this.pending = [];
    for (const batch of splitBounded(merged, this.maxBatchBytes)) {
      this.transport.publish(batch);
    }
  }

  /** Throttled full-state echo so a mid-edit joiner converges on what we have. */
  private scheduleEcho(): void {
    if (this.echoTimer != null) return;
    this.echoTimer = setTimeout(
      () => {
        this.echoTimer = null;
        if (!this.running) return;
        this.transport.publish(Y.encodeStateAsUpdate(this.doc));
      },
      Math.max(this.throttleMs, this.echoMs),
    );
  }
}

/**
 * Split a merged Yjs update into roughly `maxBytes` chunks. Yjs updates are not
 * byte-splittable, so when a single coalesced blob exceeds the bound we send it
 * whole rather than corrupt it — the bound is a coalescing target, not a hard
 * partition. Returns `[merged]` in the common (bounded) case.
 */
function splitBounded(merged: Uint8Array, maxBytes: number): Uint8Array[] {
  if (merged.length <= maxBytes) return [merged];
  return [merged];
}

// ── relay event envelope (pure, transport-agnostic) ─────────────────────────
//
// The relay carries each Yjs update as a kind:20003 event whose `content` is
// base64 of the raw bytes and whose `d` tag names the page. These helpers
// encode/decode that shape and decide whether an inbound event belongs to a
// given page — kept here (not in the React file) so the seam is testable.

/** base64-encode raw Yjs bytes for an event's `content`. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** Decode an event's base64 `content` back to raw bytes; null when invalid. */
export function fromBase64(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export interface WikiEventLike {
  kind: number;
  tags: readonly (readonly string[])[];
  content: string;
}

/**
 * The raw Yjs update carried by an inbound live-sync event for `slug`, or null
 * when the event is for a different page, a different kind, or not decodable.
 * This is the one place that decides which live bytes reach a page's document.
 */
export function wikiSyncUpdateFromEvent(
  event: WikiEventLike,
  slug: string,
  kind: number,
): Uint8Array | null {
  if (event.kind !== kind) return null;
  const page = event.tags.find((tag) => tag[0] === "d")?.[1];
  if (page !== slug) return null;
  return fromBase64(event.content);
}
