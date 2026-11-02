/**
 * Reading the agreed-contribution lane off the mandate's records.
 *
 * The read is injected (`WorkChain`: `call`/`now`/`logs`, the same seam
 * `workRead.ts` drives), so this module runs its own production code against a
 * fake chain in `agreementsRead.test.mjs`. Every answer keeps its honesty:
 *
 * - **capability first.** `AGREEMENTS_VERSION()` answers the interface marker;
 *   a REVERT or any failed read is *(unreadable)* — never read as "supports
 *   the flow, with nothing in it" and never as "before this flow existed". An
 *   explicitly manifested legacy deployment (a caller-supplied codehash
 *   manifest naming `AGREEMENTS_VERSION`-era code) alone may label one
 *   *(known-legacy)*; a failed getter never does, and unknown versions get
 *   *(unsupported)*. There is no agreed-reward guarantee for unknown versions;
 *   an existing UI's manual legacy flow stays what it is.
 * - **supplied ids are the ids read.** Each id is read from the chain by its
 *   own `agreements(bytes32)` call — a missing record on chain is *absent*,
 *   which is not an empty agreement and not a legacy version. A malformed or
 *   out-of-vocabulary answer is *unreadable*, counted, and shown as such.
 * - **bounded discovery.** Optional account of offers comes from the
 *   `AgreementProposed` logs of the exact mandate address, from an **explicit
 *   start block**, bounded by a limit that reports truncation rather than
 *   scanning without end — workRead's read bounds, applied here.
 *
 * This module never claims reservation headroom: a budget shows its answer at
 * acceptance on chain. Reservation counters that *are* on the record are read
 * and reported as figures, not as promises.
 */

import {
  decodeAgreementRow,
  decodeSplitsRow,
  type AgreementTerms,
  AGREEMENTS_VERSION,
  encodeReadAgreement,
  encodeReadSplits,
  encodeReadAgreementsVersion,
  encodeReadSharesReserved,
  splitHashOf,
  AGREE_SIGNATURES,
} from "./agreements.ts";
import { topicOf } from "./work.ts";

/** How a chain answers this module's reads: the seam `workRead.ts` poses. */
export interface AgreementsChain {
  /** An `eth_call`'s raw hex answer; a revert or no answer throws. */
  call(to: string, data: string): Promise<string>;
  /** The latest block's timestamp in seconds. */
  now(): Promise<number>;
  /** `eth_getLogs` over the asked range: address + full topic filter. */
  logs(filter: {
    address: string;
    topics: (string | null)[];
    fromBlock?: number | string;
    toBlock?: number | string;
  }): Promise<readonly unknown[]>;
  /** The deployed code's hash at an address (`UNKNOWN_CODE`. style), if the chain offers it. */
  codeHash?(address: string): Promise<string | null>;
}

// ── capability ───────────────────────────────────────────────────────────────

export type AgreementsCapability =
  | "supported"
  | "unsupported"
  | "known-legacy"
  | "unreadable";

/** A caller-supplied answer to "which deployments ran the version before 1". */
export interface AgreementsLegacyManifest {
  /** Deployed-bytecode hashes (keccak of the runtime code, 0x + 64 hex). */
  codeHashes: readonly string[];
}

/** A version read's outcome, as the byte seam answers it. */
export interface VersionRead {
  /** The `uint16` answer, when a read succeeded. */
  value?: bigint;
  /** Non-null when the call reverted or got no answer. */
  error?: unknown;
}

/**
 * Which capability this mandate's agreed-reward lane has. The rules, in order:
 *
 * 1. a read that succeeded with the marker's value → `supported`;
 * 2. a read that succeeded with a different value → `unsupported`… unless an
 *    explicit manifest matches the deployed code hash → `known-legacy`
 *    (the manifest is the only known-legacy source, never a getter's failure);
 * 3. a read that failed → `unreadable`… with the same explicit-manifest
 *    exception (a caller may pin a code hash it knows, even while the getter
 *    refuses — the classification is then still explicit, not inferred);
 * 4. no hash to check → the failure stays `unreadable`.
 */
export function resolveAgreementsCapability(input: {
  version: VersionRead;
  codeHash?: string | null;
  legacyManifest?: AgreementsLegacyManifest | null;
}): AgreementsCapability {
  const hash = input.codeHash?.toLowerCase() ?? null;
  const manifestHashes = (input.legacyManifest?.codeHashes ?? []).map((h) =>
    h.toLowerCase(),
  );
  const explicitlyKnown = hash !== null && manifestHashes.includes(hash);
  if (input.version.error === undefined && input.version.value !== undefined) {
    return input.version.value === BigInt(AGREEMENTS_VERSION)
      ? "supported"
      : explicitlyKnown
        ? "known-legacy"
        : "unsupported";
  }
  return explicitlyKnown ? "known-legacy" : "unreadable";
}

/**
 * One chain read of the marker. A revert is an error, never a version, and
 * never the whole read's failure: the caller decides (with
 * {@link resolveAgreementsCapability}) what an explicit manifest adds. The
 * answer must be exactly one canonical ABI word — a short, empty, or
 * trailing-byte answer is refused as malformed, never read as a version.
 */
export async function readAgreementsVersion(
  chain: AgreementsChain,
  mandate: string,
): Promise<VersionRead> {
  try {
    const hex = await chain.call(mandate, encodeReadAgreementsVersion());
    if (hex === undefined || hex === null)
      throw new Error("the chain gave no answer");
    const body = hex.replace(/^0x/, "");
    if (body.length !== 64) {
      throw new Error("the version answer is not one exactly 32-byte word");
    }
    return { value: BigInt(`0x${body}`) };
  } catch (error) {
    return { error };
  }
}

// ── rows ─────────────────────────────────────────────────────────────────────

/** A supplied id's honest row. `absent` is not an empty agreement. */
export type AgreementRow =
  | { id: string; kind: "absent" }
  | {
      id: string;
      kind: "present";
      terms: AgreementTerms;
      /** The declared split once the getter answered: declared, none, or explicitly unreadable. */
      split:
        | { kind: "declared"; parties: string[]; percentages: number[] }
        | { kind: "none" }
        | { kind: "unreadable"; reason: string };
    }
  | { id: string; kind: "unreadable"; reason: string };

/** The record-only row the first call answers (before the split getter joins it). */
type RecordRow =
  | { id: string; kind: "absent" }
  | { id: string; kind: "present"; terms: AgreementTerms }
  | { id: string; kind: "unreadable"; reason: string };

export const MAX_AGREEMENT_IDS = 32;

/**
 * The record read: whatever the chain answers for one id — present, absent
 * (the id is free) or unreadable, with the reason kept. A malformed or
 * failed read never turns into an absence.
 */
async function asRecordRow(
  id: string,
  read: Promise<string>,
): Promise<RecordRow> {
  try {
    const decoded = decodeAgreementRow(id, await read);
    if (decoded.kind === "absent") return { id, kind: "absent" };
    return { id, kind: "present", terms: decoded.terms };
  } catch (error) {
    return {
      id,
      kind: "unreadable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Read the records for the **supplied** ids, bounded. Each id is its own
 * `agreements(bytes32)` call, bound to the chain — never to what a cache or a
 * client says; ids past the cap are reported as truncation, not dropped
 * silently (the cap is this read's own bound, like `workRead`'s claim list).
 * A record carrying a split commitment gets its split read too: the mandate's
 * split getter is the split's source, never the proposal's word.
 */
export async function readAgreementRows(
  chain: AgreementsChain,
  mandate: string,
  ids: readonly string[],
): Promise<{ rows: AgreementRow[]; truncated: boolean }> {
  const truncated = ids.length > MAX_AGREEMENT_IDS;
  const wanted = ids.slice(0, MAX_AGREEMENT_IDS);
  const rows: AgreementRow[] = await Promise.all(
    wanted.map(async (id) => {
      const record = await asRecordRow(
        id,
        chain.call(mandate, encodeReadAgreement(id)),
      );
      if (record.kind !== "present") return record;
      // No commitment, no declaration: the whole quantity is the beneficiary's.
      if (record.terms.splitHash === `0x${"0".repeat(64)}`) {
        return { ...record, split: { kind: "none" } };
      }
      try {
        const split = decodeSplitsRow(
          id,
          await chain.call(mandate, encodeReadSplits(id)),
        );
        // The record's commitment and the getter's declaration must agree: a
        // mismatch is recorded, never smothered (the mandate reverts an
        // acceptance that did not reproduce the commit, so this fires only on
        // an in-flight record change someone must see).
        if (
          split.parties.length !== 0 &&
          splitHashOf(split.parties, split.percentages) !==
            record.terms.splitHash.toLowerCase()
        ) {
          return {
            ...record,
            split: {
              kind: "unreadable",
              reason:
                "the declared split does not match the record's own commitment",
            },
          };
        }
        return {
          ...record,
          split: {
            kind: "declared",
            parties: split.parties,
            percentages: split.percentages,
          },
        };
      } catch (error) {
        return {
          ...record,
          split: {
            kind: "unreadable",
            reason: error instanceof Error ? error.message : String(error),
          },
        };
      }
    }),
  );
  return { rows, truncated };
}

// ── bounded discovery ───────────────────────────────────────────────────────

/** Topic0 of `AgreementProposed(bytes32 indexed, bytes32 indexed, address indexed, uint128, uint64, uint64, bytes32)`. */
export const TOPIC_AGREEMENT_PROPOSED = topicOf(
  "AgreementProposed(bytes32,bytes32,address,uint128,uint64,uint64,bytes32)",
);

export const AGREEMENTS_DISCOVERY_LIMIT = 50;

export interface DiscoveredOffer {
  agreementId: string;
  projectId: string;
  beneficiary: string;
  shares: bigint;
  workDeadline: number;
  revisionDeadline: number;
  splitHash: string;
  /**
   * Not carried by the proposal event: the review period, the criteria hash and
   * the policy reference live on the agreement record (`agreements(bytes32)`),
   * which the row read supplies. Kept as nullable here so a caller can never
   * mistake an event field for one of them.
   */
  reviewPeriod: number | null;
  criteriaHash: string | null;
  policyRef: string | null;
}

/**
 * Discover the mandate's offers from its own `AgreementProposed` logs, from
 * the **explicit start block** the caller names (an offer's history is as old
 * as the deployment says it is; nothing here guesses a start), bounded to
 * `limit` newest-late logs — a page that stops early is marked truncated and
 * says so, never silently cut, and a failed log read is an error, never a
 * silent false empty.
 */
export async function discoverAgreementOffers(
  chain: AgreementsChain,
  mandate: string,
  startBlock: number | string,
  limit: number = AGREEMENTS_DISCOVERY_LIMIT,
): Promise<{ offers: DiscoveredOffer[]; truncated: boolean }> {
  if (startBlock === undefined || startBlock === null) {
    throw new Error(
      "an offer discovery needs an explicit start block — none was named",
    );
  }
  if (limit <= 0) throw new Error("a discovery limit is a positive count");
  const logs = await chain.logs({
    address: mandate,
    topics: [TOPIC_AGREEMENT_PROPOSED],
    fromBlock: startBlock,
  });
  const bounded = logs.slice(-limit);
  const offers = bounded
    .map(decodeAgreementProposed)
    .flatMap((o) => (o ? [o] : []));
  // A log reached but unreadable is not skipped: count it, surface it.
  const unreadable = bounded.length - offers.length;
  return {
    offers,
    truncated: logs.length > bounded.length || unreadable > 0,
  };
}

/** Decode one `AgreementProposed` log, or null when it is not that event. */
export function decodeAgreementProposed(log: unknown): DiscoveredOffer | null {
  const asRecord = log as { topics?: string[]; data?: string };
  const topics = asRecord.topics;
  if (
    !topics ||
    topics.length < 4 ||
    (topics[0] ?? "").toLowerCase() !== TOPIC_AGREEMENT_PROPOSED
  ) {
    return null;
  }
  const data = (asRecord.data ?? "").replace(/^0x/, "");
  const wordsOf = (hex: string): bigint[] => {
    const out: bigint[] = [];
    for (let i = 0; i + 64 <= hex.length; i += 64) {
      out.push(BigInt(`0x${hex.slice(i, i + 64)}`));
    }
    return out;
  };
  const words = wordsOf(data);
  // The event carries four data words: shares, workDeadline, revisionDeadline,
  // splitHash. The record (not the log) holds the review period, criteria hash
  // and policy reference, so they are never invented here.
  if (words.length < 4) return null;
  const addressOf = (w: bigint): string =>
    `0x${w.toString(16).padStart(40, "0")}`;
  const bytes32Of = (w: bigint): string =>
    `0x${w.toString(16).padStart(64, "0")}`;
  const seconds = (w: bigint): number | null =>
    w > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(w);
  const workDeadline = seconds(words[1]);
  const revisionDeadline = seconds(words[2]);
  if (workDeadline === null || revisionDeadline === null) {
    // An event with impossible timestamps is past what this reader tracks; it
    // counts toward truncation above rather than being silently cut.
    return null;
  }
  return {
    agreementId: bytes32Of(BigInt(topics[1])),
    projectId: bytes32Of(BigInt(topics[2])),
    beneficiary: addressOf(BigInt(topics[3])),
    shares: words[0],
    workDeadline,
    revisionDeadline,
    splitHash: bytes32Of(words[3]),
    reviewPeriod: null,
    criteriaHash: null,
    policyRef: null,
  };
}

// ── snapshot ────────────────────────────────────────────────────────────────

export interface AgreementsSnapshot {
  mandate: string;
  capability: AgreementsCapability;
  chainTime: number;
  rows: AgreementRow[];
  /** Supplied ids past the bound: reported, never dropped. */
  truncatedIds: boolean;
  /** Whether the capability read could not answer (rows still say what they saw). */
  versionUnreadable: boolean;
}

/**
 * One bounded snapshot of a mandate's agreed-reward lane: its capability, the
 * chain's clock, and the honest rows of the ids the caller supplied. IDs are
 * read from the chain by their own calls; nothing else is, and the read never
 * converts a failure into an absence or an absence into a legacy version.
 */
export async function readAgreementsSnapshot(input: {
  chain: AgreementsChain;
  mandate: string;
  ids: readonly string[];
  legacyManifest?: AgreementsLegacyManifest | null;
}): Promise<AgreementsSnapshot> {
  const chainTime = await input.chain.now();
  const version = await readAgreementsVersion(input.chain, input.mandate);
  let codeHash: string | null = null;
  if (input.chain.codeHash) {
    try {
      codeHash = await input.chain.codeHash(input.mandate);
    } catch {
      codeHash = null; // no hash is no classification: the failure says so
    }
  }
  const capability = resolveAgreementsCapability({
    version,
    codeHash,
    legacyManifest: input.legacyManifest,
  });
  const { rows, truncated } = await readAgreementRows(
    input.chain,
    input.mandate,
    input.ids,
  );
  return {
    mandate: input.mandate,
    capability,
    chainTime,
    rows,
    truncatedIds: truncated,
    versionUnreadable: version.error !== undefined,
  };
}

// ── reservation reading (figures, never promises) ──────────────────────────

/**
 * The work area's outstanding reservation — a figure the record itself keeps,
 * headroom to be judged against budgets only the chain read establishes at
 * acceptance. A failed read throws: nothing here turns it into a zero, which
 * would promise space that is not there.
 */
export async function readSharesReserved(
  chain: AgreementsChain,
  mandate: string,
  projectId: string,
): Promise<bigint> {
  const hex = await chain.call(mandate, encodeReadSharesReserved(projectId));
  const body = hex.replace(/^0x/, "");
  if (body.length !== 64)
    throw new Error("the reservation answer is not a word");
  return BigInt(`0x${body}`);
}

/** The signature strings this reader is bound to (the caller may mirror them). */
export const AGREEMENTS_READ_SIGNATURES = AGREE_SIGNATURES;
