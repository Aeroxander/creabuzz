/**
 * Which news a person has read, and which projects they were last found to hold, kept on this device only (plan section
 * 6.5). A convenience, never a source of truth: it never reaches the server or another device (a second device shows the
 * news again, which is the safe side), every read and write is inside `try`, and a device that cannot keep it shows
 * everything as unseen, never hidden. While storage cannot be used, what was read in this visit is remembered for this visit.
 */
import { relayWsUrl } from "@creaton/core/client/relay-url.ts";
import { useMemo, useSyncExternalStore } from "react";

const PREFIX = "creaton-task-alerts-seen";

/** How long a read alert is kept when it is no longer derived, and the most ids kept. */
const KEEP_SECS = 60 * 86_400;
const MOST_IDS = 500;
/** The most projects remembered as held per account. */
const MOST_HELD = 40;

interface Stored {
  v: 1;
  /** Alert id -> when it was marked read (unix seconds). */
  seen: Record<string, number>;
  /** `${account}|${chainKey}` -> when the account was last found to hold the project. */
  held: Record<string, number>;
}

const EMPTY = (): Stored => ({ v: 1, seen: {}, held: {} });

/** What this visit remembers for a key whose storage cannot be used (reading or writing it failed). */
const memory = new Map<string, Stored>();
const listeners = new Set<() => void>();
let version = 0;

const keyOf = (relay: string, pubkey: string) => `${PREFIX}:${relay}:${pubkey}`;

const isTimes = (v: unknown): v is Record<string, number> =>
  typeof v === "object" &&
  v !== null &&
  !Array.isArray(v) &&
  Object.values(v).every((n) => typeof n === "number" && Number.isFinite(n));

function read(key: string): Stored {
  try {
    if (memory.has(key)) return memory.get(key) ?? EMPTY();
    const raw = localStorage.getItem(key);
    if (raw === null) return EMPTY();
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return EMPTY();
    const body = parsed as Record<string, unknown>;
    if (body.v !== 1 || !isTimes(body.seen)) return EMPTY();
    return { v: 1, seen: body.seen, held: isTimes(body.held) ? body.held : {} };
  } catch {
    return EMPTY();
  }
}

function write(key: string, value: Stored): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    memory.delete(key);
  } catch {
    // The page is correct with no storage: this visit still remembers it.
    memory.set(key, value);
  }
  version += 1;
  for (const listener of listeners) listener();
}

/** The ids this account has read on this device (each with when). */
export function readSeen(
  pubkey: string,
  relay: string = relayWsUrl(),
): Record<string, number> {
  return read(keyOf(relay, pubkey)).seen;
}

/**
 * Marks `ids` read at `now`. Pruning on every write keeps the ids still derived (`live`) and the ones read within 60 days, at
 * most 500 of them, newest first: a live alert is never dropped to make room.
 */
export function markSeen(
  pubkey: string,
  ids: readonly string[],
  live: ReadonlySet<string>,
  now: number,
  relay: string = relayWsUrl(),
): void {
  const key = keyOf(relay, pubkey);
  const stored = read(key);
  const seen = { ...stored.seen };
  for (const id of ids) seen[id] = now;
  const kept = Object.entries(seen)
    .filter(([id, at]) => live.has(id) || now - at <= KEEP_SECS)
    .sort(
      (a, b) => Number(live.has(b[0])) - Number(live.has(a[0])) || b[1] - a[1],
    )
    .slice(0, MOST_IDS);
  write(key, { ...stored, seen: Object.fromEntries(kept) });
}

/** Notes that `account` was found to hold the project `chainKey` (or no longer does, with `held` false). */
export function rememberHeld(
  pubkey: string,
  account: string,
  chainKey: string,
  held: boolean,
  now: number,
  relay: string = relayWsUrl(),
): void {
  const key = keyOf(relay, pubkey);
  const stored = read(key);
  const slot = `${account.toLowerCase()}|${chainKey}`;
  const before = stored.held[slot];
  // Nothing changes: not held and not remembered, or remembered within the hour (no write, no new render).
  if (
    held ? before !== undefined && now - before < 3_600 : before === undefined
  )
    return;
  const next = { ...stored.held };
  if (held) next[slot] = now;
  else delete next[slot];
  const kept = Object.entries(next)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MOST_HELD);
  write(key, { ...stored, held: Object.fromEntries(kept) });
}

/** The projects `account` was last found to hold, newest first. */
export function heldKeys(
  pubkey: string,
  account: string,
  relay: string = relayWsUrl(),
): string[] {
  const prefix = `${account.toLowerCase()}|`;
  return Object.entries(read(keyOf(relay, pubkey)).held)
    .filter(([slot]) => slot.startsWith(prefix))
    .sort((a, b) => b[1] - a[1])
    .map(([slot]) => slot.slice(prefix.length));
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key.startsWith(PREFIX)) {
      version += 1;
      listener();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/**
 * The ids this account has read, as of now; the component renders again when they change here or in another tab. Without
 * an account it is empty.
 */
export function useSeen(pubkey: string | null): Record<string, number> {
  const at = useSyncExternalStore(subscribe, () => version);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `at` says the stored ids changed.
  return useMemo(() => (pubkey ? readSeen(pubkey) : {}), [pubkey, at]);
}
