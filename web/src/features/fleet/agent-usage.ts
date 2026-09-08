/**
 * Local usage ledger for the browser agent.
 *
 * Records per-call token usage from the LLM gateway responses (OpenAI-style
 * `usage` object). Estimates cost with placeholder rates; relay-side metrics
 * (kind 44200) are the future authoritative source.
 */

const USAGE_KEY = "buzz.agent.usage";
const MAX_ENTRIES = 500;

/** Placeholder rates per 1M tokens — override once real pricing is known. */
export const COST_RATES = { inputPerM: 0.15, outputPerM: 0.6 };

export interface UsageRecord {
  prompt: number;
  completion: number;
  model: string;
  ts: number;
}

export function readUsage(): UsageRecord[] {
  try {
    const raw = localStorage.getItem(USAGE_KEY);
    return raw ? (JSON.parse(raw) as UsageRecord[]) : [];
  } catch {
    return [];
  }
}

export function recordUsage(input: {
  prompt: number;
  completion: number;
  model: string;
}): void {
  try {
    const next = [...readUsage(), { ...input, ts: Date.now() }].slice(
      -MAX_ENTRIES,
    );
    localStorage.setItem(USAGE_KEY, JSON.stringify(next));
  } catch {
    // best-effort
  }
}

export function usageTotals() {
  const records = readUsage();
  const prompt = records.reduce((s, r) => s + r.prompt, 0);
  const completion = records.reduce((s, r) => s + r.completion, 0);
  const est =
    (prompt / 1_000_000) * COST_RATES.inputPerM +
    (completion / 1_000_000) * COST_RATES.outputPerM;
  return { calls: records.length, prompt, completion, est };
}

export function resetUsage(): void {
  try {
    localStorage.removeItem(USAGE_KEY);
  } catch {
    // ignore
  }
}
