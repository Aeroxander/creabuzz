/**
 * Money steps whose call went out but whose outcome is not known yet, kept per action ("back round 2 of this project")
 * so that pressing again looks the call up instead of sending a second one. Kept in this browser's storage, so closing
 * the sheet or reloading the page does not forget it; storage that cannot be used only loses that memory, never a step.
 */

/** A sent call still to be looked up: the `index`th of `total` calls, on chain `chainId`. */
export interface PendingSend {
  hash: string;
  index: number;
  total: number;
  chainId: number;
  at: number;
}

const STORAGE_KEY = "creaton.money.pending";

/** At most this many steps are remembered; the oldest go first. */
const MAX_REMEMBERED = 50;

/** The same steps for this page, for when storage cannot be used. */
let memory: Record<string, PendingSend> = {};

function isPending(value: unknown): value is PendingSend {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.hash === "string" &&
    /^0x[0-9a-fA-F]{1,64}$/.test(v.hash) &&
    Number.isSafeInteger(v.index) &&
    Number.isSafeInteger(v.total) &&
    Number.isSafeInteger(v.chainId) &&
    typeof v.at === "number"
  );
}

function readStored(): Record<string, PendingSend> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, PendingSend> = {};
    for (const [key, value] of Object.entries(parsed))
      if (isPending(value)) out[key] = value;
    return out;
  } catch {
    return {};
  }
}

function readAll(): Record<string, PendingSend> {
  return { ...readStored(), ...memory };
}

function writeAll(all: Record<string, PendingSend>) {
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
    // Storage is off (a private window, blocked site data): this page still remembers the step.
  }
}

/** The step waiting under `action`, or null. */
export function pendingSend(action: string): PendingSend | null {
  return readAll()[action] ?? null;
}

export function rememberPending(action: string, pending: PendingSend) {
  writeAll({ ...readAll(), [action]: pending });
}

export function forgetPending(action: string) {
  const all = readAll();
  if (!(action in all)) return;
  delete all[action];
  writeAll(all);
}
