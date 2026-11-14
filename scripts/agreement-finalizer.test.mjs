/**
 * Tests for scripts/agreement-finalizer-lib.mjs — the durable agreement
 * finalizer (Phase C of docs/v3-review/AWARD-MECHANICS-SPEC.md).
 *
 * Falsifiability map (each guard has a test that turns red if the guard is
 * removed — the Review-Proven rule: a guard whose removal fails no test
 * protects nothing):
 *
 *   - "public RPC refused" / "non-anvil refused" — the loopback URL check and
 *     the anvil_metadata probe bind the worker's network surface.
 *   - "chain reset keeps the journal environment-changed and refuses" — the
 *     environment fingerprint gate; a weakened gate would settle onto a
 *     node it has not provenance-proven.
 *   - "pre-submission attestations are not eligibility" — snapshot-relative
 *     quorum (the post-submission delta, not the raw counter).
 *   - "objection quorum → blocked, nothing signed" — the worker never
 *     settles into the contract's slash branch.
 *   - "crash after persist → later run reuses the SAME raw" — the
 *     raw-before-broadcast order; a weakened order leaves nothing recoverable.
 *   - every broadcast in every journey is RLP-decoded and must be exactly
 *     `settle(bytes32)` on the claim escrow, or
 *     `settleAgreement(address,bytes32)` on the DAO — any other selector,
 *     target, or value is a red test (no arbitrary calldata path).
 *   - "receipt at too-low depth keeps submitted"; "a receipt whose block the
 *     chain no longer holds keeps submitted" — depth + canonicality gates.
 *   - "receipt with a wrong mint is observed-mismatch; an explicit
 *     --reconcile alone may confirm it" — the expected-effects verification.
 *   - "mined revert is failed with records kept; --retry requeues; the SAME
 *     raw is rebroadcast (never a fresh nonce)".
 *   - "a settlement the declared split count contradicts is blocked" and "a
 *     settlement whose portions do not sum to the reserved shares is blocked" —
 *     the expectation is cross-checked against `splits(bytes32)` and the
 *     reserved quantity, never taken from a single source on trust.
 *   - "an unbound claim is observed-mismatch" — `confirmed` requires the
 *     claim's durable `agreementOfClaim` binding (the agreed path's one-delivery
 *     latch), not the discretionary path's `contributionAwarded` flag.
 *   - "every well-known anvil key derives to its listed address" — the fixture
 *     signer allowlist must match the real derivations (a truncated entry
 *     silently refuses a legitimate dev account).
 *   - capability: "a mandate without AGREEMENTS_VERSION()==1 is an unknown,
 *     never legacy".
 *
 * The real-chain section (REAL-CHAIN PROGRESS below) deploys the CURRENT
 * production candidate contracts (`contracts/out` from `forge build`) on a
 * scratch anvil and drives one agreed contribution through propose → accept
 * → bind → attest → settled window → challenge window elapsed →
 * settleAgreement, then asserts the worker's journal plus the chain state.
 * It also exercises two real refusals on that chain (an objection quorum that
 * would slash, and an unmet approval quorum) in which the worker must sign
 * nothing, and the environment gate against a fresh anvil instance. It skips
 * LOUDLY (with the exact missing artifacts on record) only when the candidate
 * is not compiled — never a mocked pass.
 *
 * DEV-ONLY: anvil dev fixtures, loopback only; no real funds, no public
 * writes, no commits.
 */

import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { spawnSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "agreement-finalizer.mjs");
const lib = await import(path.join(HERE, "agreement-finalizer-lib.mjs"));
const CLI_URL = pathToFileURL(CLI).href;

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

const tmpRoot = mkdtempSync(path.join(tmpdir(), "agreement-finalizer-test-"));
process.on("exit", () => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

function tempDir(name) {
  const dir = path.join(tmpRoot, name + "-" + Math.random().toString(36).slice(2, 8));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function tempJournal(name) {
  return path.join(tempDir(name), "journal");
}

function fakeAddr(n) {
  return "0x" + n.toString(16).padStart(40, "0");
}

function bytes32No(n) {
  return "0x" + n.toString(16).padStart(64, "0");
}

function randHex64() {
  return "0x" + Array.from({ length: 64 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");
}

function encodeOut(values, types) {
  return lib.encodeParameters(types, values);
}

const FIXTURE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const FIXTURE_ADDRESS = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
/** An arbitrary (not well-known) key: the fixture-signer gate must refuse it. */
const NON_WELLKNOWN_KEY = "0x" + "11".repeat(32);
/** A loopback port with nothing listening — the RPC probe refuses quickly. */
const DEAD_LOOPBACK_PORT = 59977;

/** Read one job record out of a journal directory. */
function jobRecord(journalDir, identity) {
  return new lib.Journal(journalDir).loadJob(identity);
}

// ---------------------------------------------------------------------------
// Minimal legacy-RLP decode (test-side readback of the SIGNED bytes)
// ---------------------------------------------------------------------------

function hexBytes(hex) {
  const h = hex.toLowerCase().replace(/^0x/, "");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesHex_(bytes) {
  return Array.from(bytes ?? [], (b) => b.toString(16).padStart(2, "0")).join("");
}

function rlpDecode(bytes) {
  function readItem(buf, at) {
    const first = buf[at];
    if (first === undefined) throw new Error("rlp: end of input");
    if (first < 0x80) {
      return { item: { hex: first.toString(16).padStart(2, "0") }, next: at + 1 };
    }
    if (first < 0xb8) {
      const len = first - 0x80;
      return { item: { hex: bytesHex_(buf.slice(at + 1, at + 1 + len)) }, next: at + 1 + len };
    }
    if (first < 0xc0) {
      const n = first - 0xb7;
      let len = 0;
      for (let i = 0; i < n; i++) len = len * 256 + buf[at + 1 + i];
      return { item: { hex: bytesHex_(buf.slice(at + 1 + n, at + 1 + n + len)) }, next: at + 1 + n + len };
    }
    let payloadStart;
    let len;
    if (first < 0xf8) {
      len = first - 0xc0;
      payloadStart = at + 1;
    } else {
      const n = first - 0xf7;
      len = 0;
      for (let i = 0; i < n; i++) len = len * 256 + buf[at + 1 + i];
      payloadStart = at + 1 + n;
    }
    const items = [];
    let pos = payloadStart;
    while (pos < payloadStart + len) {
      const { item, next } = readItem(buf, pos);
      items.push(item);
      pos = next;
    }
    return { item: { list: items }, next: pos };
  }
  return readItem(bytes, 0).item;
}

function hexOf(item) {
  if (item?.list === undefined && typeof item?.hex === "string") return item.hex;
  throw new Error(`unexpected rlp item shape (${JSON.stringify(item)})`);
}

/**
 * Read the SIGNED legacy tx back out: { to, data, value, nonce, ... } — the
 * same bytes the chain will accept, so the "exact-only-allowed-calldata"
 * assertion is enforced on the broadcast itself, not on a helper's intent.
 */
function decodeLegacyTx(raw) {
  const items = rlpDecode(hexBytes(raw)).list;
  if (items.length !== 9) {
    throw new Error(`a legacy tx is a 9-item rlp list; got ${items.length}`);
  }
  return {
    nonce: BigInt("0x" + (hexOf(items[0]) || "0")),
    gasPrice: BigInt("0x" + (hexOf(items[1]) || "0")),
    gasLimit: BigInt("0x" + (hexOf(items[2]) || "0")),
    to: "0x" + hexOf(items[3]),
    value: "0x" + (hexOf(items[4]) || "0"),
    data: "0x" + (hexOf(items[5]) || ""),
  };
}

// ---------------------------------------------------------------------------
// FakeAnvil — a scripted loopback JSON-RPC endpoint with the same wire shapes
// the real chain answers; records every request so no-transaction guarantees
// are directly assertable; dispatches eth_call against mutable state so a
// receipt-time chain flip looks the way a real chain behaves.
// ---------------------------------------------------------------------------

class FakeAnvil {
  constructor({ instanceId = null, head = 8n, chainId = 31337, genesisHash = null } = {}) {
    this.requests = [];
    this.broadcasts = [];
    this.calls = [];
    this.instanceId = instanceId ?? randHex64();
    this.genesisHash = genesisHash ?? randHex64();
    this.head = head;
    this.chainId = chainId;
    this.blockTimestamp = 1_700_000_000n; // the fake chain "now"
    this.broadcastDelayMs = 0;
    this.injectTransientBroadcastFailures = 0;
    this.failBroadcastWithNonceError = false;
    this.contracts = null;
    this.state = null;
    this.receipts = new Map(); // signedHash(lowercase) → receipt | null
    this.blockHashes = new Map(); // "0x<hex>" → block hash (per height)
    this.server = null;
    this.url = null;
  }

  withContracts(contracts) {
    const lower = {};
    for (const k of Object.keys(contracts)) lower[k] = contracts[k].toLowerCase();
    this.contracts = lower;
    return this;
  }

  withState(state) {
    this.state = state;
    return this;
  }

  /** Force a receipt for a hash; blockNumber/blockHash/status/logs全是 passed as given. */
  setReceipt(summonedHash, receipt) {
    this.receipts.set((summonedHash ?? "").toLowerCase(), receipt);
  }

  async listen() {
    this.server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          res.writeHead(400).end("{}");
          return;
        }
        let result = null;
        let error = null;
        try {
          result = await this.respond(parsed.method, parsed.params);
        } catch (err) {
          if (err?.__revert || err?.__error) {
            error = { code: 3, message: err.message ?? "execution reverted", data: err.data };
          } else {
            error = { code: -32000, message: err?.message ?? String(err) };
          }
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ jsonrpc: "2.0", id: parsed.id, ...(error ? { error } : { result }) }),
        );
      });
    });
    await new Promise((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${this.server.address().port}`;
    return this.url;
  }

  close() {
    try {
      this.server?.close();
      this.server?.closeAllConnections?.();
    } catch {}
    this.server = null;
  }

  async respond(method, params) {
    this.requests.push({ method, params });
    if (process.env.FINALIZER_TEST_DEBUG === "1" && [ "eth_getTransactionReceipt", "eth_sendRawTransaction" ].includes(method)) {
      console.error(`[fake] ${method} ${JSON.stringify(params).slice(0, 120)}`);
    }
    switch (method) {
      case "anvil_metadata":
        return {
          clientVersion: "anvil/v1.4.3-fake",
          chainId: this.chainId,
          instanceId: this.instanceId,
          latestBlockNumber: "0x" + this.head.toString(16),
          latestBlockHash: this.blockHashes.get("0x" + this.head.toString(16)) ?? randHex64(),
          forkedNetwork: null,
        };
      case "eth_chainId":
        return "0x" + this.chainId.toString(16);
      case "eth_blockNumber":
        return "0x" + this.head.toString(16);
      case "eth_gasPrice":
        return "0x1";
      case "eth_getBalance": {
        const who = (params[0] ?? "").toLowerCase();
        if (who === FIXTURE_ADDRESS) return "0x56bc75e2d63100000"; // 100e18 wei
        return "0x0";
      }
      case "eth_estimateGas":
        return "0x7a5e0";
      case "eth_getTransactionCount":
        // one per ACCEPTED broadcast, so the fake chain behaves like a nonce
        return "0x" + BigInt(this.broadcasts.length).toString(16);
      case "eth_getCode":
        return "0x6080604052";
      case "eth_getBlockByNumber": {
        const which = params[0];
        if (which === "0x0") return { hash: this.genesisHash, number: "0x0" };
        if (which === "latest") {
          return {
            hash: this.blockHashes.get("0x" + this.head.toString(16)) ?? randHex64(),
            number: "0x" + this.head.toString(16),
            timestamp: "0x" + this.blockTimestamp.toString(16),
          };
        }
        const canonical = this.blockHashes.get(which);
        if (canonical === undefined) {
          // receipt's block is NOT canonical (the fake chain never mined it) —
          // exactly the shape a reorg produces: the block hash at that height
          // is something else than the receipt's own.
          return { hash: randHex64(), number: which, timestamp: "0x0" };
        }
        return { hash: canonical, number: which, timestamp: "0x0" };
      }
      case "eth_call": {
        const txObj = params[0];
        this.calls.push(txObj);
        return this.ethCall(txObj);
      }
      case "eth_sendRawTransaction": {
        const raw = params?.[0];
        if (!raw || !raw.startsWith("0x")) throw new Error("bad raw tx");
        if (this.broadcastDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, this.broadcastDelayMs));
        }
        if (this.injectTransientBroadcastFailures > 0) {
          this.injectTransientBroadcastFailures--;
          // worded exactly like a real temporarily-unavailable node error so the
          // same classification path applies (the transient bucket)
          throw Object.assign(new Error("temporarily unavailable: rate limit reached (injected for test)"), {
            __testingTransient: true,
          });
        }
        if (this.failBroadcastWithNonceError) {
          throw new Error("replacement transaction underpriced: nonce too low");
        }
        const hash = lib.keccakRaw(raw);
        this.broadcasts.push(raw);
        this.blockHashes.set("0x" + this.head.toString(16), randHex64());
        // auto-register a successful canonical receipt at the current head,
        // unless a test's onBroadcast overrides it with the real thing.
        if (!this.receipts.has(hash)) {
          this.receipts.set(hash, {
            transactionHash: hash,
            blockNumber: "0x" + this.head.toString(16),
            blockHash: this.blockHashes.get("0x" + this.head.toString(16)),
            status: "0x1",
            logs: [],
          });
        }
        if (this.onBroadcast) {
          try {
            await this.onBroadcast(raw, hash);
          } catch (hookedErr) {
            if (process.env.FINALIZER_TEST_DEBUG === "1") {
              console.error(`[fake] onBroadcast threw: ${hookedErr?.stack ?? hookedErr}`);
            }
            throw hookedErr;
          }
        }
        return hash;
      }
      case "eth_getTransactionReceipt":
        return this.receipts.get((params[0] ?? "").toLowerCase()) ?? null;
      default:
        throw new Error(`fake anvil: unhandled method ${method}`);
    }
  }

  ethCall(txObj) {
    const to = (txObj?.to ?? "").toLowerCase();
    const data = (txObj?.data ?? "").toLowerCase();
    const c = this.contracts ?? {};
    const S = this.state ?? {};
    const sel = data.slice(0, 10);
    const paramsOnly = data.length > 10 ? "0x" + data.slice(10) : "0x";
    if (to === c.mandate) {
      if (sel === lib.selectorOf("dao()")) return encodeOut([c.dao], ["address"]);
      if (sel === lib.selectorOf("claims()")) return encodeOut([c.claims], ["address"]);
      if (sel === lib.selectorOf("verifiers()")) return encodeOut([c.verifiers], ["address"]);
      if (sel === lib.selectorOf("currency()")) return encodeOut([c.currency], ["address"]);
      if (sel === lib.selectorOf("closed()")) return encodeOut([S.closed ? true : false], ["bool"]);
      if (sel === lib.selectorOf("mandateSharesAwarded()")) return encodeOut([S.mandateSharesAwarded ?? 0n], ["uint256"]);
      if (sel === lib.selectorOf("sharesReserved(bytes32)")) {
        const arg = lib.decodeParameters(["bytes32"], paramsOnly)[0];
        return encodeOut([S.sharesReservedByProject?.[arg?.toLowerCase()] ?? 0n], ["uint256"]);
      }
      if (sel === lib.selectorOf("contributionAwarded(bytes32)")) {
        const arg = lib.decodeParameters(["bytes32"], paramsOnly)[0];
        return encodeOut([S.contributionAwarded?.[arg?.toLowerCase()] === true], ["bool"]);
      }
      if (sel === lib.selectorOf("agreementOfClaim(bytes32)")) {
        const arg = lib.decodeParameters(["bytes32"], paramsOnly)[0];
        return encodeOut([S.agreementOfClaimByClaim?.[arg?.toLowerCase()] ?? lib.ZERO_BYTES32], ["bytes32"]);
      }
      if (sel === lib.selectorOf("agreements(bytes32)")) {
        const arg = lib.decodeParameters(["bytes32"], paramsOnly)[0];
        const rec = (S.agreements ?? {})[arg?.toLowerCase()];
        if (!rec) {
          return { __revert: "execution reverted", data: lib.ERROR_SELECTOR_IDS.unknownAgreement + "0".repeat(64) };
        }
        return encodeOut(
          [
            rec.projectId ?? bytes32No(0x7aa1),
            rec.beneficiary,
            BigInt(rec.shares),
            rec.criteriaHash ?? bytes32No(0x7ea1),
            rec.policyRef ?? bytes32No(0x0),
            BigInt(rec.acceptedAt ?? 0n),
            BigInt(rec.reviewPeriod ?? 604800n),
            BigInt(rec.workDeadline ?? 0n),
            BigInt(rec.revisionDeadline ?? 0n),
            rec.claimId ?? lib.ZERO_BYTES32,
            BigInt(rec.terminalKind ?? 0),
            BigInt(rec.attempts ?? 0),
            rec.splitHash ?? bytes32No(0x0),
          ],
          lib.ABI.AGREEMENTS.types,
        );
      }
      if (sel === lib.selectorOf("splits(bytes32)")) {
        const arg = lib.decodeParameters(["bytes32"], paramsOnly)[0];
        const rec = (S.agreements ?? {})[arg?.toLowerCase()] ?? {};
        // Solidity's public getter of the Splits struct answers only the count.
        return encodeOut([BigInt((rec.splitParties ?? []).length)], ["uint8"]);
      }
      if (sel === lib.selectorOf("settleAgreement(bytes32)")) {
        // The mandate's own settlement answer: (parties, portions), exactly the
        // shape the DAO's permissionless call mints from.
        const arg = lib.decodeParameters(["bytes32"], paramsOnly)[0];
        const rec = (S.agreements ?? {})[arg?.toLowerCase()];
        if (!rec) {
          return { __revert: "execution reverted", data: lib.ERROR_SELECTOR_IDS.unknownAgreement + "0".repeat(64) };
        }
        if (S.settlementOverride) {
          return encodeOut(
            [S.settlementOverride.parties, S.settlementOverride.portions.map((p) => BigInt(p))],
            [{ array: "address" }, { array: "uint256" }],
          );
        }
        const parts = rec.splitParties ?? [];
        const shares = BigInt(rec.shares);
        if (parts.length === 0) {
          return encodeOut([[rec.beneficiary], [shares]], [{ array: "address" }, { array: "uint256" }]);
        }
        const portions = parts.map((part, index) =>
          index === 0 ? 0n : (shares * BigInt(part.pct)) / 10000n,
        );
        const handedOut = portions.slice(1).reduce((sum, p) => sum + p, 0n);
        portions[0] = shares - handedOut;
        return encodeOut(
          [parts.map((part) => part.party), portions],
          [{ array: "address" }, { array: "uint256" }],
        );
      }
      if (sel === lib.selectorOf("AGREEMENTS_VERSION()")) {
        if (S.noVersion) return { __revert: "execution reverted", data: "" };
        return encodeOut([1n], ["uint256"]);
      }
      throw new Error(`fake anvil: eth_call on mandate, selector ${sel}`);
    }
    if (to === c.claims) {
      if (sel === lib.selectorOf("settle(bytes32)")) {
        // The simulation of the ONE allowed settle call: on the fake chain it
        // succeeds (the receipt-time mapper flips the state afterwards).
        return "0x";
      }
      if (sel === lib.selectorOf("treasury()")) return encodeOut([c.mandate], ["address"]);
      if (sel === lib.selectorOf("verifiers()")) return encodeOut([c.verifiers], ["address"]);
      if (sel === lib.selectorOf("challengeWindow()")) return encodeOut([S.challengeWindow ?? 604800n], ["uint256"]);
      if (sel === lib.selectorOf("claimTerms(bytes32)")) {
        const arg = lib.decodeParameters(["bytes32"], paramsOnly)[0];
        const rec = (S.claims ?? {})[arg?.toLowerCase()];
        if (!rec) {
          return { __revert: "execution reverted", data: lib.ERROR_SELECTOR_IDS.unknownAgreement + "0".repeat(64) };
        }
        return encodeOut(
          [rec.contributor, BigInt(rec.amount ?? 0), rec.checkHash ?? lib.ZERO_BYTES32, BigInt(rec.status ?? 0)],
          lib.ABI.CLAIM_TERMS.types,
        );
      }
      if (sel === lib.selectorOf("claims(bytes32)")) {
        const arg = lib.decodeParameters(["bytes32"], paramsOnly)[0];
        const rec = (S.claims ?? {})[arg?.toLowerCase()];
        if (!rec) {
          return { __revert: "execution reverted", data: lib.ERROR_SELECTOR_IDS.unknownAgreement + "0".repeat(64) };
        }
        return encodeOut(
          [
            rec.contributor,
            BigInt(rec.amount ?? 0),
            BigInt(rec.stake ?? 0),
            BigInt(rec.status ?? 0),
            bytes32No(0x1),
            rec.checkHash ?? lib.ZERO_BYTES32,
            BigInt(rec.expiresAt ?? 0n),
            BigInt(rec.releasedAt ?? 0n),
          ],
          lib.ABI.CLAIMS.types,
        );
      }
      if (sel === lib.selectorOf("approvalsAtSubmit(bytes32)")) {
        const arg = lib.decodeParameters(["bytes32"], paramsOnly)[0];
        return encodeOut([BigInt(S.claims?.[arg?.toLowerCase()]?.approvalsAtSubmit ?? 0)], ["uint256"]);
      }
      if (sel === lib.selectorOf("objectionsAtSubmit(bytes32)")) {
        const arg = lib.decodeParameters(["bytes32"], paramsOnly)[0];
        return encodeOut([BigInt(S.claims?.[arg?.toLowerCase()]?.objectionsAtSubmit ?? 0)], ["uint256"]);
      }
      throw new Error(`fake anvil: eth_call on claims, selector ${sel}`);
    }
    if (to === c.verifiers) {
      if (sel === lib.selectorOf("quorum()")) return encodeOut([S.quorum ?? 1n], ["uint256"]);
      if (sel === lib.selectorOf("approvalCount(bytes32)") || sel === lib.selectorOf("objectionCount(bytes32)")) {
        const arg = lib.decodeParameters(["bytes32"], paramsOnly)[0];
        const key = sel === lib.selectorOf("approvalCount(bytes32)") ? "approvals" : "objections";
        return encodeOut([BigInt(S.claims?.[arg?.toLowerCase()]?.[key] ?? 0)], ["uint256"]);
      }
      throw new Error(`fake anvil: eth_call on verifiers, selector ${sel}`);
    }
    if (to === c.dao) {
      if (sel === lib.selectorOf("settleAgreement(address,bytes32)")) {
        return "0x";
      }
      if (sel === lib.selectorOf("shares()")) return encodeOut([c.shares], ["address"]);
      if (sel === lib.selectorOf("votingWeight()")) return encodeOut([c.votingWeight], ["address"]);
      throw new Error(`fake anvil: eth_call on dao, selector ${sel}`);
    }
    if (to === c.votingWeight) {
      if (sel === lib.selectorOf("mandateFactory()")) return encodeOut([c.factory], ["address"]);
      throw new Error(`fake anvil: eth_call on votingWeight, selector ${sel}`);
    }
    if (to === c.factory) {
      if (sel === lib.selectorOf("daos(address)")) {
        const arg = lib.decodeParameters(["address"], paramsOnly)[0];
        return encodeOut([S.factoryDaos?.[arg?.toLowerCase()] ?? c.dao], ["address"]);
      }
      throw new Error(`fake anvil: eth_call on factory, selector ${sel}`);
    }
    if (to === c.shares) {
      if (sel === lib.selectorOf("balanceOf(address)")) {
        const arg = lib.decodeParameters(["address"], paramsOnly)[0];
        return encodeOut([BigInt(S.shareBalances?.[arg?.toLowerCase()] ?? 0)], ["uint256"]);
      }
      if (sel === lib.selectorOf("totalSupply()")) {
        return encodeOut([BigInt(S.shareSupply ?? 0)], ["uint256"]);
      }
      throw new Error(`fake anvil: eth_call on shares, selector ${sel}`);
    }
    if (to === c.currency) {
      if (sel === lib.selectorOf("balanceOf(address)")) {
        const arg = lib.decodeParameters(["address"], paramsOnly)[0];
        return encodeOut([BigInt(S.currencyBalances?.[arg?.toLowerCase()] ?? 0)], ["uint256"]);
      }
      if (sel === lib.selectorOf("totalSupply()")) {
        return encodeOut([BigInt(S.currencySupply ?? 0)], ["uint256"]);
      }
      throw new Error(`fake anvil: eth_call on currency, selector ${sel}`);
    }
    throw new Error(`fake anvil: eth_call to a contract it does not host (${to})`);
  }
}

// ---------------------------------------------------------------------------
// the fake chain's canonical fixture: one agreement, its Open claim at quorum,
// and a 2-way split (80% the beneficiary, 20% a coauthor) over 5 shares
// ---------------------------------------------------------------------------

const C = {
  mandate: fakeAddr(0xa11),
  claims: fakeAddr(0xa22),
  verifiers: fakeAddr(0xa33),
  dao: fakeAddr(0xa44),
  votingWeight: fakeAddr(0xa55),
  factory: fakeAddr(0xa66),
  shares: fakeAddr(0xa77),
  currency: fakeAddr(0xa88),
};

const SHARES = BigInt(5) * 10n ** 18n;
const claimId = bytes32No(0x5aa1);
const agreementId = bytes32No(0x6aa1);
const beneficiary = fakeAddr(0xbee1);
const coauthor = fakeAddr(0xbee2);

function fakeBaseState({ withSplit = true } = {}) {
  return {
    quorum: 1n,
    challengeWindow: 604800n,
    noVersion: false,
    closed: false,
    claims: {
      [claimId]: {
        contributor: beneficiary,
        amount: 0n,
        status: 0,
        approvals: 1,
        approvalsAtSubmit: 0,
        objections: 0,
        objectionsAtSubmit: 0,
        checkHash: bytes32No(0x7ea1),
      },
    },
    agreements: {
      [agreementId]: {
        projectId: bytes32No(0x7aa1),
        beneficiary,
        shares: SHARES.toString(),
        criteriaHash: bytes32No(0x7ea1),
        acceptedAt: 1n,
        workDeadline: 2n,
        revisionDeadline: 3n,
        claimId,
        terminalKind: 0,
        attempts: 1,
        splitParties: withSplit
          ? [
              { party: beneficiary, pct: 8000n },
              { party: coauthor, pct: 2000n },
            ]
          : [],
      },
    },
    mandateSharesAwarded: 0n,
    sharesReservedByProject: { [bytes32No(0x7aa1).toLowerCase()]: SHARES }, // the agreed reservation is outstanding
    contributionAwarded: {},
    agreementOfClaimByClaim: {},
    shareSupply: 1000n * 10n ** 18n,
    shareBalances: { [beneficiary.toLowerCase()]: 10n, [coauthor.toLowerCase()]: 10n },
    factoryDaos: { [C.mandate]: C.dao },
  };
}

const JOB_START = `chain=31337,dao=${C.dao},mandate=${C.mandate},agreement=${agreementId},action=start-window`;
const JOB_SETTLE = `chain=31337,dao=${C.dao},mandate=${C.mandate},agreement=${agreementId},action=settle-agreement`;

function parseJob(which) {
  return lib.parseJobSpec(which);
}

// ---------------------------------------------------------------------------
// FakeAnvil receipt helpers shared by the settle-agreement journeys
// ---------------------------------------------------------------------------

function settledLogs({ claimantDelta = BigInt(SHARES * 8000n) / 10000n, coauthorDelta = BigInt(SHARES * 2000n) / 10000n } = {}) {
  return [
    {
      address: C.shares,
      topics: [lib.TRANSFER_TOPIC, lib.ZERO_BYTES32, "0x" + beneficiary.toLowerCase().slice(2).padStart(64, "0")],
      data: "0x" + claimantDelta.toString(16).padStart(64, "0"),
    },
    {
      address: C.shares,
      topics: [lib.TRANSFER_TOPIC, lib.ZERO_BYTES32, "0x" + coauthor.toLowerCase().slice(2).padStart(64, "0")],
      data: "0x" + coauthorDelta.toString(16).padStart(64, "0"),
    },
    {
      address: C.mandate,
      topics: [
        lib.AGREEMENT_SETTLED_TOPIC_EXPORT,
        "0x" + agreementId.slice(2),
        lib.ZERO_BYTES32,
        "0x" + beneficiary.toLowerCase().slice(2).padStart(64, "0"),
      ],
      data: "0x" + SHARES.toString(16).padStart(64, "0"),
    },
  ];
}

/** Advance the fake chain to the expected post-settle state, exactly. */
function applyPostSettle(state, claimantDelta = (BigInt(SHARES * 8000n) / 10000n), coauthorDelta = (BigInt(SHARES * 2000n) / 10000n)) {
  state.claims[claimId].status = 4; // Paid (the mandate's settle finished the claim)
  state.agreements[agreementId].terminalKind = 1;
  state.contributionAwarded[claimId] = true;
  // the claim's durable one-delivery binding, written at bind and kept forever
  state.agreementOfClaimByClaim[claimId] = agreementId;
  state.mandateSharesAwarded = (state.mandateSharesAwarded ?? 0n) + BigInt(SHARES);
  state.sharesReservedByProject = {}; // the agreement's reservation released
  state.shareSupply = BigInt(state.shareSupply) + BigInt(claimantDelta + coauthorDelta);
  state.shareBalances[beneficiary.toLowerCase()] =
    BigInt(state.shareBalances[beneficiary.toLowerCase()] ?? 0n) + BigInt(claimantDelta);
  state.shareBalances[coauthor.toLowerCase()] =
    BigInt(state.shareBalances[coauthor.toLowerCase()] ?? 0n) + BigInt(coauthorDelta);
}

/** The start-window settle flips the claim to Approved with a release timestamp. */
function applyStartWindow(state) {
  state.claims[claimId].status = CLAIM_STATUS_APPROVED(); // 1 = Approved
  state.claims[claimId].releasedAt = 1_700_000_000n;
}

function CLAIM_STATUS_APPROVED() {
  return 1n;
}

/** A receipt for the start-window settle (with its ClaimReleased log). */
function claimReleasedReceipt(hash, headHex) {
  return {
    transactionHash: hash,
    blockNumber: headHex,
    blockHash: "0x" + "8".repeat(64),
    status: "0x1",
    logs: [
      {
        address: C.claims,
        topics: [
          lib.CLAIM_RELEASED_TOPIC_EXPORT,
          "0x" + claimId.slice(2),
          "0x" + beneficiary.toLowerCase().slice(2).padStart(64, "0"),
        ],
        data: "0x" + "0".repeat(64),
      },
    ],
  };
}

/** Wire the fake so ANY accepted broadcast applies the intended onchain effect. */
function wireStartWindowEffects(anvil, state) {
  anvil.onBroadcast = async (raw, hash) => {
    applyStartWindow(state);
    const receipt = claimReleasedReceipt(hash, "0x" + anvil.head.toString(16));
    anvil.setReceipt(hash, receipt);
    anvil.blockHashes.set(receipt.blockNumber, receipt.blockHash);
  };
}

// ---------------------------------------------------------------------------
// job-spec validation: the operator's bounded list is the only work
// ---------------------------------------------------------------------------

test("job spec: strict parsing accepts exactly the operator's shapes", () => {
  const j = lib.parseJobSpec(
    `chain=31337, dao=${C.dao.toUpperCase()}, mandate=${C.mandate}, agreement=${agreementId}, action=start-window`,
  );
  assert.equal(j.action, "start-window");
  assert.equal(j.chainId, "31337");
  assert.equal(j.dao, C.dao);
  assert.equal(j.agreementId, agreementId);
  assert.equal(lib.jobFileSlug(j).length, 49); // job-<40 hex>.json
  const rejects = [
    "",
    "chain=31337,dao=0x00,mandate=0x00,agreement=0x00,action=start-window",
    "chain=abc,dao=0x0000000000000000000000000000000000000001,mandate=0x0000000000000000000000000000000000000002,agreement=0x0000000000000000000000000000000000000000000000000000000000000003,action=start-window",
    `chain=31337,dao=${C.dao},mandate=${C.mandate},agreement=${agreementId},action=award-more`,
    `chain=31337,dao=${C.dao},mandate=${C.mandate},agreement=0xzz,action=start-window`,
    `chain=31337,dao=${C.dao},mandate=${C.mandate},action=start-window`,
    `chain=31337,dao=${C.dao},mandate=${C.mandate},agreement=${agreementId},action=start-window,extra=1`,
    `chain=31337,dao=${C.dao},mandate=${C.mandate},agreement=${agreementId},action=start-window,action=settle-agreement`,
  ];
  for (const spec of rejects) {
    assert.throws(() => lib.parseJobSpec(spec), (e) => e instanceof lib.UsageError, `expected UsageError for '${spec}'`);
  }
});

// ---------------------------------------------------------------------------
// RPC surface enforcement (loopback + anvil only)
// ---------------------------------------------------------------------------

test("public/non-anvil RPC is refused before any request is ever made", async () => {
  assert.throws(() => new lib.RpcClient("http://example.com:8545"), (e) => e instanceof lib.UsageError);
  assert.throws(() => new lib.RpcClient("https://127.0.0.1:8545"), (e) => e instanceof lib.UsageError);
  // a dead loopback port: no anvil_metadata → EnvironmentChanged, never eligible
  await assert.rejects(
    async () => {
      const rpc = new lib.RpcClient(`http://127.0.0.1:${DEAD_LOOPBACK_PORT}`);
      await lib.readEnvironmentIdentity(rpc);
    },
    (e) => e instanceof lib.EnvironmentChanged,
  );
});

// ---------------------------------------------------------------------------
// journal: permissions, atomic persistence; records never deleted
// ---------------------------------------------------------------------------

test("journal: 0700 dir, 0600 files, records survive a re-load unchanged", () => {
  const journal = lib.Journal.ensure(tempDir("journal-perms"));
  const id = lib.parseJobSpec(JOB_START);
  const now = new Date().toISOString();
  journal.saveJob({
    format: lib.JOURNAL_FORMAT,
    identity: id,
    state: "failed",
    createdAt: now,
    updatedAt: now,
    history: [{ at: now, to: "failed", note: "example failure" }],
  });
  assert.equal(fs.statSync(journal.dir).mode & 0o777, 0o700, "journal dir must be 0700");
  assert.equal(fs.statSync(path.join(journal.dir, lib.jobFileSlug(id))).mode & 0o777, 0o600, "journal file must be 0600");
  journal.saveEnvironment({ fingerprint: "x", boundAt: now });
  assert.equal(fs.statSync(path.join(journal.dir, lib.JOURNAL_ENV_NAME)).mode & 0o777, 0o600);
  const again = journal.loadJob(id);
  assert.equal(again.state, "failed");
  assert.equal(again.history.length, 1);
});

// ---------------------------------------------------------------------------
// lock discipline: single worker; an explicit --reclaim only for a dead holder
// ---------------------------------------------------------------------------

test("lock: a second worker is refused while a live holder owns the journal", () => {
  const journal = lib.Journal.ensure(tempJournal("lock-live"));
  const holder = { pid: process.pid, startedAt: new Date().toISOString(), host: os.hostname() };
  journal.acquireLock(holder);
  assert.throws(
    () => journal.acquireLock(holder),
    (e) => e instanceof lib.LockBusy && e.holder?.pid === process.pid,
  );
  journal.releaseLock(holder);
  // after release a later holder acquires cleanly
  journal.acquireLock(holder);
  journal.releaseLock(holder);
});

test("lock: a dead holder is reported (LockStale) until --reclaim; reclaim refuses a live holder", () => {
  const journal = lib.Journal.ensure(tempJournal("lock-stale"));
  // find a pid that is really not running.
  let deadPid = null;
  for (let p = 600_000; p < 602_000; p++) {
    try {
      process.kill(p, 0);
    } catch (e) {
      if (e?.code === "ESRCH") {
        deadPid = p;
        break;
      }
    }
  }
  if (deadPid == null) return; // pid space oddity; skip this test (unix-only guard)
  fs.writeFileSync(
    path.join(journal.dir, lib.JOURNAL_LOCK_NAME),
    JSON.stringify({ pid: deadPid, startedAt: "gone" }),
    { mode: 0o600 },
  );
  assert.throws(
    () => journal.acquireLock({ pid: process.pid, startedAt: "x", host: "x" }),
    (e) => e instanceof lib.LockStale && new RegExp(`pid ${deadPid}`).test(e.message),
  );
  // the operator's explicit --reclaim takes it over ONLY because the holder is dead
  journal.reclaimLock({ pid: process.pid, startedAt: "y", host: "y" });
  journal.releaseLock({ pid: process.pid, startedAt: "y", host: "y" });
  // reclaim against a LIVE holder refuses (never steals)
  const holder = { pid: process.pid, startedAt: new Date().toISOString(), host: os.hostname() };
  journal.acquireLock(holder);
  assert.throws(
    () => journal.reclaimLock({ pid: process.pid + 1, startedAt: "other", host: "x" }),
    (e) => e instanceof lib.LockBusy,
  );
  journal.releaseLock(holder);
});

// ---------------------------------------------------------------------------
// fixture signer rules
// ---------------------------------------------------------------------------

test("fixture signer: every well-known anvil key derives to its listed address (and only those sign)", () => {
  // The fixture list is the worker's whole signer allowlist: an entry that does
  // not match the key's real derivation silently refuses a legitimate anvil
  // account (or, worse, mislabels one). Every entry must be a 20-byte address
  // and every key must derive exactly to its mapped address.
  assert.equal(lib.WELLKNOWN_ANVIL_ADDRESSES.length, 10);
  for (const address of lib.WELLKNOWN_ANVIL_ADDRESSES) {
    assert.match(address, /^0x[0-9a-f]{40}$/, `well-known address is not 20 bytes: ${address}`);
  }
  for (const [key, expected] of Object.entries(lib.WELLKNOWN_ANVIL_KEYS)) {
    const derived = spawnSync("cast", ["wallet", "address", "--private-key", key], { encoding: "utf8" });
    assert.equal(derived.status, 0, `cast wallet address failed for a listed key: ${derived.stderr}`);
    assert.equal(derived.stdout.trim().toLowerCase(), expected, `key ${key.slice(0, 10)}… must derive to ${expected}`);
    assert.ok(lib.WELLKNOWN_ANVIL_ADDRESSES.includes(expected), `${expected} is listed as an address`);
    // and the signer accepts it
    assert.equal(new lib.FixtureSigner(key).ensureWellknown(), expected);
  }

  assert.equal(new lib.FixtureSigner(FIXTURE_KEY).ensureWellknown(), FIXTURE_ADDRESS);
  assert.throws(() => new lib.FixtureSigner(NON_WELLKNOWN_KEY).ensureWellknown(), (e) => e instanceof lib.UsageError);
  assert.throws(() => new lib.FixtureSigner("not-a-key"), (e) => e instanceof lib.UsageError);
  // well-known ≠ well-known cross-derivations are also refused
  const forged = new lib.FixtureSigner(NON_WELLKNOWN_KEY);
  lib.WELLKNOWN_ANVIL_KEYS[NON_WELLKNOWN_KEY] = FIXTURE_ADDRESS; // force a mismatch
  try {
    // cast derives the real key; the fake map makes them disagree → refuse
    assert.throws(() => forged.ensureWellknown(), (e) => e instanceof lib.UsageError);
  } finally {
    delete lib.WELLKNOWN_ANVIL_KEYS[NON_WELLKNOWN_KEY];
  }
});

async function fakeRun(anvil, journal, spec, extra = {}) {
  return await lib.runFinalizer({
    journalDir: journal,
    rpcUrl: anvil.url,
    jobs: [{ identity: parseJob(spec), spec }],
    fixtureKey: FIXTURE_KEY,
    optInFixtureWrites: true,
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// start-window journey (the canonical happy path)
// ---------------------------------------------------------------------------

test("start-window journey: quorum verified, exactly one settle() broadcast, confirmed at depth 1", async () => {
  const state = fakeBaseState();
  const anvil = new FakeAnvil();
  anvil.withContracts(C).withState(state);
  wireStartWindowEffects(anvil, state);
  await anvil.listen();
  try {
    const journal = tempJournal("journey-sw");
    const id = parseJob(JOB_START);
    const result = await fakeRun(anvil, journal, JOB_START);
    assert.equal(result.exitCode, 0, JSON.stringify(result, null, 2));
    assert.equal(anvil.broadcasts.length, 1, "exactly one broadcast");
    const tx = decodeLegacyTx(anvil.broadcasts[0]);
    // the ONLY allowed calldata, exactly `settle(claimId)`, at the claims escrow
    assert.equal(tx.to, C.claims);
    assert.equal(tx.data, lib.encodeFunctionData(lib.SIG.settle, ["bytes32"], [claimId]));
    assert.equal(tx.value, "0x0", "the worker pays no native value");
    // journal: the full state trail, no key material, the raw stays recoverable
    const rec = jobRecord(journal, id);
    assert.deepEqual(rec.history.map((h) => h.to), ["queued", "prepared", "submitted", "confirmed"]);
    const raw = JSON.stringify(rec);
    assert.ok(!raw.includes("ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"), "no key hex in the journal");
    assert.ok(raw.includes(FIXTURE_ADDRESS), "the derived address IS recorded");
    assert.ok(rec.prepared?.signedRaw, "the signed raw is journaled");
    assert.ok(rec.prepared?.signedHash, "the hash is journaled");
    assert.ok(rec.prepared?.callDigest, "the call-derivation digest is journaled");
    assert.ok(rec.confirmed?.depth, "the confirmation depth is journaled");
  } finally {
    anvil.close();
  }
});

// — quorum gate: below quorum → blocked, NOTHING signed —
test("start-window: approval quorum short → blocked; nothing signed", async () => {
  const state = fakeBaseState();
  state.claims[claimId].approvals = 0;
  const anvil = new FakeAnvil();
  anvil.withContracts(C).withState(state);
  await anvil.listen();
  try {
    const journal = tempJournal("sw-short");
    const result = await fakeRun(anvil, journal, JOB_START);
    assert.equal(result.exitCode, 7);
    assert.equal(anvil.broadcasts.length, 0);
    assert.equal(jobRecord(journal, parseJob(JOB_START)).blocked.reason, "approval-quorum-not-reached");
  } finally {
    anvil.close();
  }
});

// — snapshot-relative quorum: attestations before submission are not eligibility —
test("start-window: pre-submission attestations are not eligibility (snapshot-relative)", async () => {
  const state = fakeBaseState();
  state.claims[claimId].approvals = 2;
  state.claims[claimId].approvalsAtSubmit = 2; // both pre-dated submit → delta 0
  const anvil = new FakeAnvil();
  anvil.withContracts(C).withState(state);
  await anvil.listen();
  try {
    const journal = tempJournal("sw-delta");
    const result = await fakeRun(anvil, journal, JOB_START);
    assert.equal(result.exitCode, 7);
    assert.equal(anvil.broadcasts.length, 0);
    assert.equal(jobRecord(journal, parseJob(JOB_START)).blocked.reason, "approval-quorum-not-reached");
  } finally {
    anvil.close();
  }
});

// — objection-quorum veto: the worker NEVER settles into the slash branch —
test("start-window: objection quorum → blocked; the worker never signs a slash", async () => {
  const state = fakeBaseState();
  state.claims[claimId].objections = 1; // same quorum (1) reached → slash parity by quorum convention
  const anvil = new FakeAnvil();
  anvil.withContracts(C).withState(state);
  await anvil.listen();
  try {
    const journal = tempJournal("sw-objection");
    const result = await fakeRun(anvil, journal, JOB_START);
    assert.equal(result.exitCode, 7);
    assert.equal(anvil.broadcasts.length, 0, "there is no path where an objection quorum gets signed");
    assert.equal(jobRecord(journal, parseJob(JOB_START)).blocked.reason, "objection-quorum-reached");
  } finally {
    anvil.close();
  }
});

// — a frozen claim is blocked (never a dispute-resolution path) —
test("start-window: a frozen (disputed) claim blocks; no signature", async () => {
  const state = fakeBaseState();
  state.claims[claimId].status = 3; // Frozen
  const anvil = new FakeAnvil();
  anvil.withContracts(C).withState(state);
  await anvil.listen();
  try {
    const journal = tempJournal("sw-frozen");
    const result = await fakeRun(anvil, journal, JOB_START);
    assert.equal(result.exitCode, 7);
    assert.equal(anvil.broadcasts.length, 0);
    assert.equal(jobRecord(journal, parseJob(JOB_START)).blocked.reason, "claim-not-open");
  } finally {
    anvil.close();
  }
});

// — the claim must be the beneficiary's and the agreed check —
test("start-window: a claim whose beneficiary/checkHash drift is blocked (terms binding)", async () => {
  const state = fakeBaseState();
  state.claims[claimId].contributor = fakeAddr(0x9999); // not the beneficiary
  const anvil = new FakeAnvil();
  anvil.withContracts(C).withState(state);
  await anvil.listen();
  try {
    const journal = tempJournal("sw-drift");
    const result = await fakeRun(anvil, journal, JOB_START);
    assert.equal(result.exitCode, 7);
    assert.equal(anvil.broadcasts.length, 0);
    assert.equal(jobRecord(journal, parseJob(JOB_START)).blocked.reason, "claim-not-beneficiaries");
  } finally {
    anvil.close();
  }
});

// — the capability gate: anything but AGREEMENTS_VERSION()==1 is an unknown —
test("start-window: a mandate whose AGREEMENTS_VERSION is not 1 is refused as unknown (never legacy)", async () => {
  const state = fakeBaseState();
  state.noVersion = true; // the getter reverts
  const anvil = new FakeAnvil();
  anvil.withContracts(C).withState(state);
  await anvil.listen();
  try {
    const journal = tempJournal("sw-noversion");
    const result = await fakeRun(anvil, journal, JOB_START);
    assert.equal(result.exitCode, 7);
    assert.equal(anvil.broadcasts.length, 0);
    const rec = jobRecord(journal, parseJob(JOB_START));
    assert.equal(rec.blocked.reason, "unknown-contract-read");
    assert.ok(!["legacy"].includes(rec.state), "no legacy state label exists in this worker's states");
    assert.ok(!/legacy/.test(rec.blocked.reason), "the subject reason is never 'legacy'");
  } finally {
    anvil.close();
  }
});

// — provenance: a mandate naming a DIFFERENT dao is a refusal —
test("start-window: mandate.DAO() mismatch is a provenance refusal; nothing signed", async () => {
  const state = fakeBaseState();
  state.factoryDaos = { [C.mandate]: fakeAddr(0xbef1) }; // the mandate's record names a FOREIGN dao
  const anvil = new FakeAnvil();
  anvil.withContracts(C).withState(state);
  await anvil.listen();
  try {
    const journal = tempJournal("sw-provenance");
    const result = await fakeRun(anvil, journal, JOB_START);
    assert.equal(result.exitCode, 7);
    assert.equal(anvil.broadcasts.length, 0);
    const rec = jobRecord(journal, parseJob(JOB_START));
    assert.match(rec.blocked.reason, /provenance-mismatch|unknown-contract-read/);
  } finally {
    anvil.close();
  }
});

// ---------------------------------------------------------------------------
// settle-agreement journeys
// ---------------------------------------------------------------------------

test("settle-agreement: a window-not-started claim is blocked BEFORE any signing", async () => {
  const state = fakeBaseState();
  state.claims[claimId].status = 1; // Approved
  state.claims[claimId].releasedAt = anvil_blockTimestampForFake(); // released now
  const anvil = new FakeAnvil();
  anvil.withContracts(C).withState(state);
  await anvil.listen();
  try {
    const journal = tempJournal("sa-window-fresh");
    const result = await fakeRun(anvil, journal, JOB_SETTLE);
    assert.equal(result.exitCode, 7);
    assert.equal(anvil.broadcasts.length, 0);
    assert.equal(jobRecord(journal, parseJob(JOB_SETTLE)).blocked.reason, "challenge-window-not-elapsed");
  } finally {
    anvil.close();
  }
});

function anvil_blockTimestampForFake() {
  // the fake chain's "now" as its block timestamp (1_700_000_000) — releasedAt must read
  // "the window has NOT yet passed" -> exactly this, so the gate refuses.
  return 1_700_000_000n;
}

test("settle-agreement: an already-consumed claim refuses (one delivery, one reward)", async () => {
  const state = fakeBaseState();
  state.contributionAwarded[claimId] = true;
  state.claims[claimId].status = 1; // Approved (the consumption read comes after status gating)
  state.claims[claimId].releasedAt = 1n;
  const anvil = new FakeAnvil();
  anvil.withContracts(C).withState(state);
  await anvil.listen();
  try {
    const journal = tempJournal("sa-consumed");
    const result = await fakeRun(anvil, journal, JOB_SETTLE);
    assert.equal(result.exitCode, 7);
    assert.equal(anvil.broadcasts.length, 0);
    assert.equal(jobRecord(journal, parseJob(JOB_SETTLE)).blocked.reason, "claim-already-consumed");
  } finally {
    anvil.close();
  }
});

/**
 * The canonical settle-agreement journey: splits derived from the record
 * getters (80% / 20% over 5 shares → 4e18 + 1e18), simulate ok, one broadcast,
 * receipt at depth 1, all chain-state effects verified → confirmed.
 */
test("settle-agreement journey: split 80/20 over 5 shares mints 4e18 + 1e18 exactly once", async () => {
  const state = fakeBaseState();
  state.blockTimestamp = 1;
  state.claims[claimId].status = 1; // Approved
  state.claims[claimId].releasedAt = 1n;
  state.claims[claimId].expiresAt = 1n;
  state.challengeWindow = 604800n; // 7 days; now (1) is way at 1_700_000_000 so the window is over
  let runCount = 0;
  const anvil = new FakeAnvil();
  anvil.withContracts(C).withState(state);
  await anvil.listen();
  try {
    anvil.onBroadcast = async (raw, hash) => {
      runCount++;
      // Flip the chain state exactly like the real settleAgreement does, and
      // register the receipt with the exact known mint logs.
      applyPostSettle(state);
      anvil.setReceipt(hash, {
        transactionHash: hash,
        blockNumber: "0x" + anvil.head.toString(16),
        blockHash: "0x" + "8".repeat(64),
        status: "0x1",
        logs: settledLogs({}),
      });
      anvil.blockHashes.set("0x" + anvil.head.toString(16), "0x" + "8".repeat(64));
    };
    const journal = tempJournal("journal-sa");
    const id = parseJob(JOB_SETTLE);
    const result = await fakeRun(anvil, journal, JOB_SETTLE);
    assert.equal(result.exitCode, 0, JSON.stringify(result, null, 2));
    assert.equal(anvil.broadcasts.length, 1);
    const tx = decodeLegacyTx(anvil.broadcasts[0]);
    // the ONLY allowed calldata on the DAO: settleAgreement(mandate, agreementId)
    assert.equal(tx.to, C.dao);
    assert.equal(
      tx.data,
      lib.encodeFunctionData(lib.SIG.daoSettleAgreement, ["address", "bytes32"], [C.mandate, agreementId]),
    );
    assert.equal(tx.value, "0x0");
    const rec = jobRecord(journal, id);
    assert.deepEqual(rec.history.map((h) => h.to), ["queued", "prepared", "submitted", "confirmed"]);
    // The expected recipients/amounts came from the mandate's OWN settlement
    // (simulated from the DAO) cross-checked against `splits(bytes32)`'s
    // declared count — never from the DAO-level call, which returns nothing.
    assert.deepEqual(
      rec.expected.recipients.map((r) => r.address),
      [beneficiary, coauthor],
    );
    assert.equal(BigInt(rec.expected.recipients[0].portion), BigInt(SHARES * 8000n) / 10000n);
    assert.equal(BigInt(rec.expected.recipients[1].portion), BigInt(SHARES * 2000n) / 10000n);
    assert.equal(BigInt(rec.expected.awardTotal), BigInt(SHARES));
    assert.equal(rec.confirmed.depth, "1");
  } finally {
    anvil.close();
  }
});

/**
 * No-split agreement: a single recipient takes the full reserved quantity.
 */
test("settle-agreement: no split → the beneficiary takes the full quantity, one mint row", async () => {
  const state = fakeBaseState({ withSplit: false });
  state.blockTimestamp = 1;
  state.claims[claimId].status = 1;
  state.claims[claimId].releasedAt = 1n;
  const anvil = new FakeAnvil();
  anvil.withContracts(C).withState(state);
  await anvil.listen();
  try {
    anvil.onBroadcast = async (raw, hash) => {
      applyPostSettle(state, BigInt(SHARES), 0n);
      const blockHash = "0x" + "8".repeat(64);
      anvil.setReceipt(hash, {
        transactionHash: hash,
        blockNumber: "0x" + anvil.head.toString(16),
        blockHash,
        status: "0x1",
        logs: [
          { ...settledLogs({})[0], data: "0x" + BigInt(SHARES).toString(16).padStart(64, "0") },
          settledLogs({})[2],
        ],
      });
      anvil.blockHashes.set("0x" + anvil.head.toString(16), blockHash);
    };
    const journal = tempJournal("sa-nosplit");
    const id = parseJob(JOB_SETTLE);
    const result = await fakeRun(anvil, journal, JOB_SETTLE);
    assert.equal(result.exitCode, 0, JSON.stringify(result, null, 2));
    const rec = jobRecord(journal, id);
    assert.equal(rec.expected.recipients.length, 1);
    assert.equal(rec.expected.recipients[0].address, beneficiary);
    assert.equal(BigInt(rec.expected.recipients[0].portion), BigInt(SHARES));
  } finally {
    anvil.close();
  }
});

// — the declared split count and the settlement must agree —
test("settle-agreement: a settlement contradicting the declared split count is blocked; nothing signed", async () => {
  const state = fakeBaseState(); // splits(bytes32) declares 2 parties
  state.blockTimestamp = 1;
  state.claims[claimId].status = 1;
  state.claims[claimId].releasedAt = 1n;
  // the mandate's own answer names ONE recipient although the declared split has
  // two: the terms and the settlement disagree, so there is no trustworthy
  // expectation — the worker must refuse rather than pick either.
  state.settlementOverride = { parties: [beneficiary], portions: [SHARES] };
  const anvil = new FakeAnvil();
  anvil.withContracts(C).withState(state);
  await anvil.listen();
  try {
    const journal = tempJournal("sa-count-mismatch");
    const result = await fakeRun(anvil, journal, JOB_SETTLE);
    assert.equal(result.exitCode, 7, JSON.stringify(result, null, 2));
    assert.equal(anvil.broadcasts.length, 0, "nothing is signed on a contradictory expectation");
    const rec = jobRecord(journal, parseJob(JOB_SETTLE));
    assert.equal(rec.state, "blocked");
    assert.equal(rec.blocked.reason, "unknown-contract-read");
    assert.match(rec.blocked.detail, /declares 2 split part/);
    assert.equal(rec.prepared, null);
  } finally {
    anvil.close();
  }
});

// — the settlement's portions must total exactly the reserved quantity —
test("settle-agreement: a settlement whose portions do not sum to the reserved shares is blocked", async () => {
  const state = fakeBaseState();
  state.blockTimestamp = 1;
  state.claims[claimId].status = 1;
  state.claims[claimId].releasedAt = 1n;
  state.settlementOverride = {
    parties: [beneficiary, coauthor],
    portions: [BigInt(SHARES), 1n], // one unit more than the reservation
  };
  const anvil = new FakeAnvil();
  anvil.withContracts(C).withState(state);
  await anvil.listen();
  try {
    const journal = tempJournal("sa-sum-mismatch");
    const result = await fakeRun(anvil, journal, JOB_SETTLE);
    assert.equal(result.exitCode, 7, JSON.stringify(result, null, 2));
    assert.equal(anvil.broadcasts.length, 0);
    const rec = jobRecord(journal, parseJob(JOB_SETTLE));
    assert.equal(rec.blocked.reason, "unknown-contract-read");
    assert.match(rec.blocked.detail, /portions sum/);
  } finally {
    anvil.close();
  }
});

// — the claim's durable one-delivery binding is what `confirmed` requires —
test("settle-agreement: an unbound claim (no agreementOfClaim) is observed-mismatch, never confirmed", async () => {
  const state = fakeBaseState();
  state.blockTimestamp = 1;
  state.claims[claimId].status = 1;
  state.claims[claimId].releasedAt = 1n;
  const anvil = new FakeAnvil();
  anvil.withContracts(C).withState(state);
  await anvil.listen();
  try {
    anvil.onBroadcast = async (raw, hash) => {
      applyPostSettle(state);
      // every mint/balance/supply effect is exact, but the claim is not bound to
      // its agreement — the one-delivery latch did not hold, so this is not a
      // verified settlement.
      delete state.agreementOfClaimByClaim[claimId];
      const blockHash = "0x" + "8".repeat(64);
      anvil.setReceipt(hash, {
        transactionHash: hash,
        blockNumber: "0x" + anvil.head.toString(16),
        blockHash,
        status: "0x1",
        logs: settledLogs({}),
      });
      anvil.blockHashes.set("0x" + anvil.head.toString(16), blockHash);
    };
    const journal = tempJournal("sa-unbound");
    const result = await fakeRun(anvil, journal, JOB_SETTLE);
    assert.equal(result.exitCode, 5, JSON.stringify(result, null, 2));
    const rec = jobRecord(journal, parseJob(JOB_SETTLE));
    assert.equal(rec.state, "observed-mismatch");
    assert.ok(
      rec.observed.issues.some((issue) => /agreementOfClaim\(claimId\)/.test(issue)),
      `the mismatch names the missing binding: ${JSON.stringify(rec.observed.issues)}`,
    );
  } finally {
    anvil.close();
  }
});

// — a wrong-mint receipt is NEVER a success —
test("settle-agreement: a receipt whose mints miss the expectation is observed-mismatch; --reconcile may alone confirm", async () => {
  const state = fakeBaseState();
  state.blockTimestamp = 1;
  state.claims[claimId].status = 1;
  state.claims[claimId].releasedAt = 1n;
  const wrong = (BigInt(SHARES * 2000n) / 10000n) * 2n; // coautho gets 2e18 instead of 1e18
  const anvil = new FakeAnvil();
  anvil.withContracts(C).withState(state);
  await anvil.listen();
  try {
    anvil.onBroadcast = async (raw, hash) => {
      // the CHAIN ledger moves too much (a wrong balance leg) while the
      // receipt's known mint logs are correct — the balance verification
      // surfaces the discrepancy and refuses to say `confirmed`.
      applyPostSettle(state, BigInt(SHARES * 8000n) / 10000n, wrong);
      const blockHash = "0x" + "8".repeat(64);
      anvil.setReceipt(hash, {
        transactionHash: hash,
        blockNumber: "0x" + anvil.head.toString(16),
        blockHash,
        status: "0x1",
        logs: settledLogs({}),
      });
      anvil.blockHashes.set("0x" + anvil.head.toString(16), blockHash);
    };
    const journal = tempJournal("sa-mismatch");
    const id = parseJob(JOB_SETTLE);
    const result = await fakeRun(anvil, journal, JOB_SETTLE);
    assert.equal(result.exitCode, 5, JSON.stringify(result, null, 2));
    const rec = jobRecord(journal, id);
    assert.equal(rec.state, "observed-mismatch");
    assert.ok(rec.observed.issues.length >= 1, "issues recorded for the operator");
    assert.ok(rec.prepared?.signedRaw, "records kept; the SAME raw stays recoverable");
    // — the operator's explicit reconcile (still no broadcast) re-reads the
    //   chain truth: the same receipt, the ledger repaired to the exact
    //   expectation → only this manual pass may clear the state.
    state.shareBalances[coauthor.toLowerCase()] =
      BigInt(state.shareBalances[coauthor.toLowerCase()] ?? 0n) - wrong + BigInt(SHARES * 2000n) / 10000n;
    state.shareSupply = BigInt(state.shareSupply ?? 0n) - wrong + BigInt(SHARES * 2000n) / 10000n;
    const reconcile = await lib.executeReconcile(journal, id, { rpcUrl: anvil.url, onLog: () => {} });
    assert.equal(reconcile.exitCode, 0, JSON.stringify(reconcile, null, 2));
    assert.equal(jobRecord(journal, id).state, "confirmed");
    assert.equal(anvil.broadcasts.length, 1, "reconcile never broadcasts");
  } finally {
    anvil.close();
  }
});

// — a mined revert is a real failure; records kept; --retry requeues; SAME raw —
test("settle-agreement: a mined revert is failed with records kept, and --retry reuses the SAME raw", async () => {
  const state = fakeBaseState();
  state.blockTimestamp = 1;
  state.claims[claimId].status = 1;
  state.claims[claimId].releasedAt = 1n;
  let revertFirst = true;
  let broadcasted = 0;
  const anvil = new FakeAnvil();
  anvil.withContracts(C).withState(state);
  await anvil.listen();
  try {
    anvil.onBroadcast = async (raw, hash) => {
      broadcasted++;
      if (revertFirst) {
        anvil.setReceipt(hash, {
          transactionHash: hash,
          blockNumber: "0x" + anvil.head.toString(16),
          blockHash: "0x" + "8".repeat(64),
          status: "0x0",
          logs: [],
        });
        anvil.blockHashes.set("0x" + anvil.head.toString(16), "0x" + "8".repeat(64));
        return;
      }
      applyPostSettle(state);
      anvil.setReceipt(hash, {
        transactionHash: hash,
        blockNumber: "0x" + anvil.head.toString(16),
        blockHash: "0x" + "8".repeat(64),
        status: "0x1",
        logs: settledLogs({}),
      });
      anvil.blockHashes.set("0x" + anvil.head.toString(16), "0x" + "8".repeat(64));
    };
    const journal = tempJournal("sa-revert");
    const id = parseJob(JOB_SETTLE);
    const first = await fakeRun(anvil, journal, JOB_SETTLE);
    assert.equal(first.exitCode, 6, JSON.stringify(first, null, 2));
    const rec1 = jobRecord(journal, id);
    assert.equal(rec1.state, "failed");
    assert.equal(rec1.failed.reason, "tx-reverted-onchain");
    const rawBefore = rec1.prepared.signedRaw;
    assert.ok(rawBefore, "the raw survives the failure (records are never deleted)");
    assert.equal(broadcasted, 1);
    // manual --retry: requeues; nothing deleted; the SAME raw is on disk
    await lib.retryJob(journal, id, { onLog: () => {} });
    assert.equal(jobRecord(journal, id).state, "queued");
    assert.equal(jobRecord(journal, id).prepared?.signedRaw, rawBefore);
    // second run: chain truth fixed; the SAME raw goes back out and confirms
    revertFirst = false;
    const second = await fakeRun(anvil, journal, JOB_SETTLE);
    assert.equal(second.exitCode, 0, JSON.stringify(second, null, 2));
    assert.equal(broadcasted, 2);
    assert.deepEqual(anvil.broadcasts, [rawBefore, rawBefore], "the retry broadcasts the SAME raw bytes");
    assert.equal(jobRecord(journal, id).state, "confirmed");
  } finally {
    anvil.close();
  }
});

// — receipt at depth 0 is not a success —
test("confirm depth: a receipt with insufficient depth keeps state submitted (never a success)", async () => {
  const state = fakeBaseState();
  const anvil = new FakeAnvil();
  anvil.withContracts(C).withState(state);
  await anvil.listen();
  try {
    const journal = tempJournal("depth0");
    const id = parseJob(JOB_START);
    const result = await fakeRun(anvil, journal, JOB_START, { confirmDepth: 2 }); // head at N; receipt at N → depth 1 < 2
    assert.equal(result.exitCode, 2, JSON.stringify(result, null, 2));
    const rec = jobRecord(journal, id);
    assert.equal(rec.state, "submitted");
    assert.ok(rec.history.some((h) => /depth \d+ < required/.test(h.note ?? "")));
  } finally {
    anvil.close();
  }
});

// — reorg: a receipt whose block the chain no longer holds keeps submitted —
test("reorg: a non-canonical receipt keeps the job intact on the SAME raw (no double award)", async () => {
  const state = fakeBaseState();
  const anvil = new FakeAnvil();
  anvil.withContracts(C).withState(state);
  await anvil.listen();
  try {
    // the receipt gets a block hash; then the chain answers that a
    // DIFFERENT hash sits at that height — an active reorg.
    anvil.onBroadcast = async (raw, hash) => {
      // canonical receipt at head with blockHash A, including the settle's
      // effect (the window started — the chain state is consistent the way a
      // real post-reorg chain would be).
      applyStartWindow(state);
      const blockHashA = randHex64();
      anvil.setReceipt(hash, {
        transactionHash: hash,
        blockNumber: "0x" + anvil.head.toString(16),
        blockHash: blockHashA,
        status: "0x1",
        logs: claimReleasedReceipt(hash, "0x" + anvil.head.toString(16)).logs,
      });
      // but the chain's block at that height answers with hash B (move).
      anvil.blockHashes.set("0x" + anvil.head.toString(16), randHex64());
    };
    const journal = tempJournal("reorg");
    const id = parseJob(JOB_START);
    const result = await fakeRun(anvil, journal, JOB_START);
    assert.equal(result.exitCode, 2, JSON.stringify(result, null, 2));
    const rec = jobRecord(journal, id);
    assert.equal(rec.state, "submitted", "never confirmed on a non-canonical receipt");
    assert.ok(rec.history.some((h) => /reorg/i.test(h.note ?? "")), "the reorg is on record");
    // rereading later with the block canonical again → confirm same raw
    const blockHashA = jobRecord(journal, id).confirmed?.blockHash; // (not yet confirmed — nothing)
    anvil.blockHashes.clear();
    anvil.blockHashes.set(
      "0x" + anvil.head.toString(16),
      anvil.receipts.get(rec.signedHash).blockHash,
    );
    const second = await fakeRun(anvil, journal, JOB_START);
    assert.equal(second.exitCode, 0);
    assert.equal(anvil.broadcasts.length, 1, "NO additional broadcast: the same raw reconciled");
    assert.equal(jobRecord(journal, id).state, "confirmed");
  } finally {
    anvil.close();
  }
});

// — receipt absent (no confirmation depth reached; not success) —
test("receipt absence keeps submitted, never a success; later run confirms the SAME tx", async () => {
  const state = fakeBaseState();
  const anvil = new FakeAnvil();
  anvil.withContracts(C).withState(state);
  wireStartWindowEffects(anvil, state);
  await anvil.listen();
  try {
    const journal = tempJournal("receipt-loss");
    const id = parseJob(JOB_START);
    // first pass: broadcast accepted, then the receipt is LOST (null)
    anvil.onBroadcast = async (raw, hash) => {
      anvil.setReceipt(hash, null); // receipt lost on the first pass
    };
    const first = await fakeRun(anvil, journal, JOB_START);
    assert.equal(first.exitCode, 2);
    assert.equal(jobRecord(journal, id).state, "submitted");
    const stuckHash = jobRecord(journal, id).signedHash;
    // second pass: the receipt is there now → confirm, same raw, no rebroadcast.
    // (No broadcast happens, so the test registers the receipt explicitly.)
    anvil.setReceipt(stuckHash, {
      transactionHash: stuckHash,
      blockNumber: "0x" + anvil.head.toString(16),
      blockHash: "0x" + "8".repeat(64),
      status: "0x1",
      logs: [
        {
          address: C.claims,
          topics: [lib.CLAIM_RELEASED_TOPIC_EXPORT, "0x" + claimId.slice(2), "0x" + beneficiary.toLowerCase().slice(2).padStart(64, "0")],
          data: "0x" + "0".repeat(64),
        },
      ],
    });
    anvil.blockHashes.set("0x" + anvil.head.toString(16), "0x" + "8".repeat(64));
    applyStartWindow(state);
    const second = await fakeRun(anvil, journal, JOB_START);
    assert.equal(second.exitCode, 0, JSON.stringify(second, null, 2));
    assert.equal(jobRecord(journal, id).state, "confirmed");
    assert.equal(anvil.broadcasts.length, 1);
  } finally {
    anvil.close();
  }
});

// — transient broadcast problems: bounded retries with backoff, record kept —
test("broadcast: transient failures retry bounded with backoff, keep the signed raw; a later run succeeds", async () => {
  const state = fakeBaseState();
  const anvil = new FakeAnvil();
  anvil.withContracts(C).withState(state);
  wireStartWindowEffects(anvil, state);
  anvil.injectTransientBroadcastFailures = 2; // two failures, then accept
  await anvil.listen();
  try {
    const journal = tempJournal("transient");
    const id = parseJob(JOB_START);
    const result = await fakeRun(anvil, journal, JOB_START, { maxAttempts: 3, backoffBaseMs: 10 });
    assert.equal(result.exitCode, 0, JSON.stringify(result, null, 2));
    const rec = jobRecord(journal, id);
    assert.equal(rec.state, "confirmed");
    assert.equal(anvil.broadcasts.length, 1);
    assert.equal(rec.broadcast.attempts.length, 3, "two transient rejections + one accept");
    assert.deepEqual(rec.broadcast.attempts.map((a) => a.outcome), ["transient", "transient", "accepted"]);
    assert.ok(rec.signedRaw !== undefined || rec.prepared?.signedRaw !== undefined, "record intact");
  } finally {
    anvil.close();
  }
});

// — a foreign nonce conflict is terminal failed (records kept, no fresh signing) —
test("broadcast: a foreign nonce conflict fails terminal; nothing is re-signed with a fresh nonce", async () => {
  const state = fakeBaseState();
  const anvil = new FakeAnvil();
  anvil.withContracts(C).withState(state);
  anvil.failBroadcastWithNonceError = true;
  await anvil.listen();
  try {
    const journal = tempJournal("nonce");
    const result = await fakeRun(anvil, journal, JOB_START);
    assert.equal(result.exitCode, 6);
    const rec = jobRecord(journal, parseJob(JOB_START));
    assert.equal(rec.state, "failed");
    assert.equal(rec.failed.reason, "nonce-consumed-externally");
    assert.ok(rec.prepared?.signedRaw, "the record with the failed raw stays");
  } finally {
    anvil.close();
  }
});

// ---------------------------------------------------------------------------
// crash-recovery via the real CLI subprocess (process death at the seams)
// ---------------------------------------------------------------------------

async function runCli(journal, anvilUrl, spec, env = {}, extraArgs = []) {
  // MUST be an async spawn: this parent hosts the fake anvil's server, so a
  // synchronous spawn would freeze the very endpoint the child talks to.
  return await new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [CLI, "run",
        "--journal", journal,
        "--rpc", anvilUrl,
        "--opt-in-fixture-writes",
        "--fixture-key", FIXTURE_KEY,
        "--job", spec,
        ...extraArgs],
      { env: { ...process.env, ...env } },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    const t = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("close", (status) => {
      clearTimeout(t);
      resolve({ status, stdout, stderr });
    });
  });
}

test("crash after signed persist: the next run broadcasts the SAME raw and confirms (real subprocess)", async () => {
  const state = fakeBaseState();
  const anvil = new FakeAnvil();
  anvil.withContracts(C).withState(state);
  wireStartWindowEffects(anvil, state);
  await anvil.listen();
  try {
    const journal = tempJournal("crash-persist");
    const id = parseJob(JOB_START);
    const crashed = await runCli(journal, anvil.url, JOB_START, {
      FINALIZER_TEST_FAULT: JSON.stringify({ crashBeforeBroadcast: 97 }),
    });
    assert.equal(crashed.status, 97, `expected the fault-exit; stdout=${crashed.stdout} stderr=${crashed.stderr}`);
    assert.equal(anvil.broadcasts.length, 0, "nothing broadcast before the crash");
    const rawAfterCrash = jobRecord(journal, id).prepared?.signedRaw;
    assert.ok(rawAfterCrash, "the signed raw persisted BEFORE broadcast survives");
    assert.equal(lib.keccakRaw(rawAfterCrash), jobRecord(journal, id).prepared?.signedHash);
    // recovery run: the SAME raw goes out; everything confirms. The crashed
    // worker left its lock — refusing until the operator explicitly reclaims
    // it (the safety rule: a dead holder's lock is never blindly stolen).
    const refusedWithoutReclaim = await runCli(journal, anvil.url, JOB_START);
    assert.equal(refusedWithoutReclaim.status, 3, "a dead holder's lock is refused before any work");
    assert.ok(/--reclaim/.test(refusedWithoutReclaim.stderr), "the refusal names the explicit --reclaim");
    assert.equal(anvil.broadcasts.length, 0, "nothing signed while the stale lock was refused");
    const second = await runCli(journal, anvil.url, JOB_START, {}, ["--reclaim"]);
    assert.equal(second.status, 0, `recovery run failed: ${second.stdout} ${second.stderr}`);
    assert.equal(anvil.broadcasts.length, 1);
    assert.equal(anvil.broadcasts[0], rawAfterCrash, "recovery uses the SAME signed raw bytes");
    assert.equal(jobRecord(journal, id).state, "confirmed");
  } finally {
    anvil.close();
  }
});

test("crash after broadcast: the stored hash reconciles on the next run (real subprocess)", async () => {
  const state = fakeBaseState();
  const anvil = new FakeAnvil();
  anvil.withContracts(C).withState(state);
  wireStartWindowEffects(anvil, state);
  await anvil.listen();
  try {
    const journal = tempJournal("crash-submit");
    const id = parseJob(JOB_START);
    const crashed = await runCli(journal, anvil.url, JOB_START, {
      FINALIZER_TEST_FAULT: JSON.stringify({ crashAfterSubmit: 96 }),
    });
    assert.equal(crashed.status, 96);
    assert.equal(anvil.broadcasts.length, 1);
    const stored = jobRecord(journal, id);
    assert.equal(stored.state, "submitted");
    assert.equal(stored.signedHash, lib.keccakRaw(anvil.broadcasts[0]));
    // recovery: reconcile via stored hash — no further broadcast; the stale
    // lock is refused until the operator's explicit --reclaim.
    const refusedWithoutReclaim = await runCli(journal, anvil.url, JOB_START);
    assert.equal(refusedWithoutReclaim.status, 3, "a dead holder's lock is refused before any work");
    const second = await runCli(journal, anvil.url, JOB_START, {}, ["--reclaim"]);
    assert.equal(second.status, 0, `recovery failed: ${second.stdout} ${second.stderr}`);
    assert.equal(anvil.broadcasts.length, 1, "recovery reuses the stored hash, never re-broadcasts");
    assert.equal(jobRecord(journal, id).state, "confirmed");
  } finally {
    anvil.close();
  }
});

// ---------------------------------------------------------------------------
// CLI-defenses: no writes without the explicit opt-in + a well-known key
// ---------------------------------------------------------------------------

test("CLI enforcement: missing opt-in / missing key / an arbitrary key are all usage errors", async () => {
  const anvil = new FakeAnvil();
  anvil.withContracts(C).withState(fakeBaseState());
  await anvil.listen();
  const spawnCli = async (args) => await new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
  try {
    const r0 = await spawnCli(["run", "--journal", tempJournal("cli-noptin"), "--rpc", anvil.url, "--job", JOB_START]);
    assert.equal(r0.status, 1, `stdout=${r0.stdout} stderr=${r0.stderr}`);
    assert.ok(/opt-in-fixture-writes/.test(r0.stderr));

    const r1 = await spawnCli(["run", "--journal", tempJournal("cli-nokey"), "--rpc", anvil.url,
      "--opt-in-fixture-writes", "--job", JOB_START]);
    assert.equal(r1.status, 1);
    assert.ok(/fixture-key/.test(r1.stderr));

    const r2 = await spawnCli(["run", "--journal", tempJournal("cli-badkey"), "--rpc", anvil.url,
      "--opt-in-fixture-writes", "--fixture-key", NON_WELLKNOWN_KEY, "--job", JOB_START]);
    assert.equal(r2.status, 1);
    assert.ok(/well-known/.test(r2.stderr), `stderr should cite well-known: ${r2.stderr}`);
  } finally {
    anvil.close();
  }
});

// — the journal is the ONLY work list: nothing is scanned, unknown jobs are new —
test("runner: only the operator's named --job list is processed (no scanner, no implicit work)", async () => {
  const state = fakeBaseState();
  state.blockTimestamp = 1;
  // a second agreement exists on the chain; it is NOT in the list.
  state.agreements[bytes32No(0x7bb1)] = { ...state.agreements[agreementId] };
  state.claims[claimId].status = 1;
  state.claims[claimId].releasedAt = 1n;
  const anvil = new FakeAnvil();
  anvil.withContracts(C).withState(state);
  await anvil.listen();
  try {
    anvil.onBroadcast = async (raw, hash) => {
      applyPostSettle(state);
      const blockHash = "0x" + "8".repeat(64);
      anvil.setReceipt(hash, {
        transactionHash: hash,
        blockNumber: "0x" + anvil.head.toString(16),
        blockHash,
        status: "0x1",
        logs: settledLogs({}),
      });
      anvil.blockHashes.set("0x" + anvil.head.toString(16), blockHash);
    };
    const journal = tempJournal("bounded-list");
    const result = await fakeRun(anvil, journal, JOB_SETTLE);
    assert.equal(result.exitCode, 0, JSON.stringify(result, null, 2));
    const files = fs.readdirSync(journal).filter((f) => f.startsWith("job-"));
    assert.equal(files.length, 1, `exactly the ONE named job was written: ${files}`);
  } finally {
    anvil.close();
  }
});

// ---------------------------------------------------------------------------
// environment reset (the fingerprint gate)
// ---------------------------------------------------------------------------

test("environment change: a different anvil instance → environment-changed, and the journal never rebinds", async () => {
  const state = fakeBaseState();
  state.claims[claimId].approvals = 0; // the first run blocks (known nonterminal state)
  const a1 = new FakeAnvil();
  a1.withContracts(C).withState(state);
  await a1.listen();
  try {
    const journal = tempJournal("env-change");
    const first = await fakeRun(a1, journal, JOB_START);
    assert.equal(first.exitCode, 7, "blocked on quorum (a nonterminal state)");
    assert.equal(jobRecord(journal, parseJob(JOB_START)).state, "blocked");
    // a different anvil instance (a fresh instanceId + genesis)
    const a2 = new FakeAnvil(); // NOT the same instance
    a2.withContracts(C).withState(state);
    await a2.listen();
    try {
      let thrown = null;
      try {
        await fakeRun(a2, journal, JOB_START);
      } catch (errThrown) {
        thrown = errThrown;
      }
      if (thrown == null) {
        const envFile = JSON.parse(fs.readFileSync(path.join(journal, lib.JOURNAL_ENV_NAME), "utf8"));
        const a2Env = await lib.readEnvironmentIdentity(new lib.RpcClient(a2.url));
        assert.equal(thrown, "neverBecauseEither-gate-a2-matches-journal", JSON.stringify({
          journalFingerprint: envFile.fingerprint,
          a2Fingerprint: a2Env.fingerprint,
          a1InstanceId: a1.instanceId,
          a2InstanceId: a2.instanceId,
        }));
      }
      assert.ok(thrown instanceof lib.EnvironmentChanged && /never rebinds/.test(thrown.message));
      const rec = jobRecord(journal, parseJob(JOB_START));
      assert.equal(rec.state, "environment-changed");
    } finally {
      a2.close();
    }
    // even the ORIGINAL node cannot revive the journal: the record stays
    // environment-changed and an ordinary run refuses to process it (exit 4).
    const revived = await fakeRun(a1, journal, JOB_START);
    assert.equal(revived.exitCode, 4);
    assert.equal(jobRecord(journal, parseJob(JOB_START)).state, "environment-changed");
  } finally {
    a1.close();
  }
});


// ---------------------------------------------------------------------------
// REAL-CHAIN PROGRESS: the production candidate journey on a scratch anvil
// ---------------------------------------------------------------------------
//
// Deploys the CURRENT candidate artifacts (`contracts/out` from `forge build`)
// on a scratch anvil — a free loopback port, this process's child only, killed
// by its own pid in `t.after` — and drives one agreed contribution end to end:
//
//   factory → policy → summoner → DAO summon → (DAO vote) mandate create
//   → (DAO vote) approveProject → proposeAgreement → submitClaim/setCheck
//   → acceptAgreement → bindSubmission → reviewer attest
//   → worker start-window (ClaimStake.settle) → challenge window elapsed
//   → worker settle-agreement (Moloch.settleAgreement)
//
// The journal must end `confirmed` with EXACT effects (recipients + minted
// quantities) verified against the real chain, not merely "no error". Two real
// refusals are exercised beside it — an objection quorum (whose settle would
// slash) and an unmet approval quorum — and in both the worker must sign
// nothing. The environment gate is then exercised by killing this anvil and
// re-running the same journal against a NEW instance.
//
// DEV-ONLY: anvil dev fixtures, loopback only; no real funds, no public
// writes, no commits.

const REPO_ROOT = path.resolve(path.join(HERE, ".."));
// The candidate build output. `forge build` writes to contracts/out; a run that
// keeps the worktree clean can point FOUNDRY_OUT elsewhere and pass it here.
const CANDIDATE_OUT = process.env.FINALIZER_CANDIDATE_OUT
  ? path.resolve(process.env.FINALIZER_CANDIDATE_OUT)
  : path.join(REPO_ROOT, "contracts", "out");
const CANDIDATE_ARTIFACTS = [
  "TreasuryMandate.sol/TreasuryMandate.json",
  "TreasuryMandate.sol/TreasuryMandateFactory.json",
  "MandatePartsFactory.sol/MandatePartsFactory.json",
  "ClaimStake.sol/ClaimStake.json",
  "VerifierSet.sol/VerifierSet.json",
  "Payouts.sol/PayoutsFactory.json",
  "FundingTerms.sol/FundingTerms.json",
  "MolochPatched.sol/Moloch.json",
  "MolochPatched.sol/Shares.json",
  "MolochPatched.sol/Summoner.json",
  "AllocationVoting.sol/AllocationVoting.json",
  // The mandate's currency fixture the contract suite itself uses (a plain
  // ERC20 with a no-arg constructor). `forge build` compiles test/ too.
  "TreasuryMandate.t.sol/MandateCurrency.json",
];

/**
 * The REAL-CHAIN integration only runs against the freshly compiled candidate.
 * When the stack is uncompilable the test SKIPS with the exact reason on
 * record (never a mocked pass) — see docs/v3-review/AGREEMENT-FINALIZER.md.
 */
function candidateArtifact(rel) {
  return JSON.parse(fs.readFileSync(path.join(CANDIDATE_OUT, rel), "utf8"));
}

async function candidateReady() {
  const missing = CANDIDATE_ARTIFACTS.filter((rel) => {
    try {
      const parsed = candidateArtifact(rel);
      return !parsed?.abi?.length || !parsed?.bytecode?.object;
    } catch {
      return true;
    }
  });
  if (missing.length > 0) {
    return { ok: false, reason: `contracts/out missing usable artifacts: ${missing.join(", ")}` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Candidate surface conformance
// ---------------------------------------------------------------------------

/** Canonical ABI type of an input/output, tuples expanded. */
function canonicalAbiType(entry) {
  if (entry.type === "tuple") return "(" + (entry.components ?? []).map(canonicalAbiType).join(",") + ")";
  const arraySuffix = /^tuple((\[\d*\])+)$/.exec(entry.type);
  if (arraySuffix) return "(" + (entry.components ?? []).map(canonicalAbiType).join(",") + ")" + arraySuffix[1];
  return entry.type;
}

function abiFunctionOf(abi, signature) {
  const open = signature.indexOf("(");
  const name = signature.slice(0, open);
  const args = signature.slice(open + 1, -1);
  return (abi ?? []).find(
    (entry) => entry.type === "function" && entry.name === name &&
      (entry.inputs ?? []).map(canonicalAbiType).join(",") === args,
  );
}

/**
 * Assert the freshly compiled candidate exposes exactly the frozen adapter
 * surface this worker speaks (AGREEMENTS_VERSION 1, the 13-field agreement
 * record, the split getters, the escrow/panel reads, and the DAO's
 * permissionless no-return settleAgreement). A stale build is then a clear
 * failure here instead of a confusing revert halfway through the journey.
 */
function assertCandidateSurface() {
  const abiOf = (rel) => candidateArtifact(rel).abi;
  const requireFn = (rel, signature, { outputs = null } = {}) => {
    const fn = abiFunctionOf(abiOf(rel), signature);
    assert.ok(
      fn,
      `${rel} does not expose ${signature} — the compiled candidate is stale or off-surface; rebuild it ` +
        `(\`forge build\` in contracts/, or point FINALIZER_CANDIDATE_OUT at a fresh FOUNDRY_OUT)`,
    );
    if (outputs != null) {
      assert.deepEqual(
        (fn.outputs ?? []).map(canonicalAbiType),
        outputs,
        `${rel} ${signature} return shape drifted from the worker's adapter`,
      );
    }
    return fn;
  };

  const MANDATE = "TreasuryMandate.sol/TreasuryMandate.json";
  requireFn(MANDATE, "AGREEMENTS_VERSION()", { outputs: ["uint16"] });
  requireFn(MANDATE, "agreements(bytes32)", { outputs: lib.ABI.AGREEMENTS.types });
  requireFn(MANDATE, "proposeAgreement(bytes32,address,uint128,uint64,bytes32,bytes32,bytes32)");
  requireFn(MANDATE, "acceptAgreement(bytes32,address[],uint16[])");
  requireFn(MANDATE, "bindSubmission(bytes32,bytes32)");
  requireFn(MANDATE, "releaseAgreement(bytes32)");
  requireFn(MANDATE, "approveProject(bytes32,address,uint128,uint128,uint64,bytes32)");
  // The mandate's terms-bound settlement: the DAO calls it and mints its answer.
  requireFn(MANDATE, "splits(bytes32)", { outputs: ["uint8"] });
  requireFn(MANDATE, "settleAgreement(bytes32)", { outputs: ["address[]", "uint256[]"] });
  requireFn(MANDATE, "sharesReserved(bytes32)", { outputs: ["uint128"] });
  requireFn(MANDATE, "agreementOfClaim(bytes32)", { outputs: ["bytes32"] });
  requireFn(MANDATE, "contributionAwarded(bytes32)", { outputs: ["bool"] });
  requireFn(MANDATE, "mandateSharesAwarded()", { outputs: ["uint128"] });
  requireFn(MANDATE, "dao()", { outputs: ["address"] });
  requireFn(MANDATE, "claims()", { outputs: ["address"] });
  requireFn(MANDATE, "verifiers()", { outputs: ["address"] });
  requireFn(MANDATE, "currency()", { outputs: ["address"] });
  requireFn(MANDATE, "closed()", { outputs: ["bool"] });

  const FACTORY = "TreasuryMandate.sol/TreasuryMandateFactory.json";
  requireFn(FACTORY, "create(address,uint128,uint128,uint128,uint128,uint64,address[],uint256,uint128,address)");
  requireFn(FACTORY, "daos(address)", { outputs: ["address"] });

  const CLAIMS = "ClaimStake.sol/ClaimStake.json";
  requireFn(CLAIMS, "settle(bytes32)");
  requireFn(CLAIMS, "claims(bytes32)", { outputs: lib.ABI.CLAIMS.types });
  requireFn(CLAIMS, "claimTerms(bytes32)", { outputs: lib.ABI.CLAIM_TERMS.types });
  requireFn(CLAIMS, "approvalsAtSubmit(bytes32)", { outputs: ["uint256"] });
  requireFn(CLAIMS, "objectionsAtSubmit(bytes32)", { outputs: ["uint256"] });
  requireFn(CLAIMS, "challengeWindow()", { outputs: ["uint64"] });

  const VERIFIERS = "VerifierSet.sol/VerifierSet.json";
  requireFn(VERIFIERS, "attest(bytes32,bool)");
  requireFn(VERIFIERS, "approvalCount(bytes32)", { outputs: ["uint256"] });
  requireFn(VERIFIERS, "objectionCount(bytes32)", { outputs: ["uint256"] });
  requireFn(VERIFIERS, "quorum()", { outputs: ["uint256"] });

  const DAO = "MolochPatched.sol/Moloch.json";
  // The worker never trusts a return value here: settleAgreement returns nothing.
  requireFn(DAO, "settleAgreement(address,bytes32)", { outputs: [] });
  requireFn(DAO, "shares()", { outputs: ["address"] });
  requireFn(DAO, "votingWeight()", { outputs: ["address"] });

  const SHARES = "MolochPatched.sol/Shares.json";
  requireFn(SHARES, "mintFromMoloch(address,uint256)");
  requireFn(SHARES, "balanceOf(address)", { outputs: ["uint256"] });
  requireFn(SHARES, "totalSupply()", { outputs: ["uint256"] });

  const POLICY = "AllocationVoting.sol/AllocationVoting.json";
  requireFn(POLICY, "earliestApproval(uint256)", { outputs: ["uint64"] });
  requireFn(POLICY, "executionDelay(uint256)", { outputs: ["uint64"] });
  requireFn(POLICY, "mandateFactory()", { outputs: ["address"] });

  requireFn(
    "MolochPatched.sol/Summoner.json",
    "summon(string,string,string,uint16,bool,address,bytes32,address[],uint256[],(address,uint256,bytes)[])",
  );

  // The events the confirmation reads must be the shapes the reader parses.
  const mandateEvents = abiOf(MANDATE).filter((entry) => entry.type === "event");
  const settled = mandateEvents.find((entry) => entry.name === "AgreementSettled");
  assert.ok(settled, "TreasuryMandate.AgreementSettled is missing");
  assert.deepEqual(
    settled.inputs.map(canonicalAbiType),
    ["bytes32", "bytes32", "address", "uint128"],
    "AgreementSettled argument shape drifted from the reader",
  );
  assert.equal(settled.inputs.filter((input) => input.indexed).length, 3, "AgreementSettled must index agreementId/claimId");
  const created = abiOf(FACTORY).find((entry) => entry.type === "event" && entry.name === "MandateCreated");
  assert.ok(created, "TreasuryMandateFactory.MandateCreated is missing");
  assert.equal(
    created.inputs.filter((input) => input.indexed).length,
    2,
    "MandateCreated must index dao and mandate (the journey reads topics[2])",
  );
  const claimReleased = abiOf(CLAIMS).find((entry) => entry.type === "event" && entry.name === "ClaimReleased");
  assert.ok(claimReleased, "ClaimStake.ClaimReleased is missing");
  assert.deepEqual(
    claimReleased.inputs.map(canonicalAbiType),
    ["bytes32", "address", "uint256"],
    "ClaimReleased argument shape drifted from the reader",
  );
}

/** Reserve a free loopback port (bind :0, read it, release it). */
async function freeLoopbackPort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitRealRpc(url, { attempts = 200 } = {}) {
  let last = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "web3_clientVersion", params: [] }),
        signal: AbortSignal.timeout(500),
      });
      if (res.ok) return;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`anvil never answered at ${url} (${last?.message ?? "no response"})`);
}

/**
 * Boot a scratch anvil on a free loopback port. Cleanup is registered for
 * exactly THIS child's pid (`t.after`) — never a pkill and never a port sweep,
 * so a second test's node or the developer's own anvil is never touched.
 */
async function bootRealAnvil(t) {
  const port = await freeLoopbackPort();
  const child = spawn("anvil", ["--host", "127.0.0.1", "--port", String(port), "--chain-id", "31337"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let boot = "";
  child.stdout.on("data", (c) => (boot += c));
  child.stderr.on("data", (c) => (boot += c));
  const url = `http://127.0.0.1:${port}`;
  t.after(() => {
    try {
      if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL");
    } catch {}
  });
  await waitRealRpc(url);
  // disambiguate an orphan anvil from a previous run: ours must be alive AND
  // must say it is listening on exactly our port.
  assert.ok(
    child.exitCode == null,
    `anvil died at boot (exit ${child.exitCode}); its log: ${boot.split("\n").slice(0, 12).join(" | ")}`,
  );
  assert.ok(
    boot.includes(`127.0.0.1:${port}`) || boot.includes(`:${port}`),
    `the anvil boot log does not name our port ${port}: ${boot.split("\n").slice(0, 8).join(" | ")}`,
  );
  const listed = new Set((boot.match(/0x[0-9a-f]{40}/gi) ?? []).map((a) => a.toLowerCase()));
  for (const known of lib.WELLKNOWN_ANVIL_ADDRESSES.slice(0, 4)) {
    if (!listed.has(known)) {
      throw new Error(
        `anvil's boot log did not list the well-known fixture address ${known} — the worker's dev-key list must ` +
          `track this anvil build (found: ${boot.split("\n").filter((l) => /Private key|Account/.test(l)).length} lines)`,
      );
    }
  }
  return { child, url };
}

/** Direct JSON-RPC — the setup leg only (the worker itself always goes through lib). */
async function realRpc(url, method, params = []) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Math.floor(Math.random() * 1e9), method, params }),
  });
  const body = await res.json();
  if (body.error != null) throw new Error(`rpc ${method}: ${body.error.message}`);
  return body.result;
}

/** Offline sign via `cast mktx` (the flags first verified in this file) and
 * broadcast through JSON-RPC; bounded receipt wait. */
async function signSendReal(url, { to, data = "0x", value = 0n, key, nonce, gasLimit = 1_500_000n }) {
  const args = ["mktx", to, data,
    "--private-key", key,
    "--nonce", String(nonce),
    "--gas-price", "1000000000",
    "--gas-limit", String(gasLimit),
    "--value", value.toString(),
    "--chain", "31337",
    "--legacy"];
  const signed = spawnSync("cast", args, { encoding: "utf8" });
  if (signed.status !== 0 || signed.error) {
    throw new Error(`cast mktx failed: ${signed.stderr?.trim() || signed.error?.message}`);
  }
  const raw = signed.stdout.trim();
  const hash = lib.keccakRaw(raw);
  const accepted = await realRpc(url, "eth_sendRawTransaction", [raw]);
  if ((accepted ?? "").toLowerCase() !== hash.toLowerCase()) {
    throw new Error(`eth_sendRawTransaction returned ${accepted}; expected ${hash}`);
  }
  let receipt = null;
  for (let i = 0; i < 300 && !receipt; i++) {
    receipt = await realRpc(url, "eth_getTransactionReceipt", [hash]);
    if (!receipt) await new Promise((r) => setTimeout(r, 100));
  }
  if (!receipt || receipt.status !== "0x1") {
    const tracePath = path.join(tmpRoot, `finalizer-fail-${hash.slice(2, 10)}.json`);
    try {
      const trace = await realRpc(url, "debug_traceTransaction", [hash, { tracer: "callTracer" }]);
      fs.writeFileSync(tracePath, JSON.stringify(trace, null, 2));
    } catch {}
    throw new Error(
      `tx ${hash} has no successful receipt (${receipt?.status ?? "none"}) — full callTracer written to ${tracePath}`,
    );
  }
  return { hash, receipt };
}

function topicBytes32ToAddress(topic) {
  const hex = (topic ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(hex)) throw new Error(`not a 32-byte topic: ${topic}`);
  return "0x" + hex.slice(26);
}

/** keccak256 of a hex blob (the repo's noble keccak, no new dep). */
function keccakHex(hex) {
  return lib.keccakRaw(hex);
}

test("REAL-CHAIN: an agreed contribution settles end to end on the production candidate", async (t) => {
  const ready = await candidateReady();
  if (!ready.ok) {
    t.skip(`the compiled candidate is not usable — ${ready.reason} — the real-chain journey stays PENDING`);
    return;
  }
  // The read adapter is aligned with the freshly compiled candidate BEFORE
  // anything trusts it: a stale or off-surface build fails here, loudly.
  assertCandidateSurface();

  const { child: anvilChild, url } = await bootRealAnvil(t);

  // Well-known anvil dev fixtures only: the worker's signer is one of these.
  const K = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // holder0 / reviewer (worker)
  const K1 = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // holder1 / reviewer
  const K2 = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"; // project manager
  const K3 = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6"; // beneficiary
  const K4 = "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a"; // coauthor
  const addrOf = {
    [K]: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
    [K1]: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
    [K2]: "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc",
    [K3]: "0x90f79bf6eb2c4f870365e785982e1f101e93b906",
    [K4]: "0x15d34aaf54267db7d7c367839aaf71a00a2c6a65",
  };
  for (const address of Object.values(addrOf)) {
    assert.ok(lib.WELLKNOWN_ANVIL_ADDRESSES.includes(address), `fixture account ${address} is in the well-known anvil set`);
  }
  const holder0 = addrOf[K];
  const holder1 = addrOf[K1];
  const manager = addrOf[K2];
  const beneficiary = addrOf[K3];
  const coauthor = addrOf[K4];

  const rpc = (method, params = []) => realRpc(url, method, params);
  const nextNonce = async (who) => BigInt(await rpc("eth_getTransactionCount", [who, "pending"]));
  const codeAt = async (who) => await rpc("eth_getCode", [who, "latest"]);
  const blockNow = async () => BigInt((await rpc("eth_getBlockByNumber", ["latest", false])).timestamp);
  const advanceTo = async (timestamp) => {
    const now = await blockNow();
    if (timestamp <= now) throw new Error(`advanceTo(${timestamp}) is not in the future (chain time ${now})`);
    await rpc("evm_setNextBlockTimestamp", ["0x" + timestamp.toString(16)]);
    await rpc("evm_mine", []);
  };
  const call = async (to, data) => await rpc("eth_call", [{ to, data }, "latest"]);
  const callUint = async (to, sig, types = [], args = []) =>
    BigInt(await call(to, lib.encodeFunctionData(sig, types, args)));
  const callAddr = async (to, sig, types = [], args = []) =>
    topicBytes32ToAddress(await call(to, lib.encodeFunctionData(sig, types, args)));
  const callBytes32 = async (to, sig, types = [], args = []) => {
    const word = (await call(to, lib.encodeFunctionData(sig, types, args))).toLowerCase().slice(2);
    assert.equal(word.length, 64, `${sig} did not return one 32-byte word`);
    return "0x" + word;
  };
  const send = async (key, to, data, { value = 0n, gasLimit = 1_500_000n } = {}) =>
    await signSendReal(url, { to, data, value, key, nonce: await nextNonce(addrOf[key]), gasLimit });

  const bytecodeOf = (rel) => "0x" + candidateArtifact(rel).bytecode.object.replace(/^0x/, "");

  async function deployCreate(bytecode, sig, args, key, label) {
    const mkargs = ["mktx",
      "--private-key", key,
      "--nonce", String(await nextNonce(addrOf[key])),
      "--gas-price", "1000000000",
      "--gas-limit", "24000000",
      "--value", "0",
      "--chain", "31337",
      "--legacy",
      "--create", bytecode, ...(sig ? [sig, ...args] : [])];
    const signed = spawnSync("cast", mkargs, { encoding: "utf8" });
    if (signed.status !== 0 || signed.error) {
      throw new Error(`cast mktx --create (${label}) failed: ${signed.stderr?.trim() || signed.error?.message}`);
    }
    const raw = signed.stdout.trim();
    const hash = lib.keccakRaw(raw);
    const accepted = await realRpc(url, "eth_sendRawTransaction", [raw]);
    if ((accepted ?? "").toLowerCase() !== hash.toLowerCase()) {
      throw new Error(`${label}: eth_sendRawTransaction gave ${accepted}, expected ${hash}`);
    }
    let receipt = null;
    for (let i = 0; i < 600 && !receipt; i++) {
      receipt = await realRpc(url, "eth_getTransactionReceipt", [hash]);
      if (!receipt) await new Promise((r) => setTimeout(r, 100));
    }
    if (!receipt || receipt.status !== "0x1") {
      throw new Error(`${label}: no successful receipt for ${hash} (status ${receipt?.status ?? "absent after the wait"})`);
    }
    const address = receipt.contractAddress;
    assert.ok(/^0x[0-9a-f]{40}$/.test(address), `${label}: receipt's contractAddress unusable (${address})`);
    return address;
  }

  // ── the stack: factory → policy → summoner → currency → DAO summon ──
  const factory = await deployCreate(bytecodeOf("TreasuryMandate.sol/TreasuryMandateFactory.json"), null, null, K, "TreasuryMandateFactory");
  const policy = await deployCreate(bytecodeOf("AllocationVoting.sol/AllocationVoting.json"), "constructor(address)", [factory], K, "AllocationVoting");
  const summoner = await deployCreate(bytecodeOf("MolochPatched.sol/Summoner.json"), "constructor(address)", [policy], K, "Summoner");
  const currency = await deployCreate(bytecodeOf("TreasuryMandate.t.sol/MandateCurrency.json"), null, null, K, "MandateCurrency");

  const summonCall = lib.encodeFunctionData(
    "summon(string,string,string,uint16,bool,address,bytes32,address[],uint256[],(address,uint256,bytes)[])",
    [
      "string", "string", "string", "uint16", "bool", "address", "bytes32",
      { array: "address" }, { array: "uint256" },
      { array: { tuple: ["address", "uint256", "bytes"] } },
    ],
    [
      "Finalizer Test DAO", "FTZ", "", 500n, false, lib.ZERO_ADDRESS, bytes32No(0x1),
      [holder0, holder1],
      [1_000_000_000_000_000_000n, 1_000_000_000_000_000_000n],
      [],
    ],
  );
  const summonReceipt = (await send(K, summoner, summonCall, { gasLimit: 6_000_000n })).receipt;
  // Moloch.Summoner emits NewDAO(address indexed summoner, Moloch indexed dao);
  const newDaoTopics = (summonReceipt?.logs ?? [])
    .filter((l) => l.address?.toLowerCase() === summoner.toLowerCase() && (l.topics?.length ?? 0) === 3)
    .map((l) => l.topics[2]);
  assert.ok(newDaoTopics.length >= 1, `no NewDAO log on the summon's receipt (${JSON.stringify(summonReceipt?.logs ?? []).slice(0, 400)})`);
  const daoAddress = topicBytes32ToAddress(newDaoTopics[0]);
  assert.ok((await codeAt(daoAddress)).length > 2, "the summoned Moloch has code");

  const sharesToken = await callAddr(daoAddress, "shares()");
  assert.ok((await codeAt(sharesToken)).length > 2, `dao.shares() = ${sharesToken} has no code`);

  // ── governance: open → vote → wait out review+hold → queue → wait delay → execute ──
  const ACTION_TYPES = ["uint8", "address", "uint256", "bytes", "bytes32"];
  const openData = (target, payload, salt) =>
    lib.encodeFunctionData("openProposalWithAction(uint8,address,uint256,bytes,bytes32)", ACTION_TYPES, [0n, target, 0n, payload, salt]);
  const execData = (target, payload, salt) =>
    lib.encodeFunctionData("executeByVotes(uint8,address,uint256,bytes,bytes32)", ACTION_TYPES, [0n, target, 0n, payload, salt]);
  const pidData = (target, payload, salt) =>
    lib.encodeFunctionData("proposalId(uint8,address,uint256,bytes,bytes32)", ACTION_TYPES, [0n, target, 0n, payload, salt]);

  async function sessionProposal({ target, payload, salt }) {
    await send(K, daoAddress, openData(target, payload, salt), { gasLimit: 20_000_000n });
    const id = BigInt(await call(daoAddress, pidData(target, payload, salt)));
    for (const voterKey of [K, K1]) {
      await send(voterKey, daoAddress, lib.encodeFunctionData(
        "castVote(uint256,uint8,uint256)",
        ["uint256", "uint8", "uint256"],
        [id, 1n, 1_000_000_000_000_000_000n],
      ));
    }
    const policyAddr = await callAddr(daoAddress, "votingWeight()");
    const earliest = BigInt(await call(policyAddr, lib.encodeFunctionData("earliestApproval(uint256)", ["uint256"], [id])));
    assert.ok(earliest > 0n, `proposal ${id} never qualified (quorum/approval not met at the current support)`);
    await advanceTo(earliest + 1n); // the review + hold window elapses
    await send(K, daoAddress, execData(target, payload, salt), { gasLimit: 20_000_000n }); // queue
    const delay = BigInt(await call(policyAddr, lib.encodeFunctionData("executionDelay(uint256)", ["uint256"], [id])));
    await advanceTo((await blockNow()) + delay + 1n); // the timelock elapses
    const exec = await send(K, daoAddress, execData(target, payload, salt), { gasLimit: 26_000_000n });
    return exec.receipt;
  }

  // governance leg 1: the mandate create (unrestricted lane), executed by the DAO
  const shareBudget = 1_000n * 10n ** 18n;
  const createPayload = lib.encodeFunctionData(
    "create(address,uint128,uint128,uint128,uint128,uint64,address[],uint256,uint128,address)",
    ["address", "uint128", "uint128", "uint128", "uint128", "uint64", { array: "address" }, "uint256", "uint128", "address"],
    [currency, 0n, 0n, shareBudget, shareBudget, (await blockNow()) + 86_400n * 90n, [holder0, holder1], 1n, 0n, lib.ZERO_ADDRESS],
  );
  const createReceipt = await sessionProposal({ target: factory, payload: createPayload, salt: bytes32No(0x21) });
  // MandateCreated(address indexed dao, address indexed mandate, ...) → topics[2] is the mandate.
  const mandateTopic = (createReceipt?.logs ?? [])
    .filter((l) => l.address?.toLowerCase() === factory.toLowerCase() && (l.topics?.length ?? 0) === 3)
    .map((l) => l.topics[2])
    .find(Boolean);
  assert.ok(mandateTopic, `MandateCreated log missing on the create's receipt (${JSON.stringify(createReceipt?.logs ?? []).slice(0, 300)})`);
  const mandate = topicBytes32ToAddress(mandateTopic);
  assert.ok((await codeAt(mandate)).length > 2, `the created mandate ${mandate} has no code`);
  assert.equal(await callAddr(mandate, "dao()"), daoAddress, "the mandate names the summoning DAO");
  assert.equal(await callUint(mandate, "AGREEMENTS_VERSION()"), 1n, "the candidate speaks agreements v1");

  // governance leg 2: approveProject (bounded lane: review 24h + hold 6h)
  const PROJECT = bytes32No(0x1);
  const PROJECT_CHECK = bytes32No(0x7ea1);
  const projectExpires = (await blockNow()) + 86_400n * 60n;
  const approvePayload = lib.encodeFunctionData(
    "approveProject(bytes32,address,uint128,uint128,uint64,bytes32)",
    ["bytes32", "address", "uint128", "uint128", "uint64", "bytes32"],
    [PROJECT, manager, 0n, shareBudget, projectExpires, PROJECT_CHECK],
  );
  await sessionProposal({ target: mandate, payload: approvePayload, salt: bytes32No(0x22) });

  const claimsAddr = await callAddr(mandate, "claims()");
  const verifiersAddr = await callAddr(mandate, "verifiers()");
  assert.ok((await codeAt(claimsAddr)).length > 2, `mandate.claims() = ${claimsAddr} has no code`);
  assert.ok((await codeAt(verifiersAddr)).length > 2, `mandate.verifiers() = ${verifiersAddr} has no code`);
  assert.equal(await callUint(verifiersAddr, "quorum()"), 1n, "the panel quorum is 1");

  // ── the agreed contribution, direct on the mandate ──
  const AGREED_SHARES = 5_000_000_000_000_000_000n;
  const splitCommitment = lib.encodeParameters(
    [{ array: "address" }, { array: "uint16" }],
    [[beneficiary, coauthor], [8000n, 2000n]],
  );
  const splitHash = keccakHex(splitCommitment);

  async function bindAgreement({ slot, claimId }) {
    const agreementId = keccakHex("0x" + PROJECT.slice(2) + slot.slice(2)); // keccak256(abi.encode(projectId, slot))
    const workDeadline = (await blockNow()) + 86_400n * 20n;
    await send(K2, mandate, lib.encodeFunctionData(
      "proposeAgreement(bytes32,address,uint128,uint64,bytes32,bytes32,bytes32)",
      ["bytes32", "address", "uint128", "uint64", "bytes32", "bytes32", "bytes32"],
      [PROJECT, beneficiary, AGREED_SHARES, workDeadline, slot, lib.ZERO_BYTES32, splitHash],
    ));
    await send(K3, claimsAddr, lib.encodeFunctionData(
      "submitClaim(bytes32,uint256,uint256,bytes32)",
      ["bytes32", "uint256", "uint256", "bytes32"],
      [claimId, 0n, 0n, keccakHex(slot)], // zero currency ask, no stake: the agreed terms
    ));
    await send(K3, claimsAddr, lib.encodeFunctionData(
      "setCheck(bytes32,bytes32)",
      ["bytes32", "bytes32"],
      [claimId, PROJECT_CHECK],
    ));
    await send(K3, mandate, lib.encodeFunctionData(
      "acceptAgreement(bytes32,address[],uint16[])",
      ["bytes32", { array: "address" }, { array: "uint16" }],
      [agreementId, [beneficiary, coauthor], [8000n, 2000n]],
    ));
    await send(K2, mandate, lib.encodeFunctionData(
      "bindSubmission(bytes32,bytes32)",
      ["bytes32", "bytes32"],
      [agreementId, claimId],
    ));
    return { agreementId, claimId };
  }

  const runWorker = (journalDir, jobSpec, rpcUrl = url) =>
    spawnSync(process.execPath, [CLI, "run",
      "--journal", journalDir,
      "--rpc", rpcUrl,
      "--opt-in-fixture-writes",
      "--fixture-key", K,
      "--job", jobSpec], { encoding: "utf8", timeout: 120_000 });

  const claimTermsOf = async (claimId) =>
    lib.decodeParameters(lib.ABI.CLAIM_TERMS.types, await call(claimsAddr, lib.encodeFunctionData("claimTerms(bytes32)", ["bytes32"], [claimId])));

  const journalDir = tempJournal("real-chain");

  // ── REAL REFUSAL 1: an objection quorum stands — settle would slash ──
  const objected = await bindAgreement({ slot: bytes32No(0x5aa), claimId: bytes32No(0x5aa1) });
  await send(K1, verifiersAddr, lib.encodeFunctionData("attest(bytes32,bool)", ["bytes32", "bool"], [objected.claimId, false]));
  assert.equal(await callUint(verifiersAddr, "objectionCount(bytes32)", ["bytes32"], [objected.claimId]), 1n, "the objection is real onchain");
  const objectionSpec = `chain=31337,dao=${daoAddress},mandate=${mandate},agreement=${objected.agreementId},action=start-window`;
  const objectionRun = runWorker(journalDir, objectionSpec);
  assert.equal(objectionRun.status, 7, `an objection quorum must block, never sign: ${objectionRun.stdout}${objectionRun.stderr}`);
  const objectionRec = jobRecord(journalDir, lib.parseJobSpec(objectionSpec));
  assert.equal(objectionRec.state, "blocked");
  assert.equal(objectionRec.blocked.reason, "objection-quorum-reached");
  assert.equal(objectionRec.prepared, null, "nothing was signed on the contract's slash branch");
  assert.equal(Number((await claimTermsOf(objected.claimId))[3]), 0, "the objected claim is still Open — no reject, no slash");
  console.log(`[real-chain] objection refusal: ${objectionRec.blocked.reason}; prepared=${objectionRec.prepared}; claim Open`);

  // ── REAL REFUSAL 2: the approval quorum is not met yet ──
  const happy = await bindAgreement({ slot: bytes32No(0x5ab), claimId: bytes32No(0x5ab1) });
  const startSpec = `chain=31337,dao=${daoAddress},mandate=${mandate},agreement=${happy.agreementId},action=start-window`;
  const earlyRun = runWorker(journalDir, startSpec);
  assert.equal(earlyRun.status, 7, `an unmet approval quorum must block: ${earlyRun.stdout}${earlyRun.stderr}`);
  const earlyRec = jobRecord(journalDir, lib.parseJobSpec(startSpec));
  assert.equal(earlyRec.state, "blocked");
  assert.equal(earlyRec.blocked.reason, "approval-quorum-not-reached");
  assert.equal(earlyRec.prepared, null, "nothing was signed before the quorum stood");

  // the panel approves (quorum 1) → the worker starts the verified window
  await send(K, verifiersAddr, lib.encodeFunctionData("attest(bytes32,bool)", ["bytes32", "bool"], [happy.claimId, true]));
  const startRun = runWorker(journalDir, startSpec);
  assert.equal(startRun.status, 0, `start-window run failed: ${startRun.stdout} ${startRun.stderr}`);
  const startRec = jobRecord(journalDir, lib.parseJobSpec(startSpec));
  // the earlier blocked attempt is kept (never deleted); the recovery path then
  // walks prepared → submitted → confirmed on the SAME job.
  assert.deepEqual(startRec.history.map((h) => h.to).slice(-4), ["blocked", "prepared", "submitted", "confirmed"]);
  assert.equal(startRec.state, "confirmed");
  // the SIGNED bytes are exactly ClaimStake.settle(claimId), value 0 — nothing else.
  const startTx = decodeLegacyTx(startRec.prepared.signedRaw);
  assert.equal(startTx.to.toLowerCase(), claimsAddr.toLowerCase(), "the start-window tx targets the claims escrow");
  assert.equal(startTx.data, lib.encodeFunctionData("settle(bytes32)", ["bytes32"], [happy.claimId]));
  assert.equal(startTx.value, "0x0");
  assert.equal(startRec.prepared.from, holder0, "the well-known fixture signer is the only signer");
  assert.equal(startRec.prepared.signedHash, startRec.signedHash, "the journal's hash is the signed bytes' hash");
  const startReceipt = await rpc("eth_getTransactionReceipt", [startRec.signedHash]);
  assert.equal(startReceipt.status, "0x1");
  // the REAL chain state: the claim is Approved, the window started
  const approvedTerms = await claimTermsOf(happy.claimId);
  assert.equal(Number(approvedTerms[3]), 1, `claim status must be Approved after the worker's settle (got ${approvedTerms[3]})`);
  const claimStruct = lib.decodeParameters(lib.ABI.CLAIMS.types, await call(claimsAddr, lib.encodeFunctionData("claims(bytes32)", ["bytes32"], [happy.claimId])));
  const releasedAt = claimStruct[7];
  assert.ok(releasedAt > 0n, "releasedAt is the window's start");
  console.log(`[real-chain] start-window confirmed: claim Approved at releasedAt=${releasedAt}, tx ${startRec.signedHash}`);

  // ── run the challenge window out, then THE WORKER (settle-agreement) ──
  const challengeWindow = await callUint(claimsAddr, "challengeWindow()");
  const windowOpensAt = releasedAt + challengeWindow;
  const nowAtWindow = await blockNow();
  await advanceTo(windowOpensAt + 120n > nowAtWindow ? windowOpensAt + 120n : nowAtWindow + 1n);
  const supplyBefore = await callUint(sharesToken, "totalSupply()");
  const settleSpec = `chain=31337,dao=${daoAddress},mandate=${mandate},agreement=${happy.agreementId},action=settle-agreement`;
  const settleRun = runWorker(journalDir, settleSpec);
  assert.equal(settleRun.status, 0, `settle-agreement run failed: ${settleRun.stdout} ${settleRun.stderr}`);
  const settleRec = jobRecord(journalDir, lib.parseJobSpec(settleSpec));
  assert.deepEqual(settleRec.history.map((h) => h.to), ["queued", "prepared", "submitted", "confirmed"]);
  assert.equal(settleRec.state, "confirmed");

  // the journal recorded the EXACT expected effects (derived from the record)
  assert.equal(settleRec.expected.awardTotal, "5000000000000000000");
  assert.deepEqual(
    settleRec.expected.recipients.map((r) => [r.address.toLowerCase(), r.portion]),
    [[beneficiary, "4000000000000000000"], [coauthor, "1000000000000000000"]],
  );
  // the SIGNED bytes are exactly Moloch.settleAgreement(mandate, agreementId), value 0.
  const settleTx = decodeLegacyTx(settleRec.prepared.signedRaw);
  assert.equal(settleTx.to.toLowerCase(), daoAddress.toLowerCase(), "the settle tx targets the DAO");
  assert.equal(
    settleTx.data,
    lib.encodeFunctionData("settleAgreement(address,bytes32)", ["address", "bytes32"], [mandate, happy.agreementId]),
  );
  assert.equal(settleTx.value, "0x0");

  // the REAL chain: the exact mint, in the settle tx's own receipt
  const settleReceipt = await rpc("eth_getTransactionReceipt", [settleRec.signedHash]);
  assert.equal(settleReceipt.status, "0x1");
  const mints = (settleReceipt.logs ?? [])
    .filter((l) => l.address?.toLowerCase() === sharesToken.toLowerCase()
      && l.topics?.[0] === lib.TRANSFER_TOPIC && l.topics?.[1] === lib.ZERO_BYTES32)
    .map((l) => [topicBytes32ToAddress(l.topics[2]), BigInt(l.data)]);
  assert.equal(
    mints.length,
    2,
    `exactly two mint logs: ${JSON.stringify(mints.map(([address, amount]) => [address, amount.toString()]))}`,
  );
  const minted = new Map(mints);
  assert.equal(minted.get(beneficiary), 4_000_000_000_000_000_000n, "the 80% leg minted exactly 4e18");
  assert.equal(minted.get(coauthor), 1_000_000_000_000_000_000n, "the 20% leg minted exactly 1e18");

  const balanceOf = async (who) => await callUint(sharesToken, "balanceOf(address)", ["address"], [who]);
  assert.equal(await balanceOf(beneficiary), 4_000_000_000_000_000_000n, "beneficiary balance is exactly the minted 4e18");
  assert.equal(await balanceOf(coauthor), 1_000_000_000_000_000_000n, "coauthor balance is exactly the minted 1e18");
  assert.equal(await callUint(sharesToken, "totalSupply()"), supplyBefore + 5_000_000_000_000_000_000n, "supply moved exactly +5e18");

  // the agreement's own durable record: settled once, claim Paid, one delivery bound
  const settledRecord = lib.decodeParameters(lib.ABI.AGREEMENTS.types, await call(mandate, lib.encodeFunctionData("agreements(bytes32)", ["bytes32"], [happy.agreementId])));
  assert.equal(Number(settledRecord[10]), lib.TERMINAL_KIND.SETTLED, "agreement terminalKind is SETTLED");
  assert.equal(Number((await claimTermsOf(happy.claimId))[3]), lib.CLAIM_STATUS.Paid, "the claim finished Paid");
  assert.equal(
    await callBytes32(mandate, "agreementOfClaim(bytes32)", ["bytes32"], [happy.claimId]),
    happy.agreementId,
    "the claim's one delivery stays bound to this agreement (the discretionary path can never eat it)",
  );
  assert.equal(await callUint(mandate, "sharesReserved(bytes32)", ["bytes32"], [PROJECT]), 5_000_000_000_000_000_000n, "the objected agreement's reservation is the only one left");
  console.log(
    `[real-chain] settle confirmed: tx ${settleRec.signedHash}; minted beneficiary=${minted.get(beneficiary)} ` +
      `coauthor=${minted.get(coauthor)}; terminalKind=SETTLED; claim Paid`,
  );

  // a re-run of the confirmed job is a no-op: same state, no new transaction.
  const nonceBefore = await nextNonce(holder0);
  const rerun = runWorker(journalDir, settleSpec);
  assert.equal(rerun.status, 0, `a confirmed job re-run must stay a success: ${rerun.stdout}${rerun.stderr}`);
  assert.equal(await nextNonce(holder0), nonceBefore, "no extra transaction was signed or broadcast");
  assert.equal(jobRecord(journalDir, lib.parseJobSpec(settleSpec)).state, "confirmed");

  // ── the chain reset defense: kill THIS anvil, boot a NEW instance, rerun the
  //    SAME journal — the environment gate must refuse and fence the nonterminal
  //    job, and the confirmed record must never be rewritten ──
  const pendingSpec = `chain=31337,dao=${daoAddress},mandate=${mandate},agreement=${bytes32No(0xdead)},action=settle-agreement`;
  const pendingRun = runWorker(journalDir, pendingSpec);
  assert.equal(pendingRun.status, 7, "an unknown agreement blocks on this chain");
  assert.equal(jobRecord(journalDir, lib.parseJobSpec(pendingSpec)).state, "blocked");

  anvilChild.kill("SIGKILL");
  const { url: freshUrl } = await bootRealAnvil(t); // a NEW instance (new instanceId)
  const fresh = runWorker(journalDir, pendingSpec, freshUrl);
  assert.equal(fresh.status, 4, `a fresh anvil instance against the bound journal must exit 4; got ${fresh.stderr.slice(0, 300)}`);
  assert.equal(
    jobRecord(journalDir, lib.parseJobSpec(pendingSpec)).state,
    "environment-changed",
    "the nonterminal job records the environment change",
  );
  assert.equal(
    jobRecord(journalDir, lib.parseJobSpec(settleSpec)).state,
    "confirmed",
    "the confirmed record is never rewritten by a chain reset",
  );
  console.log("[real-chain] environment gate: fresh instance → exit 4; nonterminal job fenced, confirmed record kept");
});

// ---------------------------------------------------------------------------
// EXIT CODES: each documented code, and every unclassified failure, is mapped
// by the production CLI (spawned for real, no RPC needed). Classification is by
// an explicit `exitCode` carried on the thrown error, never by class name.
// ---------------------------------------------------------------------------

function runExitCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
}

function seedJob(journalDir, state) {
  const identity = lib.parseJobSpec(JOB_START);
  const journal = lib.Journal.ensure(journalDir);
  journal.saveJob({ format: lib.JOURNAL_FORMAT, identity, state, history: [], updatedAt: "2026-01-01T00:00:00.000Z" });
  return identity;
}

test("exit codes: usage errors raised inside a command exit 1 (not 8)", () => {
  const noJournal = runExitCli(["run", "--rpc", "http://127.0.0.1:1", "--job", JOB_START]);
  assert.equal(noJournal.status, 1, `missing --journal: ${noJournal.stderr}`);
  const noRpc = runExitCli(["run", "--journal", tempJournal("exit-norpc"), "--job", JOB_START]);
  assert.equal(noRpc.status, 1, `missing --rpc: ${noRpc.stderr}`);
  const noJob = runExitCli(["run", "--journal", tempJournal("exit-nojob"), "--rpc", "http://127.0.0.1:1"]);
  assert.equal(noJob.status, 1, `missing --job: ${noJob.stderr}`);
  const unknownJob = runExitCli(["retry", "--journal", tempJournal("exit-unknownjob"), "--job", JOB_START]);
  assert.equal(unknownJob.status, 1, `retry of a job the journal never saw: ${unknownJob.stderr}`);
});

test("exit codes: retry re-queues and exits 2 (in flight), never 0", () => {
  const journalDir = tempJournal("exit-retry");
  const identity = seedJob(journalDir, "failed");
  const r = runExitCli(["retry", "--journal", journalDir, "--job", JOB_START]);
  assert.equal(r.status, 2, `retry leaves the job queued, which is not a success: ${r.stdout}${r.stderr}`);
  assert.equal(new lib.Journal(journalDir).loadJob(identity).state, "queued");
});

test("exit codes: retry of an already confirmed job stays 0", () => {
  const journalDir = tempJournal("exit-retry-confirmed");
  seedJob(journalDir, "confirmed");
  const r = runExitCli(["retry", "--journal", journalDir, "--job", JOB_START]);
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
});

test("exit codes: a live journal lock exits 3, a dead holder's lock exits 3", () => {
  const liveDir = tempJournal("exit-lock-live");
  seedJob(liveDir, "failed");
  fs.writeFileSync(path.join(liveDir, lib.JOURNAL_LOCK_NAME), JSON.stringify({ pid: process.pid, startedAt: "x" }));
  assert.equal(runExitCli(["retry", "--journal", liveDir, "--job", JOB_START]).status, 3);

  const dead = spawnSync(process.execPath, ["-e", "0"]);
  assert.equal(dead.status, 0);
  const staleDir = tempJournal("exit-lock-stale");
  seedJob(staleDir, "failed");
  // a pid that has exited: spawnSync reports it via dead.pid
  fs.writeFileSync(path.join(staleDir, lib.JOURNAL_LOCK_NAME), JSON.stringify({ pid: dead.pid, startedAt: "x" }));
  assert.equal(runExitCli(["retry", "--journal", staleDir, "--job", JOB_START]).status, 3);
});

test("exit codes: a malformed journal is an unclassified failure (9), not 'no job' (8)", () => {
  const brokenJson = tempJournal("exit-badjson");
  lib.Journal.ensure(brokenJson);
  fs.writeFileSync(path.join(brokenJson, "job-broken.json"), "{ not json");
  const r1 = runExitCli(["status", "--journal", brokenJson]);
  assert.equal(r1.status, 9, `${r1.stdout}${r1.stderr}`);

  const noIdentity = tempJournal("exit-noidentity");
  lib.Journal.ensure(noIdentity);
  fs.writeFileSync(path.join(noIdentity, "job-empty.json"), JSON.stringify({ format: lib.JOURNAL_FORMAT }));
  const r2 = runExitCli(["status", "--journal", noIdentity]);
  assert.equal(r2.status, 9, `${r2.stdout}${r2.stderr}`);
});

test("exit codes: classification uses the explicit exitCode field, not the class name", async () => {
  const { mapFailureToExcode } = await import(CLI_URL);
  assert.equal(mapFailureToExcode(new lib.UsageError("x")), 1);
  assert.equal(mapFailureToExcode(new lib.LockBusy({ pid: 1, startedAt: "x" })), 3);
  assert.equal(mapFailureToExcode(new lib.LockStale("x")), 3);
  assert.equal(mapFailureToExcode(new lib.EnvironmentChanged("x")), 4);
  assert.equal(mapFailureToExcode(new lib.BlockedJob("r", "d")), 7);
  assert.equal(mapFailureToExcode(new lib.JournalJournalDirErrors("x")), 9);
  assert.equal(mapFailureToExcode(new lib.TransientRpcError("x")), 9);
  assert.equal(mapFailureToExcode(new Error("cast mktx failed")), 9);
  assert.equal(mapFailureToExcode(undefined), 9);
  // a look-alike class name must not be promoted to a documented code
  class LockManagerBroke extends Error {}
  class MyUsageErrorHelper extends Error {}
  assert.equal(mapFailureToExcode(new LockManagerBroke("x")), 9);
  assert.equal(mapFailureToExcode(new MyUsageErrorHelper("x")), 9);
  // the exit code carried by the error wins, but only documented values count
  assert.equal(mapFailureToExcode(Object.assign(new Error("x"), { exitCode: 5 })), 5);
  assert.equal(mapFailureToExcode(Object.assign(new Error("x"), { exitCode: 0 })), 9);
  assert.equal(mapFailureToExcode(Object.assign(new Error("x"), { exitCode: 42 })), 9);
});
