/**
 * TrustGatedHook gate reads, rotation composer, and the Merkle tree rebuild
 * behind the TrustGraph view (NIP-LP `37006` score roots + the EVM bid gate).
 *
 * The EVM/Nostr split, audited 2026-09-28: the gate is EVM
 * (`TrustGatedHook.validate` — leaf `keccak256(abi.encode(bidder, score))`,
 * sorted-pair fold, `score >= minScore`), the commitment is Nostr (kind 37006
 * score-root records carrying `root`, `epoch`, `indexerUrl` proof pointer and
 * `anchorBlock`), and `buzz trustgraph` is the scoring-operator bridge
 * (compose-root → publish-root → rotate-gate). Selectors are `cast sig` pins,
 * never hand-typed.
 */

import { bytesToHex } from "@noble/hashes/utils.js";

import {
  combineNodeBytes,
  scoreLeafBytes,
  verifyScoreProof,
} from "./trust-score.ts";

// `cast sig "scoreRoot()"` / `cast sig "minScore()"` / `cast sig
// "setScoreRoot(bytes32,uint256)"` — verified against `TrustGatedHook.sol`.
export const SELECTOR_SCORE_ROOT = "0x40aa6ee2";
export const SELECTOR_MIN_SCORE = "0x13c2bedc";
export const SELECTOR_SET_SCORE_ROOT = "0x0355f302";

/** Strict `bytes32` return decode (exactly one 32-byte word), lowercased. */
export function decodeBytes32Word(data: string): string | null {
  const hex = data.startsWith("0x") ? data.slice(2) : data;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  return `0x${hex.toLowerCase()}`;
}

/** Strict `uint256` return decode (exactly one 32-byte word). */
export function decodeUintWord(data: string): bigint | null {
  const hex = data.startsWith("0x") ? data.slice(2) : data;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  return BigInt(`0x${hex}`);
}

/** `setScoreRoot(bytes32,uint256)` calldata (the rotate-gate rotation). */
export function encodeSetScoreRoot(root: string, minScore: bigint): string {
  const hex = root.startsWith("0x") ? root.slice(2) : root;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`root must be 0x + 64 hex: ${root}`);
  }
  if (minScore < 0n || minScore >= 1n << 256n) {
    throw new Error("minScore does not fit uint256");
  }
  return (
    SELECTOR_SET_SCORE_ROOT +
    hex.toLowerCase() +
    minScore.toString(16).padStart(64, "0")
  );
}

export interface TreeLevels {
  /** Levels bottom-up: leaves first, one root last. Each node is 0x+64 hex. */
  levels: string[][];
  root: string;
}

/**
 * Rebuild the score tree exactly as `buzz trustgraph compose-root` does —
 * sorted by member, sorted-pair folds, odd nodes carried up alone. The root
 * this returns must equal the published root for an honest bundle; the card
 * shows both so a mismatch is visible (unreadable ≠ verified).
 */
export function treeLevels(
  entries: readonly { member: string; score: number }[],
): TreeLevels | null {
  if (entries.length === 0) return null;
  const seen = new Set<string>();
  const rows: { member: string; leaf: Uint8Array }[] = [];
  for (const entry of entries) {
    const member = entry.member.replace(/^0x/i, "").toLowerCase();
    if (seen.has(member)) return null; // duplicates prove nothing
    seen.add(member);
    rows.push({ member, leaf: scoreLeafBytes(entry.member, entry.score) });
  }
  rows.sort((a, b) => (a.member < b.member ? -1 : a.member > b.member ? 1 : 0));

  const levels: Uint8Array[][] = [rows.map((r) => r.leaf)];
  while (levels[levels.length - 1].length > 1) {
    const current = levels[levels.length - 1];
    const next: Uint8Array[] = [];
    for (let i = 0; i < current.length; i += 2) {
      next.push(
        i + 1 < current.length
          ? combineNodeBytes(current[i], current[i + 1])
          : current[i],
      );
    }
    levels.push(next);
  }
  const hexLevels = levels.map((level) =>
    level.map((n) => `0x${bytesToHex(n)}`),
  );
  return { levels: hexLevels, root: hexLevels[hexLevels.length - 1][0] };
}

export interface BundleEntry {
  member: string;
  score: number;
  proof: string[];
  /** True only when the proof folds to the record's root (the hook's check). */
  verified: boolean;
}

/**
 * Strictly parse a proofs bundle (`RootBundle.proofs` shape from
 * `buzz trustgraph compose-root`), verifying each proof against `root`.
 * Malformed entries drop — never guessed at.
 */
export function parseBundleEntries(
  proofs: unknown,
  root: string,
): BundleEntry[] {
  if (proofs === null || typeof proofs !== "object") return [];
  const out: BundleEntry[] = [];
  for (const [member, entry] of Object.entries(
    proofs as Record<string, unknown>,
  )) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(member)) continue;
    if (entry === null || typeof entry !== "object") continue;
    const raw = entry as Record<string, unknown>;
    if (typeof raw.score !== "number" || !Array.isArray(raw.proof)) continue;
    const proof = raw.proof.filter(
      (p): p is string =>
        typeof p === "string" && /^0x[0-9a-fA-F]{64}$/.test(p),
    );
    if (proof.length !== raw.proof.length) continue;
    out.push({
      member,
      score: raw.score,
      proof,
      verified: verifyScoreProof(root, member, raw.score, proof),
    });
  }
  out.sort((a, b) => (a.member < b.member ? -1 : a.member > b.member ? 1 : 0));
  return out;
}
