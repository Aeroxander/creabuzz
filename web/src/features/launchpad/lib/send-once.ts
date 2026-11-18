/**
 * Sending one signed record so that a lost answer never makes a second one.
 *
 * A record is signed once and kept before it is sent, under a name made from what is being done AND the exact words
 * it was signed from. If the server's answer is lost, the next try with the same words finds it and first asks the
 * server whether it arrived:
 * - it did: that record is the result, and nothing new is signed (`adopted`);
 * - it did not, and the try is recent: the very same record is sent again, so even if the first copy turns up late
 *   the server holds one record, not two;
 * - it did not, and the try is more than an hour old: it is dropped and the words are signed afresh.
 *
 * Different words are a different thing to send. They never find, adopt or replace what was kept for other words: a
 * second task, or a second piece of work, is never swallowed by an earlier one, and a changed draft is never thrown
 * away in favour of what was typed before.
 *
 * What is kept is given by the caller (the browser's storage, keyed by server and account), so nothing here lives in
 * a module or a component and a reload or a change of community loses nothing.
 *
 * Pure and alias-free: `send-once.test.mjs` drives it under `node --test`.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

export interface SendTemplate {
  kind: number;
  tags: string[][];
  content: string;
}

interface Signed {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

interface Kept<E> {
  /** What the record was signed from, to tell an unchanged retry from changed words. */
  print: string;
  event: E;
  at: number;
}

export interface SendStore {
  get: (key: string) => string | null;
  set: (key: string, value: string) => void;
  remove: (key: string) => void;
}

/** What identifies a template: its kind, tags and words. */
export function templatePrint(template: SendTemplate): string {
  return JSON.stringify([template.kind, template.tags, template.content]);
}

function readKept<E extends Signed>(
  store: SendStore,
  key: string,
): Kept<E> | null {
  let raw: string | null = null;
  try {
    raw = store.get(key);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const kept = JSON.parse(raw) as Partial<Kept<E>>;
    const event = kept.event;
    if (
      typeof kept.print === "string" &&
      event &&
      typeof event.id === "string" &&
      /^[0-9a-f]{64}$/.test(event.id) &&
      typeof event.sig === "string" &&
      typeof event.pubkey === "string" &&
      Array.isArray(event.tags)
    )
      return { print: kept.print, event, at: Number(kept.at) || 0 };
  } catch {
    // Unreadable: as if nothing was kept.
  }
  return null;
}

/** How long a kept record that never arrived is sent again as it is. After this the words are signed afresh. */
export const KEPT_FOR_MS = 60 * 60 * 1000;

export interface SendOnceResult<E> {
  event: E;
  /** An earlier try with these same words had already arrived, so its record stands and nothing new was sent. */
  adopted: boolean;
}

/** The name a record is kept under: what is being done, and a fingerprint of the words. */
export function keptKey(action: string, template: SendTemplate): string {
  const print = bytesToHex(
    sha256(new TextEncoder().encode(templatePrint(template))),
  ).slice(0, 24);
  return `${action}:${print}`;
}

/**
 * Send the record `template` describes, once. `key` names the thing being done (make a task from one offer, confirm
 * one piece of evidence). `signer` is the account that signs: a record kept by another account is never sent or
 * adopted.
 */
export async function sendOnce<E extends Signed>(input: {
  key: string;
  signer: string;
  template: SendTemplate;
  store: SendStore;
  sign: (template: SendTemplate) => Promise<E>;
  /** Sends a signed record. Throws, or answers not accepted, when it did not go through. */
  publish: (event: E) => Promise<{ accepted: boolean; message?: string }>;
  /** Whether the server holds a record with this id. Throws when it cannot be asked. */
  exists: (id: string) => Promise<boolean>;
  now?: () => number;
}): Promise<SendOnceResult<E>> {
  const { signer, template, store, sign, publish, exists } = input;
  const print = templatePrint(template);
  const key = keptKey(input.key, template);
  const clock = input.now ?? Date.now;
  let event: E | null = null;
  const kept = readKept<E>(store, key);
  if (kept && kept.event.pubkey === signer && kept.print === print) {
    // The earlier try may have arrived although its answer did not. However old it is, the server is asked before
    // anything else: if it cannot be asked, nothing is sent, because sending blind is how a second record is made.
    if (await exists(kept.event.id)) {
      store.remove(key);
      return { event: kept.event, adopted: true };
    }
    // It never arrived. A recent one goes again as it is; an old one is a try long given up.
    if (clock() - kept.at <= KEPT_FOR_MS) event = kept.event;
  }
  if (!event) {
    event = await sign(template);
    // Kept before it is sent: from here on a lost answer can be told from a record that never left.
    store.set(key, JSON.stringify({ print, event, at: clock() }));
  }
  const result = await publish(event);
  if (!result.accepted) {
    // A refusal is an answer: the record did not arrive, so the next try signs afresh.
    store.remove(key);
    throw new Error(result.message ?? "The server did not take the record.");
  }
  store.remove(key);
  return { event, adopted: false };
}
