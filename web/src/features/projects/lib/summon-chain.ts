/**
 * The chain reads the summon flow needs, in one small module.
 *
 * `launchpad/chain.ts` is the launchpad's own RPC seam and is READ-ONLY for
 * this feature, so the one read it does not expose — `eth_getTransactionReceipt`
 * — lives here rather than being patched into it.
 *
 * What it answers, honestly:
 *
 * - **did the summon mine, or revert?** A submitted hash is not a result: the
 *   flow polls a bounded number of times and reports `reverted` as data (a
 *   failed step, never a silent success) or `unknown` when the budget of
 *   attempts runs out (`mint-flow.ts:499-515` names the same two states).
 * - **which DAO was created?** `Summoner.summon` emits
 *   `NewDAO(address indexed summoner, Moloch indexed dao)`
 *   (`contracts/lib/majeur/src/Moloch.sol:2056`), so the second topic of the
 *   first matching log *is* the DAO address — a fact read off the chain, not a
 *   CREATE2 prediction. When no such log is there, `dao` is null and the
 *   receipt says null.
 *
 * Every loop is bounded (Review-Proven Rule 4): attempts × delay, no
 * unbounded wait, and a terminal `unknown` rather than a forever-poll.
 */

/** `cast keccak "NewDAO(address,address)"` — the Summoner's event topic. */
export const NEWDAO_TOPIC =
  "0x567cac11d4a66456bbe20dc60d3579ec446a4e2fffae2a85f82ad0f1f18214f1";

export type SummonTxOutcome = "success" | "reverted" | "unknown";

export interface ConfirmedSummon {
  status: SummonTxOutcome;
  /** The DAO address from the `NewDAO` log, or null when none was read. */
  dao: string | null;
  /** Block the tx mined in, when it mined (for the receipt's legibility). */
  blockNumber: string | null;
  /** Why the outcome is `unknown` (last RPC error), when it is. */
  reason?: string;
}

async function postRpc(
  endpoint: string,
  method: string,
  params: unknown[],
  timeoutMs = 6_000,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`rpc http ${res.status}`);
    const body = (await res.json()) as {
      result?: unknown;
      error?: { message?: string };
    };
    if (body.error) throw new Error(body.error.message ?? "rpc error");
    return body.result;
  } finally {
    clearTimeout(timer);
  }
}

interface RpcLog {
  topics?: unknown;
}

interface RpcReceipt {
  status?: unknown;
  logs?: unknown;
  blockNumber?: unknown;
}

/** Pull the `NewDAO` DAO address out of a receipt's logs. */
export function daoFromNewDaoLogs(logs: readonly RpcLog[]): string | null {
  for (const log of logs) {
    const topics = Array.isArray(log.topics) ? log.topics : [];
    if (topics[0] !== NEWDAO_TOPIC) continue;
    const dao = typeof topics[2] === "string" ? topics[2] : null;
    if (dao && /^0x[0-9a-fA-F]{40}$/.test(dao)) return dao.toLowerCase();
  }
  return null;
}

/**
 * One bounded `eth_getTransactionReceipt` read.
 *
 * Returns `null` while the tx is not mined yet — "not there yet" and "reverted"
 * are different facts and the caller must not conflate them.
 */
export async function fetchSummonReceipt(
  endpoint: string,
  txHash: string,
): Promise<ConfirmedSummon | null> {
  const raw = await postRpc(endpoint, "eth_getTransactionReceipt", [txHash]);
  if (raw === null || typeof raw !== "object") return null;
  const receipt = raw as RpcReceipt;
  const logs = Array.isArray(receipt.logs) ? (receipt.logs as RpcLog[]) : [];
  const status = receipt.status === "0x0" ? "reverted" : "success";
  const blockNumber =
    typeof receipt.blockNumber === "string" ? receipt.blockNumber : null;
  return { status, dao: daoFromNewDaoLogs(logs), blockNumber };
}

/**
 * Wait, bounded, for the summon's outcome.
 *
 * @param attempts how many receipt reads to make (default 20)
 * @param delayMs pause between reads (default 1500 ms → ~30 s ceiling)
 */
export async function confirmSummonTx(
  endpoint: string,
  txHash: string,
  options: {
    attempts?: number;
    delayMs?: number;
    sleep?: () => Promise<void>;
  } = {},
): Promise<ConfirmedSummon> {
  const attempts = Math.max(1, options.attempts ?? 20);
  const delayMs = options.delayMs ?? 1_500;
  const sleep =
    options.sleep ??
    (() => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  let lastError: string | null = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await sleep();
    try {
      const receipt = await fetchSummonReceipt(endpoint, txHash);
      if (receipt) return receipt;
    } catch (err) {
      // A flaky RPC is not a result: remember it and keep polling inside the
      // bounded budget, then report `unknown` — never "success".
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  return {
    status: "unknown",
    dao: null,
    blockNumber: null,
    ...(lastError ? { reason: lastError } : {}),
  };
}
