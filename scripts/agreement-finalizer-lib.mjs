/**
 * Agreement finalizer — the durable operator worker library.
 *
 * What this is: ONE durable, operator-run worker that finishes an agreed
 * contribution on its exact onchain terms. Ordinary automation driven by an
 * explicit operator job list — no model judgment, no scanning, no
 * discretionary choice. The worker signs and broadcasts only two kinds of
 * transaction, and derives everything else (target, calldata, recipients,
 * amounts) from onchain records it re-reads fresh before every transaction
 * step:
 *
 *   1. `ClaimStake.settle(claimId)` — START a verified APPROVAL challenge
 *      window. It checks the snapshot-relative approval quorum (approvals
 *      counter minus the count snapshotted at submission) and the ABSENCE of
 *      an objection quorum first; a claim with an objection quorum (or a
 *      frozen / disputed state) is BLOCKED — the worker never settles into
 *      the contract's rejection/slash branch, so it can never autonomously
 *      cause a rejection or a slash.
 *   2. `Moloch.settleAgreement(mandate, agreementId)` — settle an exact
 *      accepted agreement. `Moloch.settleAgreement` returns no data (empty
 *      ABI outputs — never "filled in"); expected recipients and amounts are
 *      derived from the mandate's `agreements()` and `splits(bytes32)` getter
 *      records, the exact call is simulated with `eth_call` before signing,
 *      and the receipt is then VERIFIED (AgreementSettled event, the claim's
 *      durable `agreementOfClaim` binding, exact `Transfer` mint logs, exact
 *      balance/supply deltas, mandate counters) before the journal is allowed
 *      to say `confirmed`.
 *
 * Safety envelope — each of these has a test that fails if its guard is
 * removed (see agreement-finalizer.test.mjs):
 *
 *   - LOOPBACK ANVIL ONLY: `http://` loopback URL that must answer
 *     `anvil_metadata`; the journal binds chainId + instanceId + genesis
 *     hash + clientVersion + fork provenance. A chain reset / a new node
 *     instance / a changed identity flips nonterminal jobs to
 *     `environment-changed` and the run refuses; it never falls back to
 *     another network (no hidden daemon magic, no env sourcing).
 *   - FIXTURE SIGNER ONLY: writes require BOTH `--opt-in-fixture-writes` and
 *     `--fixture-key`, where the key must derive to one of the well-known
 *     anvil dev accounts. Only the derived address enters the journal and
 *     logs. The worker pays fixture gas only; it holds no project authority
 *     (every step it signs is an ordinary permissionless path on the
 *     mandate).
 *   - BOUNDED WORK: the operator passes an exact job list
 *     (`chain,dao,mandate,agreement,action`); there is no scanner. Only the
 *     two allowed calls are ever signed; no recipient/amount/mint/treasury
 *     choice; no arbitrary calldata.
 *   - DURABLE, EXACT-ONCE JOURNAL: JSON records persisted atomically
 *     (tmp → fsync → rename) with restrictive permissions (0700 dir, 0600
 *     files). The SIGNED RAW TX + hash + nonce + expected effects persist
 *     BEFORE the first broadcast; a crash after broadcast is reconciled by
 *     the stored hash; retries broadcast the SAME raw bytes (never a fresh
 *     nonce). Failed and mismatch records are kept, never deleted; terminal
 *     recovery is an explicit operator command (`--retry`, `--reconcile`).
 *   - EXPLICIT CONCURRENCY: the journal holds a live-holder lock. A second
 *     worker exits with a distinct code; a stale lock is refused until the
 *     operator passes `--reclaim` (and reclaim refuses a live holder).
 *   - CONFIRMATION DEPTH + CANONICALITY: `queued`/`submitted` are never a
 *     success. `confirmed` requires a receipt at the configured depth whose
 *     blockHash is still the canonical block at that height (a reorg keeps
 *     the job intact on the same raw bytes), plus the expected-effects
 *     verification above.
 *
 * Interfaces are read the way the current candidate contracts compile them
 * (`contracts/out/*.json`; Phase B rework is in flight). Shape drift
 * surfaces as `observed-mismatch` against the real chain — the integration
 * test drives this reader against freshly built real contracts on a scratch
 * anvil and the read adapter is aligned before any result is trusted (per
 * docs/v3-review/AWARD-MECHANICS-SPEC.md and docs/v3-review/TESTING.md).
 *
 * CLI entry point: agreement-finalizer.mjs (a thin argument shell).
 */
import { bytesToHex } from "../packages/creaton-core/node_modules/@noble/hashes/utils.js";
import { keccak_256 } from "../packages/creaton-core/node_modules/@noble/hashes/sha3.js";
import {
  encodeFunctionData,
  encodeParameters,
  decodeParameters,
  selectorOf,
} from "../packages/creaton-core/src/launchpad/evmAbi.ts";

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// ---------------------------------------------------------------------------
// Journal identity, states, constants
// ---------------------------------------------------------------------------

export const JOURNAL_FORMAT = 1;
export const JOURNAL_DIR_MODE = 0o700;
export const JOURNAL_FILE_MODE = 0o600;
export const JOURNAL_LOCK_NAME = "worker.lock";
export const JOURNAL_ENV_NAME = "environment.json";

export const JOB_STATES = [
  "queued",
  "prepared",
  "submitted",
  "confirmed",
  "blocked",
  "failed",
  "environment-changed",
  "observed-mismatch",
];

export const ACTIONS = ["start-window", "settle-agreement"];

/** ClaimStake.Status enum, in declaration order. */
export const CLAIM_STATUS = {
  Open: 0,
  Approved: 1,
  Rejected: 2,
  Frozen: 3,
  Paid: 4,
  Recovered: 5,
  Expired: 6,
};

/** TreasuryMandate.agreements[].terminalKind constants (source of truth: source). */
export const TERMINAL_KIND = { ACTIVE: 0, SETTLED: 1, CANCELLED: 2, EXPIRED: 3 };

/** Splits: at most four parties, percentages in bps summing to 10000. */
export const SPLIT_MAX_PARTIES = 4;
export const SPLIT_ALL = 10000;

/**
 * The well-known anvil dev accounts (anvil's default test mnemonic), from the
 * boot log verified in the integration test. Writes are only ever signed
 * with a key whose derived address is exactly one of these — so no arbitrary
 * existing user key, no project key material, ever enters the path.
 */
export const WELLKNOWN_ANVIL_ADDRESSES = [
  "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
  "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
  "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc",
  "0x90f79bf6eb2c4f870365e785982e1f101e93b906",
  "0x15d34aaf54267db7d7c367839aaf71a00a2c6a65",
  "0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc",
  "0x976ea74026e726554db657fa54763abd0c3a0aa9",
  "0x14dc79964da2c08b23698b3d3cc7ca32193d9955",
  "0x23618e81e3f5cdf7f54c3d65f7fbc0abf5b21e8f",
  "0xa0ee7a142d267c1f36714e4a8f75612f20a79720",
];

/** Well-known anvil dev PRIVATE keys (public test fixtures; the derived
 * addresses above are cross-checked against anvil's own boot log in the
 * real-chain integration). */
export const WELLKNOWN_ANVIL_KEYS = {
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80":
    "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d":
    "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a":
    "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6":
    "0x90f79bf6eb2c4f870365e785982e1f101e93b906",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a":
    "0x15d34aaf54267db7d7c367839aaf71a00a2c6a65",
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba":
    "0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc",
  "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e":
    "0x976ea74026e726554db657fa54763abd0c3a0aa9",
  "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356":
    "0x14dc79964da2c08b23698b3d3cc7ca32193d9955",
  "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97":
    "0x23618e81e3f5cdf7f54c3d65f7fbc0abf5b21e8f",
  "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6":
    "0xa0ee7a142d267c1f36714e4a8f75612f20a79720",
};

// ---------------------------------------------------------------------------
// Canonical signatures / event topics (derived, never hand-pinned)
// ---------------------------------------------------------------------------

export const SIG = {
  // ClaimStake
  settle: "settle(bytes32)",
  claimTerms: "claimTerms(bytes32)",
  claimStruct: "claims(bytes32)",
  approvalsAtSubmit: "approvalsAtSubmit(bytes32)",
  objectionsAtSubmit: "objectionsAtSubmit(bytes32)",
  challengeWindow: "challengeWindow()",
  // VerifierSet
  approvalCount: "approvalCount(bytes32)",
  objectionCount: "objectionCount(bytes32)",
  verifierQuorum: "quorum()",
  // TreasuryMandate (+ factory)
  agreements: "agreements(bytes32)",
  agreementsVersion: "AGREEMENTS_VERSION()",
  splits: "splits(bytes32)",
  agreementOfClaim: "agreementOfClaim(bytes32)",
  contributionAwarded: "contributionAwarded(bytes32)",
  mandateSharesAwarded: "mandateSharesAwarded()",
  sharesReserved: "sharesReserved(bytes32)",
  mandateDao: "dao()",
  mandateClaims: "claims()",
  mandateVerifiers: "verifiers()",
  mandateCurrency: "currency()",
  mandateClosed: "closed()",
  // ClaimStake identity getters
  claimsTreasury: "treasury()",
  claimsVerifiers: "verifiers()",
  // Moloch
  daoSettleAgreement: "settleAgreement(address,bytes32)",
  // TreasuryMandate (the terms-bound settlement the DAO calls; returns the
  // exact parties/portions it will mint)
  mandateSettleAgreement: "settleAgreement(bytes32)",
  daoShares: "shares()",
  daoVotingWeight: "votingWeight()",
  // AllocationVoting / TreasuryMandateFactory
  mandateFactory: "mandateFactory()",
  factoryDaos: "daos(address)",
};

export { selectorOf, encodeFunctionData, encodeParameters, decodeParameters };
export const SELECTORS = {
  settle: selectorOf(SIG.settle),
  daoSettleAgreement: selectorOf(SIG.daoSettleAgreement),
};

/** `keccak256("Transfer(address,address,uint256)")` — the known mint log. */
export const TRANSFER_TOPIC =
  "0x" + bytesToHex(keccak_256(new TextEncoder().encode("Transfer(address,address,uint256)")));

const CLAIM_RELEASED_TOPIC =
  "0x" + bytesToHex(keccak_256(new TextEncoder().encode("ClaimReleased(bytes32,address,uint256)")));

export const CLAIM_RELEASED_TOPIC_EXPORT = CLAIM_RELEASED_TOPIC;

const AGREEMENT_SETTLED_TOPIC =
  "0x" + bytesToHex(keccak_256(new TextEncoder().encode("AgreementSettled(bytes32,bytes32,address,uint128)")));

export const AGREEMENT_SETTLED_TOPIC_EXPORT = AGREEMENT_SETTLED_TOPIC;

const UNKNOWN_AGREEMENT_SELECTOR =
  "0x" + bytesToHex(keccak_256(new TextEncoder().encode("UnknownAgreement(bytes32)")));

const IN_CHALLENGE_WINDOW_SELECTOR =
  "0x" + bytesToHex(keccak_256(new TextEncoder().encode("InChallengeWindow(bytes32,uint64)")));

export const ERROR_SELECTOR_IDS = {
  unknownAgreement: UNKNOWN_AGREEMENT_SELECTOR.slice(2),
  inChallengeWindow: IN_CHALLENGE_WINDOW_SELECTOR.slice(2),
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

// Every error class below carries the CLI exit code it maps to as an explicit
// `exitCode` field (documented in scripts/agreement-finalizer.mjs). The CLI
// never guesses from class names; an error without a code exits 9.

/** Argument/usage problem: the run refused before touching any job. */
export class UsageError extends Error {
  exitCode = 1;
}
/** Journal lock held by another live worker. */
export class LockBusy extends Error {
  exitCode = 3;
  constructor(holder) {
    super(`journal lock held by another worker (pid ${holder?.pid ?? "?"}, started ${holder?.startedAt ?? "?"})`);
    this.holder = holder;
  }
}
/** A dead holder's lock file: refuse, and offer the explicit `--reclaim`. */
export class LockStale extends Error {
  exitCode = 3;
  constructor(msg) {
    super(msg);
  }
}
/** Environment identity changed (chain reset / new instance / provenance drift). */
export class EnvironmentChanged extends Error {
  exitCode = 4;
}
/** The job's checked conditions forbid the action right now (never a success). */
export class BlockedJob extends Error {
  exitCode = 7;
  constructor(reason, detail) {
    super(reason);
    this.reason = reason;
    this.detail = detail;
  }
}

// ---------------------------------------------------------------------------
// Job identity and parsing
// ---------------------------------------------------------------------------

export function normalizeAddress(value, label) {
  if (typeof value !== "string") throw new UsageError(`${label ?? "address"} must be a hex 0x address`);
  const hex = value.startsWith("0x") || value.startsWith("0X") ? value.slice(2) : value;
  if (!/^[0-9a-fA-F]{40}$/.test(hex)) {
    throw new UsageError(`${label ?? "address"} must be 20 hex bytes (0x…): got '${value}'`);
  }
  return "0x" + hex.toLowerCase();
}

export function normalizeBytes32(value, label) {
  if (typeof value !== "string") throw new UsageError(`${label ?? "bytes32"} must be hex`);
  let hex = value.toLowerCase();
  if (!hex.startsWith("0x")) hex = "0x" + hex;
  if (!/^0x[0-9a-f]{64}$/.test(hex)) {
    throw new UsageError(`${label ?? "bytes32"} must be 32 hex bytes (0x…): got '${value}'`);
  }
  return hex;
}

/**
 * Parse one `--job chain=31337,dao=0x…,mandate=0x…,agreement=0x…,action=…`
 * spec. Strict: unknown keys, empty values, wrong hex shapes, unknown
 * actions are UsageErrors — the operator's bounded list is the only source
 * of work.
 */
export function parseJobSpec(spec) {
  if (typeof spec !== "string" || spec.trim() === "") throw new UsageError("empty job spec");
  const fields = {};
  for (const part of spec.trim().split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) throw new UsageError(`job spec part '${part}' is not key=value`);
    const key = part.slice(0, eq).trim();
    let value = part.slice(eq + 1).trim();
    if (key in fields) throw new UsageError(`job spec repeats key '${key}'`);
    if (value === "") throw new UsageError(`job spec has empty value for '${key}'`);
    if (key === "chain") {
      if (!/^\d+$/.test(value)) throw new UsageError(`job 'chain' must be a decimal chain id: got '${value}'`);
      value = String(BigInt(value));
    } else if (key === "action") {
      if (!ACTIONS.includes(value)) {
        throw new UsageError(`job 'action' must be one of ${ACTIONS.join("|")}: got '${value}'`);
      }
    } else if (key === "dao" || key === "mandate" || key === "agreement") {
      value = key === "agreement" ? normalizeBytes32(value, key) : normalizeAddress(value, key);
    } else {
      throw new UsageError(`job spec has unknown key '${key}' (expected chain,dao,mandate,agreement,action)`);
    }
    fields[key] = value;
  }
  for (const required of ["chain", "dao", "mandate", "agreement", "action"]) {
    if (!(required in fields)) throw new UsageError(`job spec is missing '${required}'`);
  }
  return {
    chainId: fields.chain,
    dao: fields.dao,
    mandate: fields.mandate,
    agreementId: fields.agreement,
    action: fields.action,
  };
}

/** The journal file slug for a job identity (a content-derived file name). */
export function jobFileSlug(identity) {
  const canonical = JSON.stringify({
    action: identity.action,
    agreementId: identity.agreementId,
    chainId: identity.chainId,
    dao: identity.dao,
    mandate: identity.mandate,
  });
  return "job-" + createHash("sha256").update(canonical).digest("hex").slice(0, 40) + ".json";
}

export function describeJobIdentity(id) {
  return `${id.action} chain=${id.chainId} dao=${id.dao} mandate=${id.mandate} agreement=${id.agreementId}`;
}

// ---------------------------------------------------------------------------
// Hex quantity helpers
// ---------------------------------------------------------------------------

export function hexToBig(hex) {
  if (typeof hex !== "string" || !/^0x[0-9a-f]+$/i.test(hex)) {
    throw new Error(`not a 0x hex quantity: '${hex}'`);
  }
  return BigInt(hex.toLowerCase());
}

export function bigToHex(bn) {
  if (typeof bn !== "bigint") throw new Error(`not a bigint: ${bn}`);
  return "0x" + bn.toString(16);
}

export const ZERO_ADDRESS = "0x" + "0".repeat(40);
export const ZERO_BYTES32 = "0x" + "0".repeat(64);

// ---------------------------------------------------------------------------
// Atomic journal storage (0700 dir, 0600 files, fsync+rename)
// ---------------------------------------------------------------------------

function writeAtomic(file, content) {
  const tmp = file + ".tmp-" + process.pid + "-" + Math.random().toString(36).slice(2, 8);
  fs.writeFileSync(tmp, content, { mode: JOURNAL_FILE_MODE });
  fs.chmodSync(tmp, JOURNAL_FILE_MODE);
  const fd = fs.openSync(tmp, "r+");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

/** A bounded journal serializer: bigints serialize to their hex string (0x…)
 * so every later `BigInt(...)` in the reader parses them back exactly. */
function bigintSafe(value) {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? "0x" + v.toString(16) : v)));
}

/** Unreadable or malformed journal content: an operational failure (exit 9). */
export class JournalJournalDirErrors extends Error {
  exitCode = 9;
}
class Journal {
  constructor(dir) {
    this.dir = path.resolve(dir);
  }

  /** Create (if needed) and enforce the restrictive directory permission. */
  static ensure(dir) {
    const journal = new Journal(dir);
    try {
      fs.mkdirSync(journal.dir, { mode: JOURNAL_DIR_MODE });
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
    }
    const st = fs.statSync(journal.dir);
    if (!st.isDirectory()) throw new UsageError(`journal path is not a directory: ${journal.dir}`);
    fs.chmodSync(journal.dir, JOURNAL_DIR_MODE);
    return journal;
  }

  listJobFiles() {
    if (!fs.existsSync(this.dir)) return [];
    return fs.readdirSync(this.dir).filter((f) => f.startsWith("job-") && f.endsWith(".json")).sort();
  }

  loadJob(identity) {
    const file = path.join(this.dir, jobFileSlug(identity));
    let raw;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (err) {
      if (err?.code === "ENOENT") return null;
      throw err;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new JournalJournalDirErrors(`journal file is not readable JSON: ${file}`);
    }
    if (parsed?.format !== JOURNAL_FORMAT) {
      throw new JournalJournalDirErrors(`journal file '${file}' has unknown format ${parsed?.format}`);
    }
    return parsed;
  }

  saveJob(record) {
    writeAtomic(path.join(this.dir, jobFileSlug(record.identity)), JSON.stringify(bigintSafe(record), null, 2));
  }

  loadJobFromFile(fileName) {
    const parsed = JSON.parse(fs.readFileSync(path.join(this.dir, fileName), "utf8"));
    if (parsed?.identity?.chainId == null || parsed?.identity?.action == null) {
      throw new JournalJournalDirErrors(`journal record is missing identity: ${fileName}`);
    }
    return {
      identity: {
        chainId: String(parsed.identity.chainId),
        dao: normalizeAddress(parsed.identity.dao, "dao"),
        mandate: normalizeAddress(parsed.identity.mandate, "mandate"),
        agreementId: normalizeBytes32(parsed.identity.agreementId, "agreement"),
        action: parsed.identity.action,
      },
      record: parsed,
    };
  }

  allJobs() {
    return this.listJobFiles().map((f) => this.loadJobFromFile(f));
  }

  saveEnvironment(env) {
    writeAtomic(path.join(this.dir, JOURNAL_ENV_NAME), JSON.stringify(env, null, 2));
  }

  loadEnvironment() {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, JOURNAL_ENV_NAME), "utf8"));
    } catch (err) {
      if (err?.code === "ENOENT") return null;
      throw err;
    }
  }

  // -- single-worker lock ------------------------------------------------

  static LOCK_INFO_ME() {
    return { pid: process.pid, startedAt: new Date().toISOString(), host: os.hostname() };
  }

  acquireLock(myInfo) {
    const file = path.join(this.dir, JOURNAL_LOCK_NAME);
    let holder = null;
    let fd;
    try {
      fd = fs.openSync(file, "wx", JOURNAL_FILE_MODE);
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      try {
        holder = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {
        holder = { pid: "?", startedAt: "?" };
      }
      if (typeof holder?.pid !== "number") throw new LockBusy(holder);
      try {
        process.kill(holder.pid, 0); // live holder?
        throw new LockBusy(holder);
      } catch (kErr) {
        if (kErr instanceof LockBusy) throw kErr;
        if (kErr?.code === "ESRCH") {
          throw new LockStale(
            `journal lock file ${file} names pid ${holder.pid} which is no longer running — ` +
              `refusing until the operator explicitly passes --reclaim`,
          );
        }
        // EPERM/others: process alive but unreffable — treat as still held.
        throw new LockBusy(holder);
      }
    }
    try {
      fs.writeSync(fd, JSON.stringify(myInfo));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return file;
  }

  releaseLock(myInfo) {
    const file = path.join(this.dir, JOURNAL_LOCK_NAME);
    try {
      const holder = JSON.parse(fs.readFileSync(file, "utf8"));
      if (holder?.pid === myInfo?.pid) fs.unlinkSync(file);
    } catch {
      // leave a foreign lock file alone
    }
  }

  /** Reclaim an already-dead holder's lock. Refuses a live holder. */
  reclaimLock(myInfo) {
    const file = path.join(this.dir, JOURNAL_LOCK_NAME);
    let holder = null;
    try {
      holder = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      throw new LockBusy({ pid: "?", startedAt: "?" });
    }
    if (typeof holder?.pid === "number") {
      try {
        process.kill(holder.pid, 0);
        throw new LockBusy(holder); // still alive: never steal
      } catch (kErr) {
        if (kErr instanceof LockBusy) throw kErr;
        if (kErr?.code !== "ESRCH") throw kErr;
      }
    }
    fs.unlinkSync(file);
    return this.acquireLock(myInfo);
  }
}

export { Journal };

// ---------------------------------------------------------------------------
// JSON-RPC client (loopback http only, bounded timeout, no retries inside)
// ---------------------------------------------------------------------------

export function isLoopbackHost(host) {
  if (!host) return false;
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h === "::1" || h === "[::1]") return true;
  if (/^127(\.\d+){3}$/.test(h)) return true;
  return false;
}

export class RpcClient {
  constructor(url, { timeoutMs = 10_000 } = {}) {
    const parsed = new URL(typeof url === "string" ? url : String(url));
    if (parsed.protocol !== "http:") {
      throw new UsageError(`RPC must be a plain http:// URL: ${url}`);
    }
    if (!isLoopbackHost(parsed.hostname)) {
      throw new UsageError(
        `RPC host must be loopback (127.x / ::1 / localhost): got '${parsed.hostname}' — ` +
          `this worker never reaches a public or non-loopback network`,
      );
    }
    this.url = parsed.toString();
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
  }

  async request(method, params = []) {
    const controller = new AbortController();
    const id = ++this.nextId; // bound BEFORE awaiting, so concurrent ids match
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: controller.signal,
      });
      if (!res.ok) throw new TransientRpcError(`rpc ${method}: http ${res.status}`);
      let body;
      try {
        body = await res.json();
      } catch {
        throw new TransientRpcError(`rpc ${method}: unparsable body`);
      }
      if (body.jsonrpc !== "2.0" || body.id !== id) {
        throw new TransientRpcError(`rpc ${method}: jsonrpc 2.0 discipline broken (id mismatch)`);
      }
      if (body.error != null) {
        const err = new Error(body.error.message ?? "rpc error");
        err.data = body.error.data;
        err.code = body.error.code;
        throw err;
      }
      return body.result;
    } catch (err) {
      if (err?.name === "AbortError") {
        const wrapped = new TransientRpcError(`rpc ${method}: timed out after ${this.timeoutMs} ms`);
        throw wrapped;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

export class TransientRpcError extends Error {
  exitCode = 9;
  constructor(msg) {
    super(msg);
    this.isTransient = true;
  }
}

// ---------------------------------------------------------------------------
// Revert-reason decoding (bounded: only named onchain errors are interpreted;
// anything unknown stays an unknown and never maps to eligible/legacy)
// ---------------------------------------------------------------------------

export function revertNameOf(errLike) {
  const data = typeof errLike?.data === "string" ? errLike.data : typeof errLike?.message === "string" ? errLike.message : "";
  const hex = data.toLowerCase().replace(/^0x/, "").replace(/.*data: /, "");
  const sig = hex.slice(0, 8);
  if (sig === ERROR_SELECTOR_IDS.unknownAgreement) return "UnknownAgreement";
  if (sig === ERROR_SELECTOR_IDS.inChallengeWindow) return "InChallengeWindow";
  return null;
}

export function describeCallFailure(err) {
  const name = revertNameOf(err);
  return name ? `${name}` : `${err?.message ?? "no reason"}`;
}

// ---------------------------------------------------------------------------
// Environment identity binding (LOOPBACK ANVIL ONLY)
// ---------------------------------------------------------------------------

/**
 * Require an anvil-only, loopback-only environment and return the fingerprint
 * material: chainId, instanceId, genesis hash, clientVersion, fork provenance,
 * plus a stable fingerprint digest. Re-run against a different environment →
 * fingerprint change → `environment-changed` (the journal never rebinds).
 */
export async function readEnvironmentIdentity(rpc) {
  const meta = await rpc.request("anvil_metadata", []).catch((err) => {
    throw new EnvironmentChanged(`RPC does not answer anvil_metadata (${err.message}) — loopingback-fixture enforcement: refuse non-anvil endpoints`);
  });
  if (meta == null || typeof meta !== "object") {
    throw new EnvironmentChanged("anvil_metadata gave no object — not an anvil endpoint");
  }
  if (typeof meta.instanceId !== "string" || meta.instanceId.length !== 66) {
    throw new EnvironmentChanged(`anvil_metadata.instanceId unusable: ${JSON.stringify(meta.instanceId)}`);
  }
  const chainIdHex = await rpc.request("eth_chainId").catch((err) => {
    throw new EnvironmentChanged(`cannot read eth_chainId: ${err.message}`);
  });
  const chainId = hexToBig(chainIdHex);
  if (meta.chainId !== Number(chainId)) {
    throw new EnvironmentChanged(`chainId disagreement: eth_chainId=${chainId} anvil_metadata=${meta.chainId}`);
  }
  const genesis = await rpc.request("eth_getBlockByNumber", ["0x0", false]).catch((err) => {
    throw new EnvironmentChanged(`cannot read genesis block: ${err.message}`);
  });
  if (genesis == null || typeof genesis.hash !== "string" || genesis.hash.length !== 66) {
    throw new EnvironmentChanged("genesis block hash unusable");
  }
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({
      chainId: chainId.toString(),
      clientVersion: meta.clientVersion ?? null,
      forkedNetwork: meta.forkedNetwork ?? null,
      instanceId: meta.instanceId,
      genesisHash: genesis.hash,
    }))
    .digest("hex");
  return {
    chainId: chainId.toString(),
    clientVersion: meta.clientVersion ?? null,
    instanceId: meta.instanceId,
    genesisHash: genesis.hash,
    forkedNetwork: meta.forkedNetwork ?? null,
    fingerprint,
  };
}

// ---------------------------------------------------------------------------
// Fixture signer (well-known anvil accounts only; cast-based offline signing)
// ---------------------------------------------------------------------------

export class FixtureSigner {
  constructor(privateKeyHex) {
    const key = typeof privateKeyHex === "string" ? privateKeyHex.trim() : "";
    if (!/^(0x)?[0-9a-fA-F]{64}$/.test(key)) {
      throw new UsageError(
        "--fixture-key must be a 32-byte hex private key (an explicit well-known anvil fixture signer)",
      );
    }
    this.keyHex = key.startsWith("0x") ? key : "0x" + key;
    this._address = null;
  }

  /** Derive the address offline with cast, then verify against the known set. */
  ensureWellknown() {
    if (this._address) return this._address;
    const withKnown = WELLKNOWN_ANVIL_KEYS[this.keyHex.toLowerCase()];
    const result = spawnSync("cast", ["wallet", "address", this.keyHex], { encoding: "utf8" });
    if (result.error || result.status !== 0) {
      throw new UsageError(
        `cast wallet address failed: ${result.stderr?.trim() || result.error?.message || "cast not on PATH?"}`,
      );
    }
    const address = result.stdout.trim().toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(address)) {
      throw new UsageError(`cast wallet address gave a non-address: '${result.stdout.trim()}'`);
    }
    if (!WELLKNOWN_ANVIL_ADDRESSES.includes(address)) {
      throw new UsageError(
        `--fixture-key derives ${address}, which is NOT one of the well-known anvil dev accounts — ` +
          `refusing to sign (no arbitrary keys, no stored wallets, no .env)`,
      );
    }
    if (withKnown && withKnown !== address) {
      throw new UsageError("--fixture-key does not match the recorded derivation for a known key");
    }
    this._address = address;
    return address;
  }

  /**
   * Sign a LEGACY transaction fully offline with `cast mktx`: all fields are
   * supplied (nonce/gas-price/gas-limit/value/chain), no RPC fetch. Returns
   * the exact raw bytes cast produced. Local keccak of the raw bytes gives
   * the tx hash that later confirms receipt-based reconciliation.
   */
  signLegacyTransaction({ to, data, value = 0n, nonce, gasLimit, gasPrice, chainId }) {
    const args = [
      "mktx",
      to,
      data,
      // (the mktx CLI accepts raw 0x calldata in the [SIG] slot — verified
      // against `cast mktx --help` and against a live anvil in the tests)
      "--private-key", this.keyHex,
      "--nonce", String(nonce),
      "--gas-price", gasPrice.toString(),
      "--gas-limit", String(gasLimit),
      "--value", value.toString(),
      "--chain", String(chainId),
      "--legacy",
    ];
    const result = spawnSync("cast", args, { encoding: "utf8" });
    if (result.status !== 0 || result.error) {
      throw new Error(`cast mktx failed: ${result.stderr?.trim() || result.stdout?.trim() || result.error?.message}`);
    }
    const raw = result.stdout.trim();
    if (!/^0x[0-9a-f]+$/.test(raw)) throw new Error(`cast mktx printed unusable raw tx: '${raw.slice(0, 80)}…'`);
    return { raw, hash: keccakRaw(raw) };
  }
}

/** keccak-256 of a raw signed tx, via the repo's existing noble dep. */
export function keccakRaw(rawHex) {
  const hex = rawHex.toLowerCase().replace(/^0x/, "");
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return "0x" + bytesToHex(keccak_256(bytes));
}

// ---------------------------------------------------------------------------
// Onchain read model — ABI shapes of the candidate contracts
//
// These decode tables are bound ONLY where the compiled candidate artifact
// proves them: the integration test reads `contracts/out/*.json` and asserts
// the shapes below match the freshly compiled ABI byte-for-byte before any
// result is trusted. Phase B is adding forms (correction requests, review
// readiness, per-attempt deadlines on the claim) — until the API freezes,
// this worker deliberately binds NOTHING about shapes it has not proven:
// a failed read is an unknown, a revert is an unknown, and neither is ever
// inferred into "legacy" or "eligible".
// ---------------------------------------------------------------------------

export const ABI = {
  // TreasuryMandate.agreements(bytes32) — struct fields in declaration order
  // (read back verbatim from the compiled candidate artifact — the integration
  // test asserts this table against the fresh ABI before anything trusts it):
  //   projectId, beneficiary, shares, criteriaHash, policyRef, acceptedAt,
  //   reviewPeriod (Phase B: the per-attempt review period, bound at accept),
  //   workDeadline, revisionDeadline, claimId, terminalKind, attempts, splitHash.
  AGREEMENTS: {
    types: [
      "bytes32", // projectId
      "address", // beneficiary
      "uint128", // shares
      "bytes32", // criteriaHash
      "bytes32", // policyRef
      "uint64", // acceptedAt
      "uint64", // reviewPeriod (Phase B: bound review period for the attempt)
      "uint64", // workDeadline
      "uint64", // revisionDeadline
      "bytes32", // claimId
      "uint8", // terminalKind
      "uint32", // attempts
      "bytes32", // splitHash
    ],
  },
  // ClaimStake.claims(bytes32) — struct fields in declaration order.
  CLAIMS: {
    types: [
      "address", // contributor
      "uint256", // amount
      "uint256", // stake
      "uint8", // status
      "bytes32", // evidenceHash
      "bytes32", // checkHash
      "uint64", // expiresAt
      "uint64", // releasedAt
    ],
  },
  // ClaimStake.claimTerms(bytes32)
  CLAIM_TERMS: { types: ["address", "uint256", "bytes32", "uint8"] },
};

/**
 * `TreasuryMandate.splits(bytes32)` is the public getter of the `Splits`
 * struct, and Solidity omits array members from such a getter: it answers the
 * declared party COUNT only. The parties/percentages themselves are not
 * readable from storage, so the worker reads the recipients and portions from
 * the mandate's own `settleAgreement(agreementId)` simulated from the DAO (see
 * `deriveExpectedSettlement`) and cross-checks that answer against this count,
 * the agreement's beneficiary and the reserved quantity.
 */

/** Read helpers; every read is one eth_call then a strict decode. */
export class ChainReader {  constructor(rpc) {
    this.rpc = rpc;
  }

  async ethCall(to, data, from) {
    return await this.rpc.request("eth_call", [
      { to: to.toLowerCase(), data, ...(from ? { from: from.toLowerCase() } : {}) },
      "latest",
    ]);
  }

  async getCode(address) {
    return (await this.rpc.request("eth_getCode", [address.toLowerCase(), "latest"])) ?? "0x";
  }

  /** Call and decode a single uint256 return (bounded to one word). */
  async callSingleUint(contract, signature, types, args, from) {
    const { result } = await this._rawCall(contract, signature, types, args, from);
    if (result.startsWith("0x") && result !== "0x" && result.length !== 66) {
      throw new Error(`${signature}: expected a single word, got ${result.length - 2} hex chars`);
    }
    return hexToBig(result);
  }

  async callSingleAddress(contract, signature, types, args, from) {
    const { result } = await this._rawCall(contract, signature, types, args, from);
    return decodeAddressWord(result);
  }

  async callSingleBool(contract, signature, types, args, from) {
    const ret = await this.callSingleUint(contract, signature, types, args, from);
    if (ret !== 0n && ret !== 1n) throw new Error(`${signature}: bool word should be 0 or 1, got ${ret}`);
    return ret === 1n;
  }

  async _rawCall(contract, signature, types, args, from) {
    const data = encodeFunctionData(signature, types, args);
    return { data, result: await this.ethCall(contract, data, from) };
  }

  async claimTerms(claims, claimId, from) {
    const arr = await this._decode(claims, SIG.claimTerms, ["bytes32"], [claimId], ABI.CLAIM_TERMS.types, from);
    return { contributor: arr[0], amount: arr[1], checkHash: arr[2], status: Number(arr[3]) };
  }

  async claimStruct(claims, claimId, from) {
    const arr = await this._decode(claims, SIG.claimStruct, ["bytes32"], [claimId], ABI.CLAIMS.types, from);
    return {
      contributor: arr[0],
      amount: arr[1],
      stake: arr[2],
      status: Number(arr[3]),
      evidenceHash: arr[4],
      checkHash: arr[5],
      expiresAt: arr[6],
      releasedAt: arr[7],
    };
  }

  async agreementRecord(mandate, agreementId, from) {
    const arr = await this._decode(mandate, SIG.agreements, ["bytes32"], [agreementId], ABI.AGREEMENTS.types, from);
    return {
      projectId: arr[0],
      beneficiary: arr[1],
      shares: arr[2],
      criteriaHash: arr[3],
      policyRef: arr[4],
      acceptedAt: arr[5],
      reviewPeriod: arr[6], // Phase B: the bound per-attempt review period
      workDeadline: arr[7],
      revisionDeadline: arr[8],
      claimId: arr[9],
      terminalKind: Number(arr[10]),
      attempts: Number(arr[11]),
      splitHash: arr[12],
    };
  }

  async _decode(contract, signature, argTypes, args, outTypes, from) {
    const { result } = await this._rawCall(contract, signature, argTypes, args, from);
    return decodeParameters(outTypes, result);
  }

  // ---- contract identity getters ----

  mandateDao(mandate, from) {
    return this.callSingleAddress(mandate, SIG.mandateDao, [], [], from);
  }
  mandateClaims(mandate, from) {
    return this.callSingleAddress(mandate, SIG.mandateClaims, [], [], from);
  }
  mandateVerifiers(mandate, from) {
    return this.callSingleAddress(mandate, SIG.mandateVerifiers, [], [], from);
  }
  mandateCurrency(mandate, from) {
    return this.callSingleAddress(mandate, SIG.mandateCurrency, [], [], from);
  }
  claimsTreasury(claims, from) {
    return this.callSingleAddress(claims, SIG.claimsTreasury, [], [], from);
  }
  claimsVerifiers(claims, from) {
    return this.callSingleAddress(claims, SIG.claimsVerifiers, [], [], from);
  }
  mandateFactory(votingWeight, from) {
    return this.callSingleAddress(votingWeight, SIG.mandateFactory, [], [], from);
  }
  daoShares(dao, from) {
    return this.callSingleAddress(dao, SIG.daoShares, [], [], from);
  }
  daoVotingWeight(dao, from) {
    return this.callSingleAddress(dao, SIG.daoVotingWeight, [], [], from);
  }
  factoryDaosOf(factory, mandate, from) {
    return this.callSingleAddress(factory, SIG.factoryDaos, ["address"], [mandate], from);
  }
  verifierQuorum(verifiers, from) {
    return this.callSingleUint(verifiers, SIG.verifierQuorum, [], [], from);
  }
  aggregatorNum(mandate, signature, args = null, types = null, from) {
    return this.callSingleUint(mandate, signature, types ?? args.map(() => "bytes32"), args ?? [], from);
  }
  agreementsVersion(mandate, from) {
    return this.callSingleUint(mandate, SIG.agreementsVersion, [], [], from);
  }
  contributionAwarded(mandate, claimId, from) {
    return this.callSingleBool(mandate, SIG.contributionAwarded, ["bytes32"], [claimId], from);
  }
  mandateClosed(mandate, from) {
    return this.callSingleBool(mandate, SIG.mandateClosed, [], [], from);
  }
  mandateSharesAwardedNum(mandate, from) {
    return this.callSingleUint(mandate, SIG.mandateSharesAwarded, [], [], from);
  }
  sharesReservedFor(mandate, projectId, from) {
    return this.callSingleUint(mandate, SIG.sharesReserved, ["bytes32"], [projectId], from);
  }
  challengeWindowFor(claims, from) {
    return this.callSingleUint(claims, SIG.challengeWindow, [], [], from);
  }
  splitRecord(mandate, agreementId, from) {
    return this.callSingleUint(mandate, SIG.splits, ["bytes32"], [agreementId], from).then((count) => {
      if (count > BigInt(SPLIT_MAX_PARTIES)) {
        throw new Error(`splits(bytes32) count ${count} exceeds the declared max ${SPLIT_MAX_PARTIES}`);
      }
      return { count: Number(count) };
    });
  }
  agreementOfClaimOf(mandate, claimId, from) {
    return this._decode(mandate, SIG.agreementOfClaim, ["bytes32"], [claimId], ["bytes32"], from).then((r) => r[0]);
  }
  /**
   * The mandate's own settlement answer: `settleAgreement(agreementId)`
   * simulated FROM THE DAO (the only caller that path accepts) against current
   * state. Read-only, and the recipient/portion list is the contract's, never a
   * caller-supplied one.
   */
  simulatedSettlement(mandate, dao, agreementId) {
    return this._decode(
      mandate,
      SIG.mandateSettleAgreement,
      ["bytes32"],
      [agreementId],
      [{ array: "address" }, { array: "uint256" }],
      dao,
    ).then(([parties, portions]) => ({ parties, portions }));
  }

  // ---- ERC-20, for expected-effects verification ----

  erc20BalanceOf(token, holder) {
    return this.callSingleUint(token, "balanceOf(address)", ["address"], [holder], undefined);
  }
  erc20TotalSupply(token) {
    return this.callSingleUint(token, "totalSupply()", [], [], undefined);
  }

  // ---- log parsing helpers ----

  extractTransferMints(receiptLogs, tokenAddress) {
    const out = [];
    for (const log of receiptLogs ?? []) {
      if (log?.address?.toLowerCase() === tokenAddress.toLowerCase() && log?.topics?.[0] === TRANSFER_TOPIC) {
        if (log.topics?.[1] === ZERO_BYTES32) {
          out.push({
            to: decodeAddressWord(log.topics[2]),
            amount: hexToBig(log.data),
          });
        }
      }
    }
    return out;
  }

  findClaimReleasedLog(receiptLogs, claimsAddress, claimId) {
    for (const log of receiptLogs ?? []) {
      if (log?.address?.toLowerCase() === claimsAddress.toLowerCase() && log?.topics?.[0] === CLAIM_RELEASED_TOPIC) {
        if ((log.topics?.[1] ?? "").toLowerCase() === claimId.toLowerCase()) return log;
      }
    }
    return null;
  }

  findAgreementSettledLog(receiptLogs, mandateAddress, agreementId) {
    for (const log of receiptLogs ?? []) {
      if (log?.address?.toLowerCase() === mandateAddress.toLowerCase() && log?.topics?.[0] === AGREEMENT_SETTLED_TOPIC) {
        if ((log.topics?.[1] ?? "").toLowerCase() === agreementId.toLowerCase()) return log;
      }
    }
    return null;
  }
}

function decodeAddressWord(hexRet) {
  const hex = (hexRet ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(hex)) throw new Error(`address return unusable: '${hexRet}'`);
  const word = hex.slice(2);
  if (word.slice(0, 24) !== "000000000000000000000000") {
    throw new Error(`address word has non-zero high bytes: ${hex}`);
  }
  return "0x" + word.slice(24);
}

// ---------------------------------------------------------------------------
// Provenance binding — read fresh before EVERY transaction step
// ---------------------------------------------------------------------------

/**
 * Read and verify the full provenance chain for one job: the mandate's own
 * identity (AGREEMENTS_VERSION exists, dao linkage, claims and verifiers
 * wiring), the claims' escrow wiring (treasury == mandate, verifiers == the
 * mandate's panel), the currency has code, and the DAO provenance walk
 * (votingWeight → mandateFactory → daos(mandate) == dao) — the exact path
 * Moloch.settleAgreement checks onchain. Verifier quorum must be > 0.
 */
export async function readProvenance(reader, { identity, fixtureAddress }) {
  const { dao, mandate } = identity;
  for (const [what, addr] of [["mandate", mandate], ["dao", dao]]) {
    const code = await reader.getCode(addr);
    if (!code || code === "0x") throw new BlockedJob("missing-code", `${what} ${addr} has no contract code`);
  }

  // Capability marker: the ONLY accepted answer is the public
  // `AGREEMENTS_VERSION() == 1`. Anything else — a revert (a mandate that
  // predates the flow), or a value that is not 1 — is an unknown or an
  // unsupported surface. It is NEVER read as "legacy" and never as
  // "supports it with nothing in it": the operator decides what to do.
  const version = await reader.agreementsVersion(mandate, fixtureAddress).catch((err) => {
    throw new BlockedJob(
      "unknown-contract-read",
      `mandate ${mandate} does not answer ${SIG.agreementsVersion} (capability unknown, never inferred ` +
        `legacy): ${describeCallFailure(err)}`,
    );
  });
  if (version !== 1n) {
    throw new BlockedJob(
      "unknown-contract-read",
      `AGREEMENTS_VERSION() = ${version}; this worker only speaks version 1 (nothing else is ` +
        `eligible, and nothing else is labelled legacy)`,
    );
  }

  const mandateDao = await reader.mandateDao(mandate, fixtureAddress);
  if (mandateDao !== dao) {
    throw new BlockedJob("provenance-mismatch", `mandate.dao() = ${mandateDao}, expected job dao ${dao}`);
  }
  const claimsAddr = await reader.mandateClaims(mandate, fixtureAddress);
  const verifiersAddr = await reader.mandateVerifiers(mandate, fixtureAddress);
  if (claimsAddr === ZERO_ADDRESS || verifiersAddr === ZERO_ADDRESS) {
    throw new BlockedJob("unknown-contract-read", "mandate names a zero claims/verifiers address");
  }
  const claimsTreasury = await reader.claimsTreasury(claimsAddr, fixtureAddress);
  if (claimsTreasury !== mandate) {
    throw new BlockedJob("provenance-mismatch", `claims.treasury() = ${claimsTreasury}, expected mandate ${mandate}`);
  }
  const claimsVerifiers = await reader.claimsVerifiers(claimsAddr, fixtureAddress);
  if (claimsVerifiers !== verifiersAddr) {
    throw new BlockedJob("provenance-mismatch", `claims.verifiers() = ${claimsVerifiers}, expected ${verifiersAddr}`);
  }
  const currency = await reader.mandateCurrency(mandate, fixtureAddress);
  const curCode = await reader.getCode(currency);
  if (!curCode || curCode === "0x") {
    throw new BlockedJob("missing-code", `mandate currency ${currency} has no code`);
  }

  // DAO-facing provenance: exactly what Moloch.settleAgreement checks.
  let sharesToken = null, votingWeight = null, factoryAddr = null, factoryDaos = null;
  try {
    votingWeight = await reader.daoVotingWeight(dao, fixtureAddress);
    if (votingWeight === ZERO_ADDRESS) throw new Error("dao.votingWeight() is 0");
    sharesToken = await reader.daoShares(dao, fixtureAddress);
    if (sharesToken === ZERO_ADDRESS) throw new Error("dao.shares() is 0");
    factoryAddr = await reader.mandateFactory(votingWeight, fixtureAddress);
    if (factoryAddr === ZERO_ADDRESS) throw new Error("policy.mandateFactory() is 0");
    factoryDaos = await reader.factoryDaosOf(factoryAddr, mandate, fixtureAddress);
  } catch (err) {
    throw new BlockedJob("unknown-contract-read", `DAO provenance walk failed: ${describeCallFailure(err)}`);
  }
  if (factoryDaos.toLowerCase() !== dao.toLowerCase()) {
    throw new BlockedJob(
      "provenance-mismatch",
      `mandateFactory(${factoryAddr}).daos(${mandate}) = ${factoryDaos}, expected dao ${dao}`,
    );
  }

  const closed = await reader.mandateClosed(mandate, fixtureAddress);
  const verifierQuorum = await reader.verifierQuorum(verifiersAddr, fixtureAddress);

  return {
    dao,
    mandate,
    agreementsVersion: version.toString(),
    claimsAddr,
    verifiersAddr,
    currencyAddr: currency,
    sharesToken,
    mandateClosed: closed,
    verifierQuorum,
    factoryAddr,
  };
}

// ---------------------------------------------------------------------------
// Action gating
// ---------------------------------------------------------------------------

/**
 * Decide whether `ClaimStake.settle(claimId)` may be sent to START a verified
 * APPROVAL window. Snapshot-relative (mirrors ask ClaimStake.settle), and
 * explicit about the absence of a rejection quorum: no onchain path here
 * ever causes a slash. Returns {decision:'proceed', evidence} or throws
 * BlockedJob.
 */
export async function evaluateStartWindow(reader, { identity, fixtureAddress, agreement, provenance }) {
  const claimId = agreement.claimId;
  if (claimId === ZERO_BYTES32) {
    throw new BlockedJob("no-submission-bound", "the agreement record has no claim bound yet");
  }
  const terms = await reader.claimTerms(provenance.claimsAddr, claimId, fixtureAddress).catch((err) => {
    throw new BlockedJob("unknown-contract-read", `claimTerms(${claimId}): ${describeCallFailure(err)}`);
  });
  if (terms.status !== CLAIM_STATUS.Open) {
    const statusName = statusNameOf(terms.status);
    if (terms.status === CLAIM_STATUS.Approved) {
      throw new BlockedJob(
        "claim-already-approved",
        `claim ${claimId} is already Approved — the challenge window is running or over; nothing to settle`,
      );
    }
    throw new BlockedJob(
      "claim-not-open",
      `claim ${claimId} status is ${statusName} — settle only STARTS a window from Open; ` +
        `this attempt is terminal/frozen so the agreement's own release path applies instead`,
    );
  }
  if (terms.contributor.toLowerCase() !== agreement.beneficiary.toLowerCase()) {
    throw new BlockedJob(
      "claim-not-beneficiaries",
      `claim contributor ${terms.contributor} is not the agreement beneficiary ${agreement.beneficiary}`,
    );
  }
  if (terms.checkHash.toLowerCase() !== agreement.criteriaHash.toLowerCase()) {
    throw new BlockedJob(
      "claim-check-hash-mismatch",
      `claim checkHash ${terms.checkHash} != agreement criteriaHash ${agreement.criteriaHash}`,
    );
  }
  if (terms.amount !== 0n) {
    throw new BlockedJob(
      "claim-asks-currency",
      `the bound claim asks ${terms.amount} currency; the agreed-reward path settles Shares, not currency — ` +
        `paid work runs the mandate's milestone path beside this one and the finalizer must not touch it`,
    );
  }

  // Snapshot-relative quorum, exactly as ClaimStake.settle applies it.
  const [approvals, approvalsAtSubmit, objections, objectionsAtSubmit] = await Promise.all([
    reader.callSingleUint(provenance.verifiersAddr, SIG.approvalCount, ["bytes32"], [claimId], fixtureAddress),
    reader.callSingleUint(provenance.claimsAddr, SIG.approvalsAtSubmit, ["bytes32"], [claimId], fixtureAddress),
    reader.callSingleUint(provenance.verifiersAddr, SIG.objectionCount, ["bytes32"], [claimId], fixtureAddress),
    reader.callSingleUint(provenance.claimsAddr, SIG.objectionsAtSubmit, ["bytes32"], [claimId], fixtureAddress),
  ]);
  const approvalDelta = approvals >= approvalsAtSubmit ? approvals - approvalsAtSubmit : 0n;
  const objectionDelta = objections >= objectionsAtSubmit ? objections - objectionsAtSubmit : 0n;

  if (provenance.verifierQuorum === 0n) {
    throw new BlockedJob("verifier-quorum-zero", "the panel's configured quorum is zero — refuse");
  }
  if (objectionDelta >= provenance.verifierQuorum) {
    throw new BlockedJob(
      "objection-quorum-reached",
      `objection quorum reached (post-submit ${objectionDelta} >= ${provenance.verifierQuorum}) — ` +
        `settle would slash; resolution belongs to the mandate's dispute path, the worker never causes it`,
    );
  }
  if (approvalDelta < provenance.verifierQuorum) {
    throw new BlockedJob(
      "approval-quorum-not-reached",
      `approval quorum not reached (post-submit ${approvalDelta} < ${provenance.verifierQuorum}) — the window cannot start on this attempt`,
    );
  }
  if (objectionDelta !== 0n) {
    throw new BlockedJob(
      "objections-pending",
      `${objectionDelta} objection(s) are pending on the attempt and the panel has not reached approval ` +
        `unanimity — resolve the corrections route before settling`,
    );
  }

  return {
    evidence: {
      claims: provenance.claimsAddr,
      claimId,
      claimStatus: CLAIM_STATUS.Open,
      approvals: approvals.toString(),
      approvalsAtSubmit: approvalsAtSubmit.toString(),
      approvalDelta: approvalDelta.toString(),
      objections: objections.toString(),
      objectionsAtSubmit: objectionsAtSubmit.toString(),
      objectionDelta: objectionDelta.toString(),
      quorum: provenance.verifierQuorum.toString(),
    },
  };
}

/**
 * Decide whether `Moloch.settleAgreement(mandate, agreementId)` may be sent.
 * Derives the expected recipients and amounts from the record + split
 * getters, reads claim/window state, and binds the pre-tx share balances and
 * total supply.
 */
export async function evaluateSettleAgreement(reader, { identity, fixtureAddress, agreement, provenance }) {
  if (agreement.terminalKind !== TERMINAL_KIND.ACTIVE) {
    throw new BlockedJob(
      "agreement-already-terminal",
      `agreement terminalKind is ${agreement.terminalKind} (1=settled, 2=cancelled, 3=expired)`,
    );
  }
  if (agreement.acceptedAt === 0n) {
    throw new BlockedJob("agreement-not-accepted", "acceptedAt is 0 — a draft reserves nothing");
  }
  const claimId = agreement.claimId;
  if (claimId === ZERO_BYTES32) {
    throw new BlockedJob("no-submission-bound", "the agreement record has no claim bound yet");
  }
  const terms = await reader.claimTerms(provenance.claimsAddr, claimId, fixtureAddress).catch((err) => {
    throw new BlockedJob("unknown-contract-read", `claimTerms(${claimId}): ${describeCallFailure(err)}`);
  });
  if (terms.status !== CLAIM_STATUS.Approved && terms.status !== CLAIM_STATUS.Paid) {
    const statusName = statusNameOf(terms.status);
    throw new BlockedJob(
      "claim-not-approved-or-paid",
      `claim status is ${statusName}; settleAgreement requires an Approved (window elapsed) or Paid claim — ` +
        `run the start-window action first so a verified challenge window starts BEFORE settlement`,
    );
  }
  if (terms.contributor.toLowerCase() !== agreement.beneficiary.toLowerCase()) {
    throw new BlockedJob(
      "claim-not-beneficiaries",
      `claim contributor ${terms.contributor} is not the agreement beneficiary ${agreement.beneficiary}`,
    );
  }
  if (terms.checkHash.toLowerCase() !== agreement.criteriaHash.toLowerCase()) {
    throw new BlockedJob(
      "claim-check-hash-mismatch",
      `claim checkHash ${terms.checkHash} != agreement criteriaHash ${agreement.criteriaHash}`,
    );
  }
  const consumed = await reader.contributionAwarded(provenance.mandate, claimId, fixtureAddress);
  if (consumed) {
    throw new BlockedJob(
      "claim-already-consumed",
      `the claim's delivery is already recorded as consumed on this mandate — one delivery, one reward`,
    );
  }

  // For an Approved claim the mandate settles by first finishing the claim
  // (payout), which refuses inside the challenge window. The worker mirrors
  // the same gate explicitly (and the eth_call simulate below re-checks it).
  if (terms.status === CLAIM_STATUS.Approved) {
    const claimStruct = await reader.claimStruct(provenance.claimsAddr, claimId, fixtureAddress).catch((err) => {
      throw new BlockedJob("unknown-contract-read", `claims(${claimId}): ${describeCallFailure(err)}`);
    });
    if (claimStruct.releasedAt === 0n) {
      throw new BlockedJob("window-not-started", "claim is Approved but the challenge window has not started (releasedAt = 0)");
    }
    const challengeWindow = await reader.challengeWindowFor(provenance.claimsAddr, fixtureAddress);
    const head = await reader.rpc.request("eth_getBlockByNumber", ["latest", false]);
    const now = hexToBig(head.timestamp);
    const opensAt = claimStruct.releasedAt + challengeWindow;
    if (now < opensAt) {
      throw new BlockedJob(
        "challenge-window-not-elapsed",
        `window opens at ${opensAt} but chain time is ${now} — the challenge window must run out before settlement`,
      );
    }
  }

  const expected = await deriveExpectedSettlement(reader, {
    mandate: provenance.mandate,
    dao: provenance.dao,
    agreementId: identity.agreementId,
    agreement,
    fixtureAddress,
  });

  // Pre-tx state that the confirmation verifies after the receipt.
  const preSupply = await reader.erc20TotalSupply(provenance.sharesToken);
  const preBalances = {};
  for (const r of expected.recipients) {
    preBalances[r.address.toLowerCase()] = await reader.erc20BalanceOf(provenance.sharesToken, r.address);
  }
  const preMandateSharesAwarded = await reader.mandateSharesAwardedNum(provenance.mandate, fixtureAddress);
  const preSharesReserved = await reader.sharesReservedFor(provenance.mandate, agreement.projectId, fixtureAddress);

  return {
    evidence: {
      claimId,
      claimStatus: terms.status,
      expected,
      preSupply: preSupply.toString(),
      preBalances,
      preMandateSharesAwarded: preMandateSharesAwarded.toString(),
      preSharesReserved: preSharesReserved.toString(),
    },
  };
}

/**
 * Derive the recipients and amounts of the settlement from the AGREED record
 * and the onchain split getters (never from the settleAgreement return — its
 * ABI carries none). Formula as the current mandate code computes it
 * (`portion[i] = shares * pct[i] / 10000`, each floored); the recipients
 * match the split declaration, and the beneficiary is always the first
 * party. If Phase B changes the residual policy, the integration test
 * against the freshly compiled contract drives the alignment — a stale
 * expectation surfaces as observed-mismatch, never as a false success.
 */
export async function deriveExpectedSettlement(reader, { mandate, dao, agreementId, agreement, fixtureAddress }) {
  const split = await reader.splitRecord(mandate, agreementId, fixtureAddress);
  const count = split.count;
  const agreements = agreement;

  // The parties and portions come from the mandate's OWN settlement, simulated
  // from the DAO (the exact call the DAO will make). The `Splits` struct's
  // arrays are not readable through its public getter, so this is the only
  // onchain statement of who is paid what — and it is cross-checked below
  // against the declared count, the agreement beneficiary and the reserved
  // quantity, never taken on trust.
  let simulated;
  try {
    simulated = await reader.simulatedSettlement(mandate, dao, agreementId);
  } catch (err) {
    throw new BlockedJob("unknown-contract-read", `simulating the mandate's settleAgreement(${agreementId}): ${describeCallFailure(err)}`);
  }
  const parties = simulated.parties ?? [];
  const portions = simulated.portions ?? [];
  if (parties.length !== portions.length) {
    throw new BlockedJob("unknown-contract-read", `the settlement names ${parties.length} parties but ${portions.length} portions`);
  }
  const expectedParties = count === 0 ? 1 : count;
  if (parties.length !== expectedParties) {
    throw new BlockedJob(
      "unknown-contract-read",
      `splits(bytes32) declares ${count} split part${count === 1 ? "y" : "ies"} but the settlement pays ` +
        `${parties.length} recipient(s) — the declared terms and the settlement disagree`,
    );
  }
  if (parties.length === 0) {
    throw new BlockedJob("unknown-contract-read", "the settlement names no recipient");
  }
  const beneficiaries_ = agreement.beneficiary;
  if (parties[0].toLowerCase() !== beneficiaries_.toLowerCase()) {
    throw new BlockedJob(
      "provenance-mismatch",
      `the first settlement party ${parties[0]} is not the agreement beneficiary ${beneficiaries_}`,
    );
  }
  const seen = new Set();
  const recipients = [];
  let awardTotal = 0n;
  for (let i = 0; i < parties.length; i++) {
    const party = parties[i];
    const portion = portions[i];
    if (party === ZERO_ADDRESS) {
      throw new BlockedJob("unknown-contract-read", `the settlement names an empty party at index ${i}`);
    }
    if (seen.has(party.toLowerCase())) {
      throw new BlockedJob("unknown-contract-read", `settlement party ${i} repeats an earlier party (${party})`);
    }
    seen.add(party.toLowerCase());
    if (portion <= 0n) {
      throw new BlockedJob("unknown-contract-read", `the settlement pays ${party} a non-positive quantity (${portion})`);
    }
    awardTotal += portion;
    recipients.push({ address: party, portion: portion.toString() });
  }
  if (awardTotal !== agreements.shares) {
    throw new BlockedJob(
      "unknown-contract-read",
      `the settlement's portions sum ${awardTotal} != the reserved shares ${agreements.shares}`,
    );
  }
  return { splitCount: count, recipients, awardTotal: awardTotal.toString() };
}

function statusNameOf(n) {
  return Object.keys(CLAIM_STATUS).find((k) => CLAIM_STATUS[k] === n) ?? `status:${n}`;
}

// ---------------------------------------------------------------------------
// Expected-effect verification (receipt → chain state → `confirmed`)
// ---------------------------------------------------------------------------

/** Verify a mint log list against the derived expectation, strictly. */
export function verifyExpectedMintLogs(mintLogs, expected) {
  if (mintLogs.length !== expected.recipients.length) {
    return {
      ok: false,
      issue: `${mintLogs.length} known mint log(s) but the record names ${expected.recipients.length} recipient(s)`,
    };
  }
  const byAddress = new Map(mintLogs.map((l) => [l.to.toLowerCase(), l]));
  for (const recipient of expected.recipients) {
    const log = byAddress.get(recipient.address.toLowerCase());
    if (!log) return { ok: false, issue: `no mint log to ${recipient.address}` };
    if (log.amount !== BigInt(recipient.portion)) {
      return { ok: false, issue: `mint to ${recipient.address} is ${log.amount}, expected ${recipient.portion}` };
    }
  }
  return { ok: true };
}

/**
 * All post-receipt checks. Throws only on internal errors; a failed
 * verification returns {ok:false, issues} — never a fake success.
 */
export async function verifyEffectsOnchain(reader, { identity, provenance, fixtureAddress, expected, receipt }) {
  const issues = [];
  const notes = [];

  if (expected.kind === "start-window") {
    const terms = await reader.claimTerms(provenance.claimsAddr, expected.claimId, fixtureAddress);
    if (terms.status !== CLAIM_STATUS.Approved) {
      issues.push(
        `claim ${expected.claimId} status is ${statusNameOf(terms.status)}, expected Approved — ` +
          `the settle did not start the window (never "awarded" here)`,
      );
    }
    const struct = await reader.claimStruct(provenance.claimsAddr, expected.claimId, fixtureAddress);
    if (struct.releasedAt === 0n) issues.push("releasedAt is 0 after the settle — the window never started");
    if (!reader.findClaimReleasedLog(receipt.logs, provenance.claimsAddr, expected.claimId)) {
      issues.push("no ClaimReleased log for this claim in the receipt");
    }
    if (issues.length === 0) {
      notes.push(`claim ${expected.claimId} is Approved with releasedAt=${struct.releasedAt}`, "ClaimReleased log present");
    }
    return { ok: issues.length === 0, issues, notes };
  }

  // settle-agreement:
  // (a) the known mint logs: exact recipient/amount rows.
  const mintLogs = reader.extractTransferMints(receipt.logs, provenance.sharesToken);
  const mintCheck = verifyExpectedMintLogs(mintLogs, expected);
  if (!mintCheck.ok) issues.push(mintCheck.issue);
  // (b) the settled event on the mandate record.
  if (!reader.findAgreementSettledLog(receipt.logs, identity.mandate, identity.agreementId)) {
    issues.push("no AgreementSettled event on the mandate for this agreement");
  }
  // (c) terminal state of the agreement record.
  const freshRecord = await reader.agreementRecord(provenance.mandate, identity.agreementId, fixtureAddress);
  if (freshRecord.terminalKind !== TERMINAL_KIND.SETTLED) {
    issues.push(`agreement terminalKind is ${freshRecord.terminalKind}, expected 1 (SETTLED)`);
  }
  // (d) the exact-once latch on the claim. The agreed path's durable record is
  // the per-claim agreement binding written at bind time and kept forever
  // (`agreementOfClaim`): the mandate's discretionary `consumeContribution`
  // refuses any claim that has one, so this is what makes "one delivery, one
  // reward" true onchain. `contributionAwarded` is the discretionary path's own
  // latch and is never set by `settleAgreement`; requiring it here would refuse
  // a correct settlement.
  const boundAgreement = await reader.agreementOfClaimOf(provenance.mandate, expected.claimId, fixtureAddress);
  if (boundAgreement.toLowerCase() !== identity.agreementId.toLowerCase()) {
    issues.push(
      `agreementOfClaim(claimId) is ${boundAgreement}, expected ${identity.agreementId} — the claim's one ` +
        `delivery is not bound to this agreement`,
    );
  }
  // (e) the claim itself: finished (Paid) by the settlement's own payout call.
  const terms = await reader.claimTerms(provenance.claimsAddr, expected.claimId, fixtureAddress);
  if (terms.status !== CLAIM_STATUS.Paid) {
    issues.push(`claim status is ${statusNameOf(terms.status)}, expected Paid after the settlement`);
  }
  // (f) mandate accounting mirrors the reserved quantity.
  if (expected.preMandateSharesAwarded != null) {
    const nowAwarded = await reader.mandateSharesAwardedNum(provenance.mandate, fixtureAddress);
    const delta = nowAwarded - BigInt(expected.preMandateSharesAwarded);
    if (delta !== BigInt(expected.expectedTotal)) {
      issues.push(`mandateSharesAwarded moved by ${delta}, expected +${expected.expectedTotal}`);
    }
  }
  if (expected.preSharesReserved != null) {
    const nowReserved = await reader.sharesReservedFor(provenance.mandate, expected.projectId, fixtureAddress);
    const delta = BigInt(expected.preSharesReserved) - nowReserved;
    if (delta !== BigInt(expected.expectedTotal)) {
      issues.push(`sharesReserved moved by ${delta}, expected -${expected.expectedTotal}`);
    }
  }
  // (g) supply and per-recipient balances, exactly.
  if (expected.preSupply != null) {
    const postSupply = await reader.erc20TotalSupply(provenance.sharesToken);
    const supplyDelta = postSupply - BigInt(expected.preSupply);
    if (supplyDelta !== BigInt(expected.expectedTotal)) {
      issues.push(`shares totalSupply moved by ${supplyDelta}, expected +${expected.expectedTotal}`);
    }
  } else {
    issues.push("journal had no preSupply bound — cannot verify the exact supply delta (a journal defect)");
  }
  for (const r of expected.recipients) {
    const post = await reader.erc20BalanceOf(provenance.sharesToken, r.address);
    const pre = BigInt(expected.preBalances[r.address.toLowerCase()] ?? -1n);
    if (pre === -1n) {
      issues.push(`journal had no pre-balance for ${r.address}`);
      continue;
    }
    const balanceDelta = post - pre;
    if (balanceDelta !== BigInt(r.portion)) {
      issues.push(`balance of ${r.address} moved by ${balanceDelta}, expected +${r.portion}`);
    }
  }
  if (issues.length === 0) {
    notes.push(
      `Transfer mint logs matched ${expected.recipients.length} expected row(s)`,
      `AgreementSettled event present; terminalKind=1; agreementOfClaim binding intact`,
      `shares supply moved exactly +${expected.expectedTotal}`,
    );
  }
  return { ok: issues.length === 0, issues, notes };
}

// ---------------------------------------------------------------------------
// Runner defaults
// ---------------------------------------------------------------------------

export const DEFAULTS = {
  CONFIRM_DEPTH: 1,
  WATCH_INTERVAL_MS: 2_000,
  MAX_ATTEMPTS: 5,
  BACKOFF_BASE_MS: 250,
  RPC_TIMEOUT_MS: 10_000,
  MAX_GAS_LIMIT: "30000000",
  MAX_GAS_PRICE_WEI: 1_000_000_000_000n, // fixture-tier cap (anvil gas is ~1 wei)
  MINIMUM_BALANCE_WEI: 10n ** 15n, // the fixture signer has something left
};

const BROADCAST_TERMINAL = false;
void BROADCAST_TERMINAL;


/**
 * Run the worker once against the bounded job list. Returns
 * {exitCode, jobs: [{identity, state, note}]} — the runner refuses to expose
 * a "success" exit code unless every job ended confirmed; nonterminal
 * (watch timeout), blocked, failed and mismatch states all have dedicated
 * exit codes (see agreement-finalizer.mjs) and never self-clear.
 */
export async function runFinalizer(options) {
  const journalDir = options.journalDir;
  if (!journalDir) throw new UsageError("--journal is required");
  const rawJobs = options.jobs ?? [];
  if (rawJobs.length < 1) throw new UsageError("the operator's --job list is required (at least one --job)");
  // Normalize: the CLI passes back parseJobSpec results (plain identities); the
  // in-process API passes {identity, spec} objects.
  const jobs = rawJobs.map((job) => {
    const identity = job?.identity?.action ? job.identity : job;
    if (!identity?.action) throw new UsageError("jobs must be parsed with parseJobSpec first");
    return { identity, spec: job?.spec ?? null };
  });
  return await runTransactional({ ...options, jobs });
}

const SLEEPABLE_STATES = new Set(["prepared", "submitted"]);

async function runTransactional({
  journalDir, rpcUrl, jobs, fixtureKey, optInFixtureWrites, confirmDepth = DEFAULTS.CONFIRM_DEPTH,
  watch = false, watchTimeoutMs = 120_000, watchIntervalMs = DEFAULTS.WATCH_INTERVAL_MS,
  maxAttempts = DEFAULTS.MAX_ATTEMPTS, backoffBaseMs = DEFAULTS.BACKOFF_BASE_MS,
  reclaim = false, rpcTimeoutMs = DEFAULTS.RPC_TIMEOUT_MS, onLog = (msg) => console.log(msg), fault = readFaultEnv(),
}) {
  if (!optInFixtureWrites) {
    throw new UsageError(
      "--opt-in-fixture-writes is required for every transactional action — this worker only broadcasts " +
        "against an operator-declared local anvil fixture",
    );
  }
  if (!fixtureKey) {
    throw new UsageError(
      "--fixture-key is required: an explicit well-known anvil dev key must be present to sign; " +
        "no stored wallet, no .env sourcing",
    );
  }
  if (!Number.isInteger(confirmDepth) || confirmDepth < 1 || confirmDepth > 1000) {
    throw new UsageError(`--confirm-depth must be an integer in [1,1000]: got ${confirmDepth}`);
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 50) {
    throw new UsageError(`--attempts must be an integer in [1,50]: got ${maxAttempts}`);
  }
  if (!Number.isInteger(backoffBaseMs) || backoffBaseMs < 0 || backoffBaseMs > 60_000) {
    throw new UsageError(`--backoff-ms must be an integer in [0,60000]: got ${backoffBaseMs}`);
  }
  if (!Number.isInteger(rpcTimeoutMs) || rpcTimeoutMs < 50 || rpcTimeoutMs > 300_000) {
    throw new UsageError(`rpcTimeoutMs must be an integer in [50,300000]: got ${rpcTimeoutMs}`);
  }

  const journal = Journal.ensure(journalDir);
  const myInfo = Journal.LOCK_INFO_ME();
  if (reclaim) {
    journal.reclaimLock(myInfo);
  } else {
    journal.acquireLock(myInfo);
  }
  try {
    return await runTransactionalLocked({
      journal, rpcUrl, jobs, fixtureKey, optInFixtureWrites, confirmDepth, watch, watchTimeoutMs,
      watchIntervalMs, maxAttempts, backoffBaseMs, rpcTimeoutMs, onLog, fault,
    });
  } finally {
    journal.releaseLock(myInfo);
  }
}

/**
 * The bounded fault seam for crash/timeout tests: the same crashes the
 * operator's process can experience, injected exactly at the persisted
 * seams. The constructor docs record it; the tests drive it through the
 * real CLI (a real subprocess crash) unless they call runFinalizer
 * in-process.
 */
export function readFaultEnv() {
  const raw = process.env.FINALIZER_TEST_FAULT;
  if (!raw) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  return parsed ?? {};
}

async function runTransactionalLocked(ctx) {
  const { journal, rpcUrl, jobs, fixtureKey, confirmDepth, watch, watchTimeoutMs, watchIntervalMs, maxAttempts, backoffBaseMs, rpcTimeoutMs, onLog, fault } = ctx;
  if (!rpcUrl) throw new UsageError("--rpc is required");

  const signer = new FixtureSigner(fixtureKey);
  const fixtureAddress = signer.ensureWellknown();

  // — environment binding comes first; nothing runs before it —
  const rpc = new RpcClient(rpcUrl, { timeoutMs: rpcTimeoutMs });
  const envIdentity = await readEnvironmentIdentity(rpc);
  const journalEnv = journal.loadEnvironment();
  if (journalEnv && journalEnv.fingerprint !== envIdentity.fingerprint) {
    for (const { identity, record } of await journal.allJobs()) {
      if (record.state && record.state !== "confirmed") {
        const bumped = { ...record, state: "environment-changed" };
        bumped.history = [
          ...(record.history ?? []),
          { at: new Date().toISOString(), to: "environment-changed", note: `fingerprint ${journalEnv.fingerprint} → ${envIdentity.fingerprint}` },
        ];
        journal.saveJob(bumped);
      }
    }
    throw new EnvironmentChanged(
      `the journal is bound to environment fingerprint ${journalEnv.fingerprint} but the live chain has ` +
        `${envIdentity.fingerprint} — a chain reset or a different node; refused (the journal never rebinds). ` +
        `Start a new journal to settle there.`,
    );
  }
  journal.saveEnvironment({
    ...envIdentity,
    boundAt: journalEnv?.boundAt ?? new Date().toISOString(),
    // the operator's provenance markers live in the job records themselves.
  });

  // — register the operator's job list (never scanned; unknown jobs are new —
  //   an identity already in the journal keeps its state) —
  const byId = new Map();
  for (const { identity, spec } of jobs) {
    const slug = jobFileSlug(identity);
    if (byId.has(slug)) throw new UsageError(`the same job appears twice in the run list: '${spec}'`);
    byId.set(slug, identity);
  }
  for (const [slug, identity] of byId.entries()) {
    let record = journal.loadJob(identity);
    if (!record) {
      const now = new Date().toISOString();
      record = {
        format: JOURNAL_FORMAT,
        identity,
        state: "queued",
        createdAt: now,
        updatedAt: now,
        history: [{ at: now, to: "queued", note: "added by the operator's job list" }],
        attempts: [],
        prepared: null,
        expected: null,
        broadcast: null,
        blocked: null,
        failed: null,
        confirmed: null,
      };
      journal.saveJob(record);
      onLog(`[finalizer] added ${describeJobIdentity(identity)} → queued`);
    }
  }

  // — the deadline-bound pass loop (watch) —
  const stopAt = Date.now() + watchTimeoutMs;
  const backing = new Map();
  for (;;) {
    for (const [slug, identity] of byId.entries()) {
      const record = await processOne({ ...ctx, reader: null, rpc, signer, fixtureAddress, identity, confirmDepth, maxAttempts, backoffBaseMs });
      backing.set(slug, { state: record.state, note: noteFor(record) });
    }
    if (!watch || Date.now() >= stopAt || !(await anyInFlight(byId, journal))) {
      break;
    }
    await sleep(Math.max(200, Math.min(watchIntervalMs, stopAt - Date.now())));
  }

  // — exit code: 0 requires every job in `confirmed`; anything else is
  //   explicit and non-self-clearing —
  let exitCode = 0;
  const missingConfirmed = [...backing.values()].filter((v) => v.state !== "confirmed");
  if (missingConfirmed.length === byId.size && byId.size > 0 && [...backing.values()].every((v) => v.state === "")) {
    exitCode = 8; // nothing was processed at all
  }
  for (const { state } of backing.values()) {
    if (state === "environment-changed") exitCode = 4;
    else if (state === "observed-mismatch") exitCode = 5;
    else if (state === "failed") exitCode = 6;
    else if (state === "blocked") exitCode = 7;
    else if (state === "queued" || state === "prepared" || state === "submitted") exitCode = 2;
  }
  return { exitCode, jobs: [...backing.values()] };
}

function journalsBoundEnvSets() {
  return false; // retired: the environment fingerprint gate above is the only binding
}

async function anyInFlight(byId, journalDirOrJobs) {
  for (const identity of byId.values()) {
    const record = await journalDirOrJobs.loadJob(identity);
    if (SLEEPABLE_STATES.has(record?.state ?? "")) return true;
  }
  return false;
}

function noteFor(record) {
  switch (record.state) {
    case "confirmed": return `tx ${record.signedHash ?? "-"} mined at block ${record.confirmed?.blockNumber ?? "?"} with effects verified`;
    case "blocked": return record.blocked?.detail ?? record.blocked?.reason ?? "blocked";
    case "failed": return record.failed?.detail ?? record.failed?.reason ?? "failed";
    case "submitted": return `broadcast accepted (${record.signedHash}), awaiting receipt at the required depth`;
    case "prepared": return `signed raw persisted (hash ${record.signedHash}); not broadcast yet`;
    case "observed-mismatch": return (record.observed?.issues ?? []).join("; ") || "observed-mismatch";
    default: return record.state;
  }
}

// ---------------------------------------------------------------------------
// processOne: the per-job pass (provenance → gate → prepare → broadcast →
// confirm), with the exact-once and recovery discipline
// ---------------------------------------------------------------------------

async function processOne({ journal, rpc, signer, fixtureAddress, identity, confirmDepth, maxAttempts, backoffBaseMs, onLog, fault }) {
  let record = journal.loadJob(identity);
  if (!record) throw new JournalJournalDirErrors(`journal record vanished for ${describeJobIdentity(identity)}`);
  const now = () => new Date().toISOString();

  const toState = async (record, state, note) => {
    const bumped = { ...record, state, updatedAt: now() };
    if (typeof note === "string") {
      bumped.history = [...(bumped.history ?? []), { at: now(), to: state, note }];
    }
    journal.saveJob(bumped);
    onLog(`[finalizer] ${describeJobIdentity(identity)} → ${state}${typeof note === "string" ? ` (${note})` : ""}`);
    return bumpBack(journal, identity, bumped);
  };

  const reader = new ChainReader(rpc);

  if (record.state === "confirmed") {
    return record;
  }
  if (!["queued", "prepared", "submitted", "blocked", "observed-mismatch"].includes(record.state)) {
    // failed / environment-changed / unknown: never self-clear. The operator
    // (or a new journal) decides; no retry record is ever deleted.
    return await toState(record, record.state, "kept; explicit operator action needed");
  }

  // A `reconcile`-able state for an already-mined tx: verification only.
  let provenance;
  let agreement = null;
  try {
    provenance = await readProvenance(reader, { identity, fixtureAddress });
    agreement = await reader.agreementRecord(provenance.mandate, identity.agreementId, fixtureAddress);
  } catch (err) {
    if (err instanceof BlockedJob) {
      const rec = {
        ...record,
        state: "blocked",
        blocked: { reason: err.reason, detail: err.detail ?? "" },
        history: [...(record.history ?? []), { at: now(), to: "blocked", note: `${err.reason}: ${err.detail ?? ""}` }],
      };
      journal.saveJob(rec);
      onLog(`[finalizer] ${describeJobIdentity(identity)} → blocked (${err.reason}: ${err.detail ?? ""})`);
      return journal.loadJob(identity);
    }
    throw err;
  }
  const identity_ = { ...provenance, fixtureAddress };
  try {
    if (record.state === "submitted") {
      return await tryConfirm({ reader, rpc, journal, identity, record, provenance, fixtureAddress, confirmDepth, maxAttempts, backoffBaseMs, toState, onLog });
    }
    if (record.state === "observed-mismatch") {
      // Reconcile-only state: never re-broadcasts. A fresh effects check can
      // clear it to confirmed; anything else keeps it stuck for the operator.
      return await reconcileFromReceiptOnly({ reader, rpc, journal, identity, record, provenance, fixtureAddress, toState, onLog });
    }
    // queued / prepared / blocked — the action path. Conditions are re-read
    // EVERY time (fresh provenance + gate); a previously persisted prepared
    // raw is reused after a digest check (never re-signed).
    if (identity.action === "start-window") {
      const evaluated = await evaluateStartWindow(reader, { identity, fixtureAddress, agreement, provenance });
      await prepareAndBroadcast({ reader, rpc, journal, identity, record, signer, fixtureAddress, provenance, agreement, evaluated, confirmDepth, maxAttempts, backoffBaseMs, toState, onLog, fault });
    } else {
      const evaluated = await evaluateSettleAgreement(reader, { identity, fixtureAddress, agreement, provenance });
      await prepareAndBroadcast({ reader, rpc, journal, identity, record, signer, fixtureAddress, provenance, agreement, evaluated, confirmDepth, maxAttempts, backoffBaseMs, toState, onLog, fault });
    }
    return await bumpBack(journal, identity, journal.loadJob(identity));
  } catch (err) {
    if (err instanceof BlockedJob) {
      const rec = {
        ...record,
        state: "blocked",
        blocked: { reason: err.reason, detail: err.detail ?? "" },
        history: [...(record.history ?? []), { at: now(), to: "blocked", note: `${err.reason}: ${err.detail ?? ""}` }],
      };
      journal.saveJob(rec);
      onLog(`[finalizer] ${describeJobIdentity(identity)} → blocked (${err.reason}: ${err.detail ?? ""})`);
      return journal.loadJob(identity);
    }
    if (err instanceof TransientRpcError) {
      const attempts = [...(record.attempts ?? []), { at: now(), outcome: "transient-rpc-error", detail: err.message }];
      const kept = { ...record, attempts };
      journal.saveJob(kept);
      onLog(`[finalizer] ${describeJobIdentity(identity)} kept at ${record.state} (transient: ${err.message})`);
      return journal.loadJob(identity);
    }
    throw err;
  }
}

function conditionBound(record) {
  if (record.state === "blocked") return record;
  return { ...record };
}

// A transient RPC hiccough never advances the state (and a submitted
// pre-mined swap is never re-broadcast blindly here).

async function bumpBack(journal, identity, record) {
  return journal.loadJob(identity);
}
export async function sleep(ms) {
  return await new Promise((res) => setTimeout(res, Math.min(ms, 60_000)));
}

/**
 * The exact-once heart for an action: build the only allowed calldata,
 * simulate it (eth_call) BEFORE signing, then sign once fully offline, and
 * persist the full prepared record (calldata, nonce, expected effects, the
 * SIGNED RAW TX and its hash) BEFORE the first broadcast. On any later run
 * the very same raw bytes are re-broadcast; a nonce-less retry is refused
 * (nonce-consumed-externally state), never re-signed with a fresh nonce.
 */
export async function prepareAndBroadcast({
  reader, rpc, journal, identity, record, signer, fixtureAddress, provenance, agreement, evaluated,
  confirmDepth, maxAttempts, backoffBaseMs, toState, onLog, fault,
}) {
  // Build the ONLY allowed call, from the fresh reads of the current step.
  if (identity.action !== "start-window" && identity.action !== "settle-agreement") {
    throw new BlockedJob("unknown-action", `action '${identity.action}' is not one of this worker's two allowed call kinds`);
  }
  let to = null;
  let data = null;
  let expected = null;
  if (identity.action === "start-window") {
    to = provenance.claimsAddr;
    data = encodeFunctionData(SIG.settle, ["bytes32"], [evaluated.evidence.claimId]);
    if (evaluated.evidence.claims !== to) {
      throw new BlockedJob("internal-gate-mismatch", `claims address drifted between reads`);
    }
    expected = {
      kind: "start-window",
      claimId: evaluated.evidence.claimId,
      claims: to,
      to,
      data,
      value: "0",
      evidence: evaluated.evidence,
    };
  } else {
    const dao = identity.dao;
    const mandate = identity.mandate;
    const agreementId = identity.agreementId;
    if (provenance.mandate !== mandate) {
      throw new BlockedJob("internal-gate-mismatch", "mandate drifted between reads");
    }
    to = dao;
    data = encodeFunctionData(SIG.daoSettleAgreement, ["address", "bytes32"], [mandate, agreementId]);
    expected = {
      kind: "settle-agreement",
      to,
      data,
      value: "0",
      mandate,
      agreementId,
      recipients: evaluated.evidence.expected.recipients,
      awardTotal: evaluated.evidence.expected.awardTotal,
      preSupply: evaluated.evidence.preSupply,
      preBalances: evaluated.evidence.preBalances,
      preMandateSharesAwarded: evaluated.evidence.preMandateSharesAwarded,
      preSharesReserved: evaluated.evidence.preSharesReserved,
      claimId: evaluated.evidence.claimId,
      projectId: agreement.projectId,
      rcpt: { ...evaluated.evidence },
    };
    expected.expectedTotal = expected.awardTotal;
  }

  // — the exact call, simulated BEFORE signing —
  try {
    await reader.ethCall(to, data, fixtureAddress);
  } catch (err) {
    const name = revertNameOf(err);
    const reason = name
      ? name === "InChallengeWindow" ? "challenge-window-not-elapsed" : `simulate-revert:${name}`
      : "simulate-revert:unknown";
    throw new BlockedJob(reason, `eth_call of ${to} ${SELECTORS.settle === data.slice(0, 10) ? "settle" : "settleAgreement"}: ${describeCallFailure(err)}`);
  }

  // — gas, and the fixture-tier sanity cap —
  const gasHex = await reader.rpc.request("eth_estimateGas", [{ to, data, value: "0x0", from: fixtureAddress }, "latest"]);
  const estGas = (hexToBig(gasHex) * 120n) / 100n + 1000n;
  if (estGas > BigInt(DEFAULTS.MAX_GAS_LIMIT)) {
    throw new BlockedJob("gas-limit-too-high", `estimated gas ${estGas} exceeds the ${DEFAULTS.MAX_GAS_LIMIT} cap`);
  }
  const gasPrice = hexToBig(await reader.rpc.request("eth_gasPrice"));
  if (gasPrice === 0n) throw new BlockedJob("chain-gas-price-zero", "eth_gasPrice is 0 (anvil not ready)");
  if (gasPrice > DEFAULTS.MAX_GAS_PRICE_WEI) {
    throw new BlockedJob("gas-price-too-high", `eth_gasPrice ${gasPrice} exceeds the fixture cap ${DEFAULTS.MAX_GAS_PRICE_WEI} wei`);
  }
  const balance = hexToBig(await reader.rpc.request("eth_getBalance", [fixtureAddress, "latest"]));
  if (balance < DEFAULTS.MINIMUM_BALANCE_WEI) {
    throw new BlockedJob("fixture-signer-underfunded", `fixture signer balance is ${balance}`);
  }

  // — sign ONCE, fully offline (or reuse the already-persisted raw bytes) —
  const chainId = hexToBig(await reader.rpc.request("eth_chainId"));
  let signed;
  const priorPrepared = record.prepared;
  if (priorPrepared?.signedRaw && priorPrepared?.signedHash && priorPrepared?.nonce != null) {
    // A prepared record already exists: verify the derivation digest matches
    // what we would sign NOW; then broadcast the SAME raw bytes. A mismatch
    // (a chain change in between, an ancient record) is refused, never
    // silently re-signed.
    const reDigest = derivationDigestOf(to, data, clarity(priorPrepared.nonce), priorPrepared.chainId);
    if (reDigest !== priorPrepared.callDigest) {
      throw new BlockedJob(
        "prepared-record-mismatch",
        `the persisted signed tx (hash ${priorPrepared.signedHash}, nonce ${priorPrepared.nonce}) no longer matches ` +
          `the current call derivation — refusing to broadcast; reconcile at the hash or start a fresh journal`,
      );
    }
    signed = { raw: priorPrepared.signedRaw, hash: priorPrepared.signedHash, nonce: BigInt(priorPrepared.nonce) };
  } else {
    const nonce = hexToBig(await rpc.request("eth_getTransactionCount", [fixtureAddress, "pending"]));
    const produced = signer.signLegacyTransaction({
      to,
      data,
      value: 0n,
      nonce,
      gasLimit: estGas,
      gasPrice,
      chainId,
    });
    signed = { ...produced, nonce };
  }
  // Persist the FULL prepared record — call digest, nonce, expected effects,
  // and the SIGNED RAW TX — BEFORE any broadcast (fsync+rename included).
  const prepared = {
    to,
    data,
    value: "0",
    chainId: chainId.toString(),
    gasLimit: estGas.toString(),
    gasPrice: gasPrice.toString(),
    from: fixtureAddress,
    nonce: signed.nonce.toString(),
    signedRaw: signed.raw,
    signedHash: signed.hash,
    callDigest: derivationDigestOf(to, data, signed.nonce, chainId.toString()),
  };
  record = {
    ...record,
    state: "prepared",
    prepared,
    signedHash: prepared.signedHash,
    expected,
    history: [...(record.history ?? []), {
      at: new Date().toISOString(),
      to: "prepared",
      note: `signed raw tx persisted BEFORE broadcast (hash ${prepared.signedHash}, nonce ${prepared.nonce})`,
    }],
  };
  journal.saveJob(record);
  if (fault?.crashBeforeBroadcast) {
    // test hook: simulated crash AFTER persist but BEFORE broadcast. The
    // worker's recovery path (a later run) re-reads this record first.
    process.exit(typeof fault.crashBeforeBroadcast === "number" ? fault.crashBeforeBroadcast : 99);
  }
  onLog(`[finalizer] ${describeJobIdentity(identity)} prepared (signed raw persisted; nonce ${prepared.nonce}, hash ${prepared.signedHash})`);

  // — broadcast the SAME raw bytes, bounded attempts, exponential backoff —
  record = journal.loadJob(identity);
  record = { ...record, broadcast: { attempts: [...(record.broadcast?.attempts ?? [])] } };
  let accepted = false;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let outcome = null;
    try {
      if (fault?.failBroadcastOnce && attempt === 1) {
        throw new TransientRpcError("fault-injected broadcast failure (attempt 1)");
      }
      const acceptHash = await rpc.request("eth_sendRawTransaction", [prepared.signedRaw]);
      if ((acceptHash ?? "").toLowerCase() !== prepared.signedHash.toLowerCase()) {
        throw new Error(`eth_sendRawTransaction returned ${acceptHash} but keccak(raw) is ${prepared.signedHash}`);
      }
      outcome = "accepted";
      accepted = true;
      record.broadcast.attempts.push({ attempt, at: new Date().toISOString(), outcome, hash: prepared.signedHash });
      // On the FIRST accepted broadcast, persist "submitted" (and the hash)
      // before anything else — a crash after this is reconciled by hash.
      record = {
        ...record,
        state: "submitted",
        submittedAt: new Date().toISOString(),
        history: [...(record.history ?? []), { at: new Date().toISOString(), to: "submitted", note: `broadcast accepted (tx ${prepared.signedHash}); queued/submitted are never a success` }],
      };
      journal.saveJob(record);
      // NOTE: tryConfirm runs OUTSIDE this try — a verification error must
      // never trigger a re-broadcast of the still-valid settle.
      break;
    } catch (err) {
      if (err instanceof BlockedJob) {
        throw err;
      }
      let outcome = "reject";
      if (err instanceof TransientRpcError) outcome = "transient";
      else if (/already known|alreadyexists|same tx/i.test(err.message ?? "")) outcome = "already-known";
      else if (/nonce.*too low/i.test(err.message ?? "")) outcome = "nonce-consumed";
      else if (/temporarily|too many|429|rate limit|denied/i.test(err.message ?? "")) outcome = "transient";
      const lastOutcome = { attempt, outcome, detail: err.message ?? String(err) };
      record.broadcast.attempts.push({ attempt, at: new Date().toISOString(), outcome, detail: lastOutcome.detail });
      journal.saveJob(record);
      onLog(`[finalizer] ${describeJobIdentity(identity)} broadcast outcome ${outcome}@${attempt}: ${lastOutcome.detail}`);
      // A nonce consumed by a DIFFERENT transaction must not be papered over:
      // fail terminal (manual recovery). Same raw bytes are never discarded —
      // they stay in the journal for tracing/reconciliation at the hash.
      if (outcome === "nonce-consumed") {
        record = journal.loadJob(identity);
        const failed = {
          ...record,
          state: "failed",
          failed: { reason: "nonce-consumed-externally", detail: lastOutcome.detail },
          history: [...(record.history ?? []), { at: new Date().toISOString(), to: "failed", note: "broadcast refused: the nonce was consumed by a different tx (the same raw bytes stay on disk for tracing)" }],
        };
        journal.saveJob(failed);
        return journal.loadJob(identity);
      }
      if (outcome === "already-known") {
        // The same raw bytes are already on the mempool from an earlier
        // (crashed) broadcast: dedupe, not a failure — go straight to
        // receipt reconciliation with the SAME hash.
        accepted = true;
        record = journal.loadJob(identity);
        break;
      }
      if (attempt < maxAttempts) await sleep(backoffBaseMs * Math.pow(2, attempt - 1));
    }
  }
  if (accepted) {
    if (fault?.crashAfterSubmit) {
      process.exit(typeof fault.crashAfterSubmit === "number" ? fault.crashAfterSubmit : 99);
    }
    record = journal.loadJob(identity);
    if (!accepted && record.state !== "submitted") {
      // nothing
    }
    return await tryConfirm({ reader, rpc, journal, identity, record, provenance, fixtureAddress, confirmDepth, maxAttempts, backoffBaseMs, toState, onLog });
  }
  // — exit the loop: if no accepted attempt, deepest state is `prepared` (retriable);
  //   if accepted, the record carries the hash; the caller can try confirm below —
  record = journal.loadJob(identity);
  return await toStateKeep(record, identity, journal, "broadcast attempts exhausted; the raw stays on disk; retry uses the SAME bytes");
}

/** A quiet TO-state helper: updates history but never flips state. */
async function toStateKeep(record, identity, journal, note) {
  const bumped = { ...record, updatedAt: new Date().toISOString(), history: [...(record.history ?? []), { at: new Date().toISOString(), note }] };
  journal.saveJob(bumped);
  return journal.loadJob(identity);
}

/** The canonical call-derivation digest: to|data|value|nonce|chainId. */
function derivationDigestOf(to, data, nonce, chainId) {
  return createHash("sha256")
    .update(`${to}|${data}|0|${BigInt(nonce).toString()}|${chainId}`)
    .digest("hex");
}
function clarity(n) {
  return BigInt(n);
}

/**
 * Confirmation: receipt at the configured depth, canonical block verification,
 * then the expected-effects verification. Explicitly NOT a success state here:
 * `submitted` means broadcast-accepted; `confirmed` comes only after
 * everything above.
 */
async function tryConfirm({ reader, rpc, journal, identity, record, provenance, fixtureAddress, confirmDepth, maxAttempts, backoffBaseMs, toState, onLog }) {
  const hash = record.signedHash;
  if (!hash) throw new JournalJournalDirErrors("submitted record with no signed hash");
  let receipt = null;
  for (let poll = 1; poll <= maxAttempts; poll++) {
    try {
      receipt = await rpc.request("eth_getTransactionReceipt", [hash]);
      break;
    } catch (err) {
      if (poll === maxAttempts) {
        // A receipt lookup failing is NOT a broadcast failure; state stays
        // `submitted` and the operator re-runs (or watch continues).
        await toStateKeep(record, identity, journal, `receipt pool exhausted (keeping submitted; tx ${hash})`);
        onLog(`[finalizer] ${describeJobIdentity(identity)}: awaiting receipt for ${hash}`);
        return await bumpBack(journal, identity, record);
      }
      await sleep(backoffBaseMs * Math.pow(2, poll - 1));
    }
  }
  if (!receipt) {
    onLog(`[finalizer] ${describeJobIdentity(identity)}: awaiting receipt (tx ${hash}); state stays submitted`);
    await toStateKeep(record, identity, journal, "receipt not yet seen; state stays submitted (this is not a success)");
    return await bumpBack(journal, identity, record);
  }
  if (receipt.status !== "0x1") {
    // The tx was mined but reverted — a real failure, never a false success.
    record = journal.loadJob(identity);
    record = {
      ...record,
      state: "failed",
      failed: { reason: "tx-reverted-onchain", receiptHash: receipt.transactionHash, status: receipt.status },
    };
    journal.saveJob(record);
    onLog(`[finalizer] ${describeJobIdentity(identity)} → failed (mined as reverted, tx ${hash}) — see journal.failed for the onchain revert, retry via --retry if the operator wants another pass (with the SAME raw bytes)`);
    return await bumpBack(journal, identity, record);
  }

  // Depth + canonicality gate (a reorg makes the block non-canonical → the
  // state stays `submitted` and the SAME raw bytes get re-checked later).
  const receiptBlock = hexToBig(receipt.blockNumber);
  const head = hexToBig(await rpc.request("eth_blockNumber"));
  const confirmations = head - receiptBlock + 1n;
  if (confirmations < BigInt(confirmDepth)) {
    await toStateKeep(record, identity, journal, `receipt at block ${receiptBlock} has depth ${confirmations} < required ${confirmDepth}; keeping submitted`);
    onLog(`[finalizer] ${describeJobIdentity(identity)}: depth ${confirmations} < ${confirmDepth}; keeping submitted`);
    return await bumpBack(journal, identity, record);
  }
  const block = await rpc.request("eth_getBlockByNumber", [bigToHex(receiptBlock), false]);
  if (!block || (block.hash ?? "").toLowerCase() !== (receipt.blockHash ?? "").toLowerCase()) {
    // A reorg in flight: preserve the job; the same raw bytes reconcile later.
    await toStateKeep(record, identity, journal, `receipt's blockHash ${receipt.blockHash} does not currently correspond to block ${receiptBlock} — a reorg is in flight; keeping submitted, the same raw bytes reconcile`);
    onLog(`[finalizer] ${describeJobIdentity(identity)}: reorg detected for tx ${hash}; keeping submitted`);
    return await bumpBack(journal, identity, record);
  }

  // Expected-effects verification.
  const expected = record.expected;
  if (!expected) {
    throw new JournalJournalDirErrors(`prepared state lost its expected-effects record (internal)`);
  }
  const verification = await verifyEffectsOnchain(reader, { identity, provenance, fixtureAddress, expected, receipt });
  if (!verification.ok) {
    record = journal.loadJob(identity);
    record = {
      ...record,
      state: "observed-mismatch",
      observed: { checkedAt: new Date().toISOString(), issues: verification.issues, receiptHash: receipt.transactionHash, blockNumber: receiptBlock.toString() },
    };
    journal.saveJob(record);
    onLog(`[finalizer] ${describeJobIdentity(identity)} → observed-mismatch: ${verification.issues.join("; ")}`);
    return await bumpBack(journal, identity, record);
  }
  record = journal.loadJob(identity);
  record = {
    ...record,
    state: "confirmed",
    confirmed: {
      blockNumber: receiptBlock.toString(),
      blockHash: receipt.blockHash,
      confirmedAt: new Date().toISOString(),
      depth: confirmations.toString(),
      notes: verification.notes,
    },
    history: [...(record.history ?? []), { at: new Date().toISOString(), to: "confirmed", note: `tx ${hash} mined at block ${receiptBlock}, expected effects verified (depth ${confirmations})` }],
  };
  journal.saveJob(record);
  onLog(`[finalizer] ${describeJobIdentity(identity)} → confirmed (tx ${hash}, block ${receiptBlock})`);
  return await bumpBack(journal, identity, record);
}

/**
 * Reconcile-only state: re-verify effects on a submitted/observed-mismatch
 * state without ever re-broadcasting. Binds nothing new; a durable record's
 * `.observed` details tell the operator what must be investigated manually.
 */
async function reconcileFromReceiptOnly({ reader, rpc, journal, identity, record, provenance, fixtureAddress, toState, onLog }) {
  const hash = record.signedHash;
  if (!hash) throw new JournalJournalDirErrors("reconcile expected a signed hash");
  const receipt = await rpc.request("eth_getTransactionReceipt", [hash]).catch(() => null);
  if (!receipt) {
    onLog(`[finalizer] ${describeJobIdentity(identity)}: reconcile sees no receipt yet for ${hash}; state stays ${record.state}`);
    await toStateKeep(record, identity, journal, "reconcile: receipt still absent; state unchanged");
    return await bumpBack(journal, identity, record);
  }
  if (receipt.status !== "0x1") {
    await toStateKeep(record, identity, journal, `reconcile: the receipt is a reverted transaction; state stays ${record.state} (manual intervention)`);
    return await bumpBack(journal, identity, record);
  }
  const receiptBlock = hexToBig(receipt.blockNumber);
  const verification = await verifyEffectsOnchain(reader, { identity, provenance, fixtureAddress, expected: record.expected, receipt });
  if (!verification.ok) {
    record = journal.loadJob(identity);
    record = {
      ...record,
      state: "observed-mismatch",
      observed: { checkedAt: new Date().toISOString(), issues: verification.issues, receiptHash: receipt.transactionHash, blockNumber: receiptBlock.toString() },
    };
    journal.saveJob(record);
    return await bumpBack(journal, identity, record);
  }
  record = journal.loadJob(identity);
  record = {
    ...record,
    state: "confirmed",
    confirmed: {
      blockNumber: receiptBlock.toString(),
      blockHash: receipt.blockHash,
      confirmedAt: new Date().toISOString(),
      depth: "manual-reconcile",
      notes: verification.notes,
    },
  };
  journal.saveJob(record);
  return await bumpBack(journal, identity, record);
}

// ---------------------------------------------------------------------------
// Operator commands: retry / status
// ---------------------------------------------------------------------------

export async function retryJob(journalDir, identity, { onLog = console.log } = {}) {
  if (!journalDir || !identity) throw new UsageError("--journal and --job are required for retry");  const journal = Journal.ensure(journalDir);
  const myInfo = Journal.LOCK_INFO_ME();
  journal.acquireLock(myInfo);
  try {
    const record = journal.loadJob(identity);
    if (!record) throw new UsageError(`no such job in journal: ${describeJobIdentity(identity)}`);
    if (record.state === "submitted") {
      throw new BlockedJob("job-still-submitted", "the job is mid-flight — its receipt will confirm on the next run; retry clears nothing");
    }
    if (record.state === "confirmed") return { identity, state: "confirmed", note: "already confirmed" };
    if (record.state === "environment-changed") {
      throw new BlockedJob("environment-changed", "the chain that produced this state is gone; start a fresh journal");
    }
    const now = new Date().toISOString();
    const bumped = {
      ...record,
      state: "queued",
      updatedAt: now,
      history: [...(record.history ?? []), { at: now, to: "queued", note: "operator retry — nothing was deleted; the same signed raw (if any) will be reused" }],
    };
    journal.saveJob(bumped);
    onLog(`[finalizer] ${describeJobIdentity(identity)} → queued (operator retry)`);
    return { identity, state: "queued", note: bumpBack(journal, identity, bumped).state };
  } finally {
    journal.releaseLock(myInfo);
  }
}

/**
 * Operator `reconcile`: re-verify the chain side of a submitted/failed/
 * observed-mismatch job WITHOUT broadcasting. Binds the environment first
 * (a changed environment is refused before any read), then trusts the
 * stored signed hash for a receipt, rechecks depth/canonicality/effects,
 * and either confirms the journal or leaves the state with a fresh
 * `observed` note for manual work. It NEVER re-broadcasts anything.
 */
export async function executeReconcile(journalDir, identity, { rpcUrl, onLog = console.log } = {}) {
  if (!journalDir || !identity) throw new UsageError("--journal and --job are required for reconcile");
  const journal = Journal.ensure(journalDir);
  const myInfo = Journal.LOCK_INFO_ME();
  journal.acquireLock(myInfo);
  try {
    if (!rpcUrl) throw new UsageError("--rpc is required for reconcile");
    const rpc = new RpcClient(rpcUrl);
    const envIdentity = await readEnvironmentIdentity(rpc);
    const journalEnv = journal.loadEnvironment();
    if (journalEnv && journalEnv.fingerprint !== envIdentity.fingerprint) {
      throw new EnvironmentChanged(
        `the journal is bound to environment fingerprint ${journalEnv.fingerprint} but the live chain has ` +
          `${envIdentity.fingerprint} — refused (the journal never rebinds)`,
      );
    }
    journal.saveEnvironment({ ...envIdentity, boundAt: journalEnv?.boundAt ?? new Date().toISOString() });
    const record = journal.loadJob(identity);
    if (!record) throw new UsageError(`no such job in journal: ${describeJobIdentity(identity)}`);
    if (record.state === "confirmed") {
      return { identity, state: "confirmed", exitCode: 0 };
    }
    if (!["submitted", "failed", "observed-mismatch"].includes(record.state)) {
      throw new BlockedJob("nothing-to-reconcile", `state ${record.state} has no onchain side to reconcile`);
    }
    const fixtureAddress = record.prepared?.from;
    const hash = record.signedHash;
    if (!fixtureAddress || !hash) {
      throw new BlockedJob("no-prepared-tx", "the record carries no prepared fixture/signed hash to reconcile");
    }
    const reader = new ChainReader(rpc);
    const provenance = await readProvenance(reader, { identity, fixtureAddress });
    const receipt = await rpc.request("eth_getTransactionReceipt", [hash]).catch(() => null);
    if (!receipt) {
      onLog(`[finalizer] ${describeJobIdentity(identity)}: reconcile sees no receipt for ${hash}; state stays ${record.state}`);
      const bumped = {
        ...record,
        history: [...(record.history ?? []), { at: new Date().toISOString(), note: `reconcile: no receipt yet for ${hash}; state unchanged` }],
      };
      journal.saveJob(bumped);
      return { identity, state: record.state, exitCode: record.state === "submitted" ? 2 : record.state === "observed-mismatch" ? 5 : 6 };
    }
    if (receipt.status !== "0x1") {
      onLog(`[finalizer] ${describeJobIdentity(identity)}: the tx ${hash} is onchain and REVERTED — a failed settle (the operator decides; records kept).`);
      const bumped = {
        ...record,
        state: "failed",
        failed: { reason: "tx-reverted-onchain", receiptHash: receipt.transactionHash, status: receipt.status },
        history: [...(record.history ?? []), { at: new Date().toISOString(), to: "failed", note: `reconcile: receipt is a reverted tx (status ${receipt.status})` }],
      };
      journal.saveJob(bumped);
      return { identity, state: "failed", exitCode: 6 };
    }
    const receiptBlock = hexToBig(receipt.blockNumber);
    const head = hexToBig(await rpc.request("eth_blockNumber"));
    const confirmations = head - receiptBlock + 1n;
    const block = await rpc.request("eth_getBlockByNumber", [bigToHex(receiptBlock), false]);
    if (!block || (block.hash ?? "").toLowerCase() !== (receipt.blockHash ?? "").toLowerCase()) {
      onLog(`[finalizer] ${describeJobIdentity(identity)}: reconcile sees a non-canonical/reorgs block for the receipt; state stays ${record.state}`);
      const bumped = {
        ...record,
        history: [...(record.history ?? []), { at: new Date().toISOString(), note: `reconcile: block ${receiptBlock} hash moved off the receipt's blockHash (reorg); state unchanged` }],
      };
      journal.saveJob(bumped);
      return { identity, state: record.state, exitCode: record.state === "observed-mismatch" ? 5 : 2 };
    }
    if (confirmations < 1n) {
      onLog(`[finalizer] ${describeJobIdentity(identity)}: reconcile waits for depth (has ${confirmations})`);
      return { identity, state: record.state, exitCode: record.state === "observed-mismatch" ? 5 : 2 };
    }
    const expected = record.expected;
    if (!expected) throw new BlockedJob("journal-defect", "the record has no expected-effects block to reconcile against");
    const verification = await verifyEffectsOnchain(reader, { identity, provenance, fixtureAddress, expected, receipt });
    if (verification.ok) {
      const bumped = {
        ...record,
        state: "confirmed",
        confirmed: {
          blockNumber: receiptBlock.toString(),
          blockHash: receipt.blockHash,
          confirmedAt: new Date().toISOString(),
          depth: "-manual-reconcile",
          notes: verification.notes,
        },
        history: [...(record.history ?? []), { at: new Date().toISOString(), to: "confirmed", note: `manual reconcile verified the chain state of ${hash}` }],
      };
      journal.saveJob(bumped);
      onLog(`[finalizer] ${describeJobIdentity(identity)} → confirmed (manual reconcile; tx ${hash}, block ${receiptBlock})`);
      return { identity, state: "confirmed", exitCode: 0 };
    }
    const bumped = {
      ...record,
      state: "observed-mismatch",
      observed: {
        checkedAt: new Date().toISOString(),
        issues: verification.issues,
        receiptHash: receipt.transactionHash,
        blockNumber: receiptBlock.toString(),
      },
      history: [...(record.history ?? []), { at: new Date().toISOString(), to: "observed-mismatch", note: `manual reconcile still mismatches: ${verification.issues.join("; ")}` }],
    };
    journal.saveJob(bumped);
    onLog(`[finalizer] ${describeJobIdentity(identity)}: reconcile still sees a mismatch — ${verification.issues.join("; ")}`);
    return { identity, state: "observed-mismatch", exitCode: 5 };
  } finally {
    journal.releaseLock(myInfo);
  }
}

export async function statusJournal(journalDir, { onLog = console.log, asJson = false } = {}) {  const journal = new Journal(journalDir);
  const jobs = [];
  for (const { identity, record } of await journal.allJobs()) {
    jobs.push({
      identity: describeJobIdentity(identity),
      slug: jobFileSlug(identity),
      state: record.state,
      note: noteFor(record),
      blockedReason: record.blocked?.reason ?? null,
      failedReason: record.failed?.reason ?? null,
      observedIssues: record.observed?.issues ?? null,
      preparedHash: record.signedHash ?? null,
      broadcastAttempts: (record.broadcast?.attempts ?? []).map((a) => a.outcome),
      confirmedBlock: record.confirmed?.blockNumber ?? null,
      updatedAt: record.updatedAt ?? null,
    });
  }
  if (asJson) {
    onLog(JSON.stringify({ journal: journalDir, jobs }, null, 2));
  } else if (jobs.length === 0) {
    onLog(`(no jobs in journal ${journalDir})`);
  } else {
    for (const j of jobs) {
      onLog(`${j.state.padEnd(19)} ${j.slug} ${j.state === "prepared" || j.state === "submitted" ? j.note : ""}`);
      if (j.blockedReason) onLog(`    blocked: ${j.blockedReason} — ${j.note}`);
      else if (j.failedReason) onLog(`    failed: ${j.failedReason} — ${j.note}`);
      else if (j.observedIssues) onLog(`    mismatch: ${j.note}`);
      else if (j.state === "confirmed") onLog(`    confirmed: ${j.note}`);
    }
  }
  return { jobs, journalDir, lockHeld: fs.existsSync(path.join(journalDir, JOURNAL_LOCK_NAME)) };
}
