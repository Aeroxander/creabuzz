/**
 * Verifiable community scores, consumed client-side.
 *
 * T1 of the next-gen plan (docs/next-gen-launchpad-plan.md §3.3): a trustgraph
 * score root is published as a Nostr record (kind 37006) alongside the chain
 * proof of that root; this module lets a client verify an individual score
 * claim *without running the prover*. The proof structure mirrors
 * `TrustGatedHook.sol` exactly — leaf keccak256(abi.encode(bidder, score)) and
 * a sorted-pair Merkle path — so a proof this module accepts is a proof the
 * bucket hook accepts. No dependency on a trustgraphs deployment beyond the
 * published root and its proof file.
 */

import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

export interface TrustScore {
  /** Hex pubkey/address of the scored entity. */
  member: string;
  /** Normalized score, 0-100 (the same scale NIP-85 30382 uses). */
  score: number;
}

export interface ScoreRootRecord {
  /** Keccak-256 of the canonical program id (e.g. "trustgraphs.output.nostr-member.v1"). */
  program: string;
  /** The Merkle root, 0x + 64 hex. */
  root: string;
  /** Epoch/checkpoint the root covers. */
  epoch: string;
  /** Where the full score file + proofs live (indexer). */
  indexerUrl: string | null;
  /** Block at which the root is anchored onchain, if known. */
  anchorBlock: number | null;
}

/**
 * Verify one member's score against a root, using the exact leaf/path layout
 * of `TrustGatedHook.validate`. Returns true when the path folds to the root.
 */
/**
 * The (bidder, score) leaf — `TrustGatedHook.validate` byte-for-byte:
 * `keccak256(abi.encode(address, uint256))` (address left-padded to 32 bytes,
 * score as 32 bytes, keccak of the 64-byte concatenation).
 */
export function scoreLeafBytes(member: string, score: number): Uint8Array {
  const memberHex = member.replace(/^0x/i, "").toLowerCase().padStart(64, "0");
  const scoreHex = BigInt(Math.floor(score)).toString(16).padStart(64, "0");
  return keccak_256(hexToBytes(memberHex + scoreHex));
}

/** The hook's sorted-pair fold step (`node <= sibling` first). */
export function combineNodeBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const [lo, hi] = compareBytes(a, b) <= 0 ? [a, b] : [b, a];
  return keccak_256(new Uint8Array([...lo, ...hi]));
}

export function verifyScoreProof(
  root: string,
  member: string,
  score: number,
  proof: readonly string[],
): boolean {
  const r = root.replace(/^0x/, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(r)) return false;
  let node: Uint8Array = scoreLeafBytes(member, score);
  for (const p of proof) {
    node = combineNodeBytes(
      node,
      hexToBytes(p.replace(/^0x/, "").toLowerCase()),
    );
  }
  return bytesToHex(node) === r;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

/** The score "proven" or "unverified", for rendering. */
export function scoreStatus(
  proof: readonly string[],
  root: string | null,
  member: string,
  score: number,
): { status: "unverified" | "proven"; source: string | null } {
  if (!root) return { status: "unverified", source: null };
  const ok = verifyScoreProof(root, member, score, proof);
  return ok
    ? { status: "proven", source: root }
    : { status: "unverified", source: null };
}

/**
 * Delivery signals that feed the trust score. The formula is pinned on both
 * the Rust (`buzz-cli/commands/trustgraph.rs::delivery_score`) and TypeScript
 * sides by `scripts/trust-score-corpus.json` — both suites read the same
 * fixture, so any drift reds one of them.
 */
export interface DeliverySignals {
  approvedMilestones?: number;
  contributionRecords?: number;
  /** Full tenure at 12; absent counts as 12. */
  monthsActive?: number;
  slashedClaims?: number;
  rejectedClaims?: number;
}

/**
 * `score = max(0, floor((approved + contributions) * months * 1000 / 12) -
 * floor((slashed + rejected) * months * 1000 / 12))` with
 * `months = min(monthsActive || 12, 12)`. Accepted milestones and
 * contributions raise the score scaled by tenure; slashed and rejected claims
 * subtract at the same scale.
 */
export function deliveryScore(s: DeliverySignals): number {
  const months = Math.min(s.monthsActive ?? 12, 12);
  const scale = (n: number) => Math.floor((n * months * 1000) / 12);
  const good = scale((s.approvedMilestones ?? 0) + (s.contributionRecords ?? 0));
  const bad = scale((s.slashedClaims ?? 0) + (s.rejectedClaims ?? 0));
  return Math.max(0, good - bad);
}
