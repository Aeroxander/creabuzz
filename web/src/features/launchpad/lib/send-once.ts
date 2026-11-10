/**
 * Sending one signed record so that a lost answer never makes a second one.
 *
 * A record is signed once and kept (with what it was signed from) before it is sent. If the server's answer is lost,
 * the next try for the same thing first asks the server whether the kept record arrived:
 * - it did: that record is the result, and nothing new is signed (`adopted`);
 * - it did not, and the person changed nothing: the very same record is sent again, so even if the first copy turns up
 *   late the server holds one record, not two;
 * - it did not, and the words changed: the kept record is dropped and the new words are signed.
 *
 * A kept record counts for an hour. After that it is a try long given up, and the next send starts afresh.
 *
 * What is kept is given by the caller (the browser's storage, keyed by server and account), so nothing here lives in
 * a module or a component and a reload or a change of community loses nothing.
 *
 * Pure and alias-free: `send-once.test.mjs` drives it under `node --test`.
 */

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

/** How long a kept record counts as "the try just made": after this a retry starts afresh. */
export const KEPT_FOR_MS = 60 * 60 * 1000;

export interface SendOnceResult<E> {
  event: E;
  /** An earlier try had already arrived, so its record stands and nothing new was sent. */
  adopted: boolean;
  /** That earlier record was signed from different words than the ones given now. */
  changed: boolean;
}

/**
 * Send the record `template` describes, once. `key` names the thing being done (one task from one offer, one
 * confirmation of one piece of evidence), so a retry finds what the earlier try kept. `signer` is the account that
 * signs: a record kept by another account is never sent or adopted.
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
  const { key, signer, template, store, sign, publish, exists } = input;
  const print = templatePrint(template);
  let event: E | null = null;
  const kept = readKept<E>(store, key);
  const clock = input.now ?? Date.now;
  // An old kept record is a try long given up: it is dropped, so it can never stand in for a new one.
  if (kept && clock() - kept.at > KEPT_FOR_MS) store.remove(key);
  else if (kept && kept.event.pubkey === signer) {
    // The earlier try may have arrived although its answer did not. If the server cannot be asked, nothing is sent:
    // sending blind is how a second record gets made.
    if (await exists(kept.event.id)) {
      store.remove(key);
      return {
        event: kept.event,
        adopted: true,
        changed: kept.print !== print,
      };
    }
    if (kept.print === print) event = kept.event;
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
  return { event, adopted: false, changed: false };
}
