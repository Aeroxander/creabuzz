/**
 * Payments that landed on the chain whose "work accepted" record is not on the server yet. Accept and pay is one press
 * but two writes: the money first, then the record that names its transaction. When the record fails (the server is
 * away, the signer is locked) the payment is remembered here, so the next press writes the record and never pays a
 * second time. Kept in this browser's storage, with this page's memory as the fallback; a payment is forgotten only once
 * its record is on the server.
 */

export interface PaidNotRecorded {
  task: string;
  handIn: string;
  txHash: string;
  at: number;
}

const STORAGE_KEY = "creaton.tasks.paid";
const MAX_REMEMBERED = 50;

let memory: Record<string, PaidNotRecorded> = {};

function isEntry(value: unknown): value is PaidNotRecorded {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.task === "string" &&
    typeof v.handIn === "string" &&
    typeof v.txHash === "string" &&
    /^0x[0-9a-fA-F]{64}$/.test(v.txHash) &&
    typeof v.at === "number"
  );
}

function readAll(): Record<string, PaidNotRecorded> {
  let stored: Record<string, PaidNotRecorded> = {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (parsed && typeof parsed === "object")
      stored = Object.fromEntries(
        Object.entries(parsed).filter(([, value]) => isEntry(value)),
      ) as Record<string, PaidNotRecorded>;
  } catch {
    stored = {};
  }
  return { ...stored, ...memory };
}

function writeAll(all: Record<string, PaidNotRecorded>) {
  const kept = Object.fromEntries(
    Object.entries(all)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, MAX_REMEMBERED),
  );
  memory = kept;
  try {
    if (Object.keys(kept).length === 0) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(kept));
  } catch {
    // Storage is off: this page still remembers the payment.
  }
}

/** The payment made for `task` whose record is still owed, or null. */
export function paidNotRecorded(task: string): PaidNotRecorded | null {
  return readAll()[task] ?? null;
}

export function rememberPaid(entry: PaidNotRecorded) {
  writeAll({ ...readAll(), [entry.task]: entry });
}

export function forgetPaid(task: string) {
  const all = readAll();
  if (!(task in all)) return;
  delete all[task];
  writeAll(all);
}

/** The transactions (lower case) kept for tasks other than `task`: a payment made for one task is never offered for another. */
export function paidElsewhere(task: string): string[] {
  return Object.values(readAll())
    .filter((entry) => entry.task !== task)
    .map((entry) => entry.txHash.toLowerCase());
}
