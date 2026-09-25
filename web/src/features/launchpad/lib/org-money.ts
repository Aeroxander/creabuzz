/**
 * The org money plane: kind:37012 budgets, kind:37014 spend receipts, the
 * `OrgAllowance` contract reads behind them, and the onchain DAO binding the
 * ragequit surface exits.
 *
 * Sources (all cited, READ-ONLY):
 * - `docs/nips/NIP-ORG.md` — the 37012 budget shape (content JSON: subject,
 *   periods, windows, allocation, rollover, onchain{chain,contract,subject},
 *   start, end) and the 37014 spend-receipt shape (txHash, chain, contract,
 *   subject, agent, actionId, amount, budgetId).
 * - `contracts/src/OrgAllowance.sol` — the allowance interface the panel
 *   reads: `allowanceOf(bytes32 subject, address token, uint64 epoch)`,
 *   `spentOf(...)`, `remainingOf(...)`, `spenderOf(bytes32)`
 *   (:63-81), with `Spent`/`AllowanceSet` events as the onchain ledger.
 *   `subject` is "the agent's Nostr pubkey, 32 raw bytes" (:31-33) — so the
 *   bytes32 subject is the hex pubkey verbatim.
 * - `crates/buzz-evm-allowance/src/epoch.rs` — the window→epoch mapping:
 *   all-time `epoch` → 0, `day` → unix/86400, `week` → unix/604800,
 *   `month` → unix/2592000 (fixed 30-day months, the documented dev
 *   simplification).
 * - `crates/buzz-cli/src/commands/org.rs` `cmd_org_bind` — the binding
 *   record: the org root's kind:37010 content gains
 *   `onchain: { chain, dao, boundAt }` ("the 37010 update IS the binding
 *   record"). The ragequit surface consumes exactly that field, plus the
 *   NIP-LP `summon` receipt's `dao` payload when a launch has one.
 *
 * Web DOES have an org-event read path (the relay query surface, same as
 * `features/fleet/use-org-chart.ts` reads 37010): budgets and spend receipts
 * are read live here rather than rendered onchain-only.
 */
import type { NostrEvent } from "@/shared/lib/nostr-client";
import { decodeU256, ethCall } from "../chain.ts";

/** The `onchain` binding the `buzz org bind` update carries (org.rs:889-896). */
export interface OrgBinding {
  /** The org root's 32-hex event id (OrgBinding.sol's `rootId`). */
  rootEventId: string;
  dao: string;
  chain: string | null;
  boundAt: number | null;
}

function contentObject(event: NostrEvent): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(event.content);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Malformed content is a null parse, not a crash (index-org.ts convention).
  }
  return null;
}

/**
 * Parse one kind:37010 root node carrying `content.onchain`. Non-root nodes
 * and unbound roots return null — binding is root-scoped (OrgBinding.sol:100).
 */
export function parseOrgBinding(event: NostrEvent): OrgBinding | null {
  if (event.kind !== 37010) return null;
  const body = contentObject(event);
  if (!body) return null;
  const onchain =
    body.onchain &&
    typeof body.onchain === "object" &&
    !Array.isArray(body.onchain)
      ? (body.onchain as Record<string, unknown>)
      : null;
  if (!onchain) return null;
  const dao = typeof onchain.dao === "string" ? onchain.dao : null;
  if (!dao || !/^0x[0-9a-fA-F]{40}$/.test(dao)) return null;
  return {
    rootEventId: event.id,
    dao: dao.toLowerCase(),
    chain: typeof onchain.chain === "string" ? onchain.chain : null,
    boundAt: typeof onchain.boundAt === "number" ? onchain.boundAt : null,
  };
}

/** How the DAO behind the exit surface was found — the UI states it. */
export interface DaoBinding {
  dao: string;
  source: "summon-receipt" | "org-root";
  /** For `org-root`: the bound root's event id; for receipts: the tx. */
  ref: string;
}

/**
 * Resolve the DAO a ragequit would exit. The launch's NIP-LP `summon`
 * receipt payload (`dao` field) wins when present; the community's bound org
 * root (`content.onchain.dao`) is the fallback.
 */
export function resolveDaoBinding(input: {
  receipts: ReadonlyArray<{
    table: string;
    payload: Record<string, unknown>;
    tx: string;
    createdAt: number;
  }>;
  orgBindings: readonly OrgBinding[];
}): DaoBinding | null {
  let newest: DaoBinding | null = null;
  let newestAt = -1;
  for (const receipt of input.receipts) {
    if (receipt.table !== "summon") continue;
    const dao = receipt.payload.dao;
    if (typeof dao !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(dao)) continue;
    if (receipt.createdAt >= newestAt) {
      newestAt = receipt.createdAt;
      newest = {
        dao: dao.toLowerCase(),
        source: "summon-receipt",
        ref: receipt.tx,
      };
    }
  }
  if (newest) return newest;
  for (const binding of input.orgBindings) {
    return { dao: binding.dao, source: "org-root", ref: binding.rootEventId };
  }
  return null;
}

// ------------------------------------------------------------- budgets ----

/** One kind:37012 budget window (NIP-ORG's `windows` union). */
export type BudgetWindow = "epoch" | "day" | "week" | "month";

/** The kind:37012 budget as this panel reads it. */
export interface OrgBudget {
  id: string;
  author: string;
  createdAt: number;
  /** The agent the ceiling binds (hex pubkey). */
  subject: string;
  /** Activities the window bounds (`all` = everything). */
  periods: string[];
  /** The spend ceiling per window. */
  windows: BudgetWindow[];
  /** Plain currency units per window (allocation may instead declare a token). */
  allocation: bigint | null;
  rollover: boolean;
  /** Present when the budget is bound to an onchain allowance. */
  onchain: { chain: string; contract: string; subject: string } | null;
  start: number | null;
  end: number | null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

const WINDOWS: readonly BudgetWindow[] = ["epoch", "day", "week", "month"];

/** Parse one kind:37012 budget event (NIP-ORG.md's content shape). */
export function parseOrgBudget(event: NostrEvent): OrgBudget | null {
  if (event.kind !== 37012) return null;
  const body = contentObject(event);
  if (!body) return null;
  const subject = typeof body.subject === "string" ? body.subject : "";
  const d = event.tags.find((t) => t[0] === "d")?.[1];
  if (!subject || !d) return null;
  const windows = stringArray(body.windows).filter((w): w is BudgetWindow =>
    (WINDOWS as readonly string[]).includes(w),
  );
  const allocation =
    typeof body.allocation === "number"
      ? BigInt(body.allocation)
      : typeof body.allocation === "string" && /^\d+$/.test(body.allocation)
        ? BigInt(body.allocation)
        : null;
  const rawOnchain =
    body.onchain &&
    typeof body.onchain === "object" &&
    !Array.isArray(body.onchain)
      ? (body.onchain as Record<string, unknown>)
      : null;
  const onchain =
    rawOnchain &&
    typeof rawOnchain.chain === "string" &&
    typeof rawOnchain.contract === "string" &&
    typeof rawOnchain.subject === "string"
      ? {
          chain: rawOnchain.chain,
          contract: rawOnchain.contract,
          subject: rawOnchain.subject,
        }
      : null;
  return {
    id: d,
    author: event.pubkey,
    createdAt: event.created_at,
    subject,
    periods: stringArray(body.periods),
    windows,
    allocation,
    rollover: body.rollover === true,
    onchain,
    start: numberOrNull(body.start),
    end: numberOrNull(body.end),
  };
}

// --------------------------------------------------- spend receipts ----

/** The kind:37014 spend receipt as this panel reads it (NIP-ORG.md:358-412). */
export interface SpendReceipt {
  id: string;
  createdAt: number;
  txHash: string;
  chain: string;
  contract: string;
  subject: string;
  agent: string | null;
  actionId: string | null;
  amount: bigint;
  budgetId: string | null;
}

/** Parse one kind:37014 spend receipt event. */
export function parseSpendReceipt(event: NostrEvent): SpendReceipt | null {
  if (event.kind !== 37014) return null;
  const body = contentObject(event);
  if (!body) return null;
  const txHash = typeof body.txHash === "string" ? body.txHash : null;
  const contract = typeof body.contract === "string" ? body.contract : null;
  const subject = typeof body.subject === "string" ? body.subject : null;
  const amount =
    typeof body.amount === "number"
      ? BigInt(body.amount)
      : typeof body.amount === "string" && /^\d+$/.test(body.amount)
        ? BigInt(body.amount)
        : null;
  const d = event.tags.find((t) => t[0] === "d")?.[1];
  if (!txHash || !contract || !subject || amount === null || !d) return null;
  return {
    id: d,
    createdAt: event.created_at,
    txHash,
    chain: typeof body.chain === "string" ? body.chain : "",
    contract,
    subject,
    agent: typeof body.agent === "string" ? body.agent : null,
    actionId: typeof body.actionId === "string" ? body.actionId : null,
    amount,
    budgetId: typeof body.budgetId === "string" ? body.budgetId : null,
  };
}

// ------------------------------------------------------ OrgAllowance ----

/** `cast sig` goldens (recorded in `org-money.test.mjs`). */
export const SELECTOR_ALLOWANCE_OF = "0x90f42eed"; // allowanceOf(bytes32,address,uint64)
export const SELECTOR_SPENT_OF = "0x5f85ed9c"; // spentOf(bytes32,address,uint64)
export const SELECTOR_REMAINING_OF = "0xb529bdc5"; // remainingOf(bytes32,address,uint64)
export const SELECTOR_SPENDER_OF = "0x6a986708"; // spenderOf(bytes32)

const DAY_SECS = 86_400n;
const WEEK_SECS = 604_800n;
const MONTH_SECS = 2_592_000n;

/**
 * The contract's `uint64` epoch for a budget window (epoch.rs:26-36): all
 * time maps to 0; day/week/month are fixed-width unix quotients.
 */
export function budgetEpoch(window: BudgetWindow, unixSecs: bigint): bigint {
  switch (window) {
    case "epoch":
      return 0n;
    case "day":
      return unixSecs / DAY_SECS;
    case "week":
      return unixSecs / WEEK_SECS;
    case "month":
      return unixSecs / MONTH_SECS;
  }
}

function wordPad32(value: string): string {
  return value.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

function uintWord(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

/** Compose the `OrgAllowance` view calls for one (subject, token, epoch). */
export function buildAllowanceReads(input: {
  contract: string;
  subject: string;
  token: string;
  epoch: bigint;
}): Array<{
  name: "allowance" | "spent" | "remaining" | "spender";
  to: string;
  data: string;
}> {
  const args = `${wordPad32(input.subject)}${wordPad32(input.token)}${uintWord(input.epoch)}`;
  return [
    {
      name: "allowance",
      to: input.contract.toLowerCase(),
      data: `${SELECTOR_ALLOWANCE_OF}${args}`,
    },
    {
      name: "spent",
      to: input.contract.toLowerCase(),
      data: `${SELECTOR_SPENT_OF}${args}`,
    },
    {
      name: "remaining",
      to: input.contract.toLowerCase(),
      data: `${SELECTOR_REMAINING_OF}${args}`,
    },
    {
      name: "spender",
      to: input.contract.toLowerCase(),
      data: `${SELECTOR_SPENDER_OF}${wordPad32(input.subject)}`,
    },
  ];
}

/** One budget's live allowance state (the spend ledger's onchain half). */
export interface AllowanceState {
  allowance: bigint;
  spent: bigint;
  remaining: bigint;
  spender: string | null;
  epoch: bigint;
}

/** Thin fetcher over the launchpad RPC seam; decoding stays trivial. */
export async function fetchAllowanceState(
  endpoint: string,
  input: {
    contract: string;
    subject: string;
    token: string;
    window: BudgetWindow;
    now: bigint;
  },
): Promise<AllowanceState> {
  const epoch = budgetEpoch(input.window, input.now);
  const reads = buildAllowanceReads({ ...input, epoch });
  const out: Record<string, bigint> = {};
  let spender: string | null = null;
  for (const read of reads) {
    const raw = await ethCall(endpoint, read.to, read.data);
    const value = decodeU256(raw);
    if (read.name === "spender") {
      spender =
        value === 0n ? null : `0x${value.toString(16).padStart(40, "0")}`;
    } else {
      out[read.name] = value;
    }
  }
  return {
    allowance: out.allowance ?? 0n,
    spent: out.spent ?? 0n,
    remaining: out.remaining ?? 0n,
    spender,
    epoch,
  };
}
