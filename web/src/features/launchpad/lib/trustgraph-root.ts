/**
 * The scoring-operator composer: a scores set -> the sorted-pair Merkle root
 * and per-member proofs, plus the score-root record the operator publishes.
 *
 * Ported field-for-field from `buzz trustgraph compose-root`/`publish-root`
 * (`crates/buzz-cli/src/commands/trustgraph.rs`): the same leaf
 * (`keccak256(abi.encode(member, score))` via `trust-score.ts`, which is the
 * hook's own layout), the same sorted-by-member tree with odd nodes carried
 * up alone, and the same canonical record JSON (serde_json emits keys sorted,
 * so the content string here is byte-identical to the CLI's). `trustgraph-root.test.mjs`
 * binds every one of those shapes to the CLI's golden vectors.
 *
 * Proofs-map keys are `0x`-prefixed lowercase member addresses — the web wire
 * convention `trust-gate.ts`'s `parseBundleEntries` reads back. The CLI keys
 * the same map by the bare hex; the member bytes (and the root) are identical.
 */

import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

import { combineNodeBytes, scoreLeafBytes } from "./trust-score.ts";

/** The canonical program id the launchpad's community track reads. */
export const DEFAULT_PROGRAM = "trustgraphs.output.nostr-member.v1";

/** One score row — the `TrustScore` shape of `trust-score.ts`. */
export interface ScoreRow {
  member: string;
  score: number;
}

export interface MemberProof {
  score: number;
  proof: string[];
}

/** The `compose-root` bundle: the record fields plus the proofs body. */
export interface RootBundle {
  program: string;
  root: string;
  epoch: string;
  /** Where the per-member proofs bundle is served from (optional). */
  indexerUrl: string | null;
  /** Block the scores were anchored at, when the engine records one. */
  anchorBlock: number | null;
  /** member (`0x` + 40 lowercase hex) -> score + sorted-pair Merkle proof. */
  proofs: Record<string, MemberProof>;
}

const MEMBER_RE = /^0x[0-9a-fA-F]{40}$/;
export const ROOT_RE = /^0x[0-9a-fA-F]{64}$/;

/** Lowercase, `0x`-prefixed member key; throws on a non-address. */
function memberKey(member: string): string {
  const trimmed = member.trim();
  if (!MEMBER_RE.test(trimmed)) {
    throw new Error(`bad member address: ${member}`);
  }
  return trimmed.toLowerCase();
}

function checkScore(score: number): void {
  if (!Number.isSafeInteger(score) || score < 0) {
    throw new Error(`score must be a non-negative whole number: ${score}`);
  }
}

/**
 * Build the tree over `scores`, sorted by member (deterministic across input
 * order). Odd levels carry the last node up alone. Refuses duplicate
 * members — a root with ambiguous leaves proves nothing — and verifies every
 * emitted proof folds back to the root before returning.
 */
export function composeRootBundle(args: {
  scores: readonly ScoreRow[];
  program: string;
  epoch: string;
  indexerUrl?: string | null;
  anchorBlock?: number | null;
}): RootBundle {
  const { scores, program, epoch } = args;
  if (scores.length === 0) {
    throw new Error("no scores yet — add at least one member and score");
  }
  const rows: {
    key: string;
    member: string;
    score: number;
    leaf: Uint8Array;
  }[] = [];
  const seen = new Set<string>();
  for (const row of scores) {
    const key = memberKey(row.member);
    checkScore(row.score);
    if (seen.has(key)) throw new Error(`duplicate member ${key}`);
    seen.add(key);
    rows.push({
      key,
      member: row.member.trim(),
      score: row.score,
      leaf: scoreLeafBytes(row.member, row.score),
    });
  }
  rows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  // Level-by-level tree; proofs walk the sibling at (i ^ 1) per level.
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
  const root = levels[levels.length - 1][0];
  const rootHex = `0x${bytesToHex(root)}`;

  const proofs: Record<string, MemberProof> = {};
  for (const [idx, row] of rows.entries()) {
    const path: Uint8Array[] = [];
    let i = idx;
    for (const level of levels.slice(0, levels.length - 1)) {
      const sibling = i ^ 1;
      if (sibling < level.length) path.push(level[sibling]);
      i = Math.floor(i / 2);
    }
    // The path must fold to the root — anything else is a broken tree.
    let node = row.leaf;
    for (const sibling of path) node = combineNodeBytes(node, sibling);
    if (bytesToHex(node) !== bytesToHex(root)) {
      throw new Error(
        `internal: proof for ${row.key} does not fold to the root`,
      );
    }
    proofs[row.key] = {
      score: row.score,
      proof: path.map((h) => `0x${bytesToHex(h)}`),
    };
  }

  return {
    program,
    root: rootHex,
    epoch,
    indexerUrl: args.indexerUrl ?? null,
    anchorBlock: args.anchorBlock ?? null,
    proofs,
  };
}

/** The published record: kind, canonical content JSON, and the d/t tags. */
export interface ScoreRootEventParts {
  /** Byte-identical to the CLI's canonical JSON (sorted keys). */
  content: string;
  extraTags: Array<[string, string]>;
}

/**
 * The score-root record: parameterized-replaceable, `d = <program>:<epoch>`,
 * global-only (never channel-scoped). The content string matches the CLI's
 * `build_root_event` serialization exactly: keys sorted, root lowercased,
 * optional fields present only when set.
 */
export function scoreRootEventParts(bundle: {
  program: string;
  root: string;
  epoch: string;
  indexerUrl?: string | null;
  anchorBlock?: number | null;
}): ScoreRootEventParts {
  const program = bundle.program;
  const epoch = bundle.epoch;
  if (program.trim() === "" || epoch.trim() === "") {
    throw new Error("the program and epoch are both required");
  }
  const root = bundle.root.trim();
  if (!ROOT_RE.test(root)) {
    throw new Error(
      `the root must be 0x followed by 64 hex characters: ${root}`,
    );
  }
  // Insertion order = serde_json's sorted map order: anchorBlock, epoch,
  // indexerUrl, program, root.
  const content: Record<string, string | number> = {};
  if (bundle.anchorBlock !== null && bundle.anchorBlock !== undefined) {
    content.anchorBlock = bundle.anchorBlock;
  }
  content.epoch = epoch;
  if (bundle.indexerUrl) content.indexerUrl = bundle.indexerUrl;
  content.program = program;
  content.root = root.toLowerCase();
  return {
    content: JSON.stringify(content),
    extraTags: [
      ["d", `${program}:${epoch}`],
      ["t", "dao-launchpad"],
    ],
  };
}

/** Strict hex decode for callers that need the root as bytes. */
export function rootBytes(root: string): Uint8Array | null {
  const hex = root.trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  return hexToBytes(hex.toLowerCase());
}
