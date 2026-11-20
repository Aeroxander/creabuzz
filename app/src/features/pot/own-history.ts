/**
 * What this account itself did on a project, kept in this browser: each Back and each Take out that landed. It is the
 * account's own record of its own steps and holds nothing about anyone else. It is a convenience: storage that cannot be
 * used only loses it, and what a person holds and could take out is always read from the chain, never from here.
 */
export interface OwnStep {
  kind: "back" | "take-out" | "take-out-team";
  /** The project's chain key. */
  project: string;
  /** Unix seconds when the step landed. */
  at: number;
  /** Dollars paid (a Back) or received (a Take out), in dollar units. */
  dollars: string;
  /** Shares bought or given up, in Share units. */
  shares: string;
  txHash: string;
  /**
   * The tasks a Take out wrote money-owed claims on, by serial (decimal text), when the app could read them after it landed:
   * best effort, never needed for the Take out, and each one is read from the network again before it is shown.
   */
  notes?: string[];
}

/** The most serials one step remembers (a take-out spreads over at most the open tasks). */
const MAX_NOTES = 16;

const STORAGE_KEY = "creaton.pot.history";
/** The newest steps kept per account. */
const MAX_STEPS = 200;

/** Where the steps are kept when storage cannot be used: this page only. */
let memory: Record<string, OwnStep[]> = {};

const isStep = (v: unknown): v is OwnStep => {
  if (!v || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  return (
    (s.kind === "back" ||
      s.kind === "take-out" ||
      s.kind === "take-out-team") &&
    typeof s.project === "string" &&
    typeof s.at === "number" &&
    typeof s.dollars === "string" &&
    /^\d{1,40}$/.test(s.dollars) &&
    typeof s.shares === "string" &&
    /^\d{1,40}$/.test(s.shares) &&
    typeof s.txHash === "string" &&
    (s.notes === undefined ||
      (Array.isArray(s.notes) &&
        s.notes.length <= MAX_NOTES &&
        s.notes.every((n) => typeof n === "string" && /^\d{1,15}$/.test(n))))
  );
};

function readAll(): Record<string, OwnStep[]> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, OwnStep[]> = {};
    for (const [account, steps] of Object.entries(parsed))
      if (Array.isArray(steps)) out[account] = steps.filter(isStep);
    return out;
  } catch {
    return { ...memory };
  }
}

/** This account's steps, newest first, for one project or (without `project`) for all. */
export function ownSteps(account: string, project?: string): OwnStep[] {
  const steps = readAll()[account.toLowerCase()] ?? [];
  return steps
    .filter((s) => project === undefined || s.project === project)
    .sort((a, b) => b.at - a.at);
}

/** Remember a step that landed. The same transaction is kept once. */
export function rememberStep(account: string, step: OwnStep): void {
  const all = readAll();
  const key = account.toLowerCase();
  const mine = (all[key] ?? []).filter((s) => s.txHash !== step.txHash);
  mine.push(step);
  mine.sort((a, b) => b.at - a.at);
  all[key] = mine.slice(0, MAX_STEPS);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // Storage is off: this page still remembers it.
    memory = all;
  }
}

/** What this account paid in on a project from this browser, in dollar units: Backs less nothing (take-outs are listed apart). */
export function paidInFromHere(account: string, project: string): bigint {
  return ownSteps(account, project)
    .filter((s) => s.kind === "back")
    .reduce((sum, s) => sum + BigInt(s.dollars), 0n);
}

/**
 * Writes the serials of the tasks a Take out left money owed on into that step (found by its transaction), best effort: a
 * step that is not there, or storage that cannot be used, loses nothing that matters, since the same claims are found by the
 * look-back. Never throws.
 */
export function rememberNotes(
  account: string,
  txHash: string,
  serials: readonly bigint[],
): void {
  try {
    if (serials.length === 0) return;
    const all = readAll();
    const key = account.toLowerCase();
    const mine = all[key] ?? [];
    const step = mine.find((s) => s.txHash === txHash);
    if (!step) return;
    step.notes = [...new Set(serials.map((n) => n.toString()))].slice(
      0,
      MAX_NOTES,
    );
    all[key] = mine;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
    } catch {
      memory = all;
    }
  } catch {
    // The claims are found by the look-back all the same.
  }
}

/** The tasks this browser remembers this account left money owed on, in one project, as serials (newest step first). */
export function ownNoteSerials(account: string, project: string): bigint[] {
  const seen = new Set<string>();
  for (const step of ownSteps(account, project))
    for (const n of step.notes ?? []) seen.add(n);
  return [...seen].map((n) => BigInt(n));
}

/** Whether this browser remembers a Take out of this account in this project (it sees the claims section with no Shares). */
export function tookOutHere(account: string, project: string): boolean {
  return ownSteps(account, project).some(
    (s) => s.kind === "take-out" || s.kind === "take-out-team",
  );
}
