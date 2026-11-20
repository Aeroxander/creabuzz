/**
 * What this device remembers about its alerts: which account saved this device's subscription at the server and when, and the
 * removals the server has not yet confirmed. Kept in `localStorage`, every read and write inside `try` (a private window or
 * blocked storage gives "nothing remembered", and the card then offers to turn alerts on again). No module-level variable:
 * every call reads the store.
 */

const SAVED_KEY = "creaton.push.saved.v1";
const PENDING_KEY = "creaton.push.pending.v1";
/** The most removals kept to retry: a person turns alerts off and on a few times, never hundreds. */
const PENDING_MAX = 5;
/** A removal older than this is dropped: the server forgets a device itself after 90 days. */
const PENDING_DAYS = 90;

export interface SavedDevice {
  /** The account that saved this device at the server. */
  account: string;
  endpoint: string;
  /** When it was last saved (seconds): the server keeps a device for 90 days, so it is saved again after 30. */
  savedAt: number;
}

interface PendingRemoval {
  account: string;
  endpoint: string;
  at: number;
}

function load(key: string): unknown {
  try {
    const text = window.localStorage.getItem(key);
    return text === null ? null : JSON.parse(text);
  } catch {
    return null;
  }
}

function save(key: string, value: unknown): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage refused: nothing is remembered, and the card asks again next time.
  }
}

const isText = (v: unknown): v is string => typeof v === "string" && v !== "";

/** The account and address this device was saved with, or null. */
export function readSaved(): SavedDevice | null {
  const value = load(SAVED_KEY) as Partial<SavedDevice> | null;
  if (
    !value ||
    !isText(value.account) ||
    !isText(value.endpoint) ||
    typeof value.savedAt !== "number"
  )
    return null;
  return {
    account: value.account,
    endpoint: value.endpoint,
    savedAt: value.savedAt,
  };
}

export function writeSaved(device: SavedDevice | null): void {
  save(SAVED_KEY, device);
}

/** The removals still to be told to the server. */
export function readPending(now: number): PendingRemoval[] {
  const value = load(PENDING_KEY);
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (v): v is PendingRemoval =>
        !!v &&
        isText((v as PendingRemoval).account) &&
        isText((v as PendingRemoval).endpoint) &&
        typeof (v as PendingRemoval).at === "number" &&
        now - (v as PendingRemoval).at < PENDING_DAYS * 86_400,
    )
    .slice(-PENDING_MAX);
}

/** Remember that the server has not yet been told to forget this device. */
export function addPending(
  account: string,
  endpoint: string,
  now: number,
): void {
  const rest = readPending(now).filter(
    (p) => !(p.account === account && p.endpoint === endpoint),
  );
  save(
    PENDING_KEY,
    [...rest, { account, endpoint, at: now }].slice(-PENDING_MAX),
  );
}

/** The server has forgotten it. */
export function clearPending(
  account: string,
  endpoint: string,
  now: number,
): void {
  const rest = readPending(now).filter(
    (p) => !(p.account === account && p.endpoint === endpoint),
  );
  save(PENDING_KEY, rest.length === 0 ? null : rest);
}
