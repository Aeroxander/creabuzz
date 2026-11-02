/**
 * The agreed-reward lane a Work tab reads: every known mandate's offers and
 * agreements, each with its real terms, its bound attempt and the corrections
 * state around it — plus the deliverable and corrections words the people
 * published beside the chain.
 *
 * Reads stay honest the way the whole work read does:
 *
 * - bounded discovery from an **explicit start block** (the mandate's own
 *   creation block, a real chain fact). A discovery that cannot run or a start
 *   the chain does not give is named (`offersUnavailable`), never quietly read
 *   as empty, and a pageful is marked truncated;
 * - capability first: a version getter that refuses is an unreadable read,
 *   never "known-legacy"; a version this screen does not know is read-only
 *   unknown and the existing manual claim flow stays untouched;
 * - a kept attempt (`lib/agreed-submission.ts`) is asked for too, so the offer
 *   behind it is listed even when the bounded discovery does not reach it;
 * - query keys carry the chain, the server and the wallet: what this page
 *   captured is what this read answers.
 *
 * In production this module drives the app's own calls (`getRpcEndpoint`,
 * `ethGetLogs`); the pure logic inside (`lib/agreed-lane.ts`,
 * `lib/agreed-submission.ts`, and the core adapters) is what the node tests
 * bind. The deliverable and corrections words ride the launch's existing
 * update kind — no new server event kind and no invented network methods.
 */

import { useQuery } from "@tanstack/react-query";

import {
  addressTopic,
  decodeAddress,
  decodeMandateCreated,
  decodeWord,
  encodeCall0,
  TOPIC_MANDATE_CREATED,
  SIGNATURES,
} from "@creaton/core/launchpad/work.ts";
import type {
  WorkSnapshot,
  MandateView,
} from "@creaton/core/launchpad/workRead.ts";
import type { ClaimView } from "@creaton/core/launchpad/work.ts";
import type { AgreementRow } from "@creaton/core/launchpad/agreementsRead.ts";
import {
  AGREEMENTS_DISCOVERY_LIMIT,
  type AgreementsCapability,
  type AgreementsChain,
  discoverAgreementOffers,
  readAgreementsSnapshot,
} from "@creaton/core/launchpad/agreementsRead.ts";
import {
  encodeReadAgreementOfClaim,
  encodeReadCorrectionsCount,
} from "@creaton/core/launchpad/agreements.ts";
import type { AgreementDescriptor, CorrectionsWords } from "./lib/agreed-lane";
import { correctionsOfEvents, descriptorsOfEvents } from "./lib/agreed-lane";
import { listedDrafts } from "./lib/agreed-submission";
import {
  ethBlockNumber,
  ethBlockTimestamps,
  ethCall,
  ethGetLogs,
  getRpcEndpoint,
} from "./chain";
import { readEvidenceEvents } from "./lib/evidence-query";
import { launchCoordinate, type Launch } from "./models";
import { existingUserPubkey } from "@/shared/lib/identity";
import { queryEvents } from "@/shared/lib/nostr-client";
import { relayWsUrl } from "@/shared/lib/relay-url";

// ── the shape a mandate's lane takes ─────────────────────────────────────────

/** One agreement: the record, its attempt and the words published for it. */
export interface AgreementItem {
  row: AgreementRow;
  /** The deliverable's words the manager published, when this server has them. */
  descriptor: AgreementDescriptor | null;
  /** Whether a reviewer asked for corrections: null when the count could not be read. */
  correctionsRequested: boolean | null;
  /** The bound attempt, as the work read carries it; null while none or unread. */
  claim: ClaimView | null;
}

export interface AgreementsLane {
  /** The mandate, lower case (the key lanes are read under). */
  mandate: string;
  capability: AgreementsCapability;
  /** The version getter answered nothing: only a manifest could say more. */
  versionUnreadable: boolean;
  chainTime: number;
  /** The explicit start block the offers were discovered from; null when unknown. */
  startBlock: number | null;
  /** The newest offers would not all fit; the page says so, never silently cuts. */
  offersTruncated: boolean;
  /** More agreement ids were supplied than one read takes: said out loud, never dropped. */
  idsTruncated: boolean;
  /** Why the offers could not be discovered: never read as "no offers". */
  offersUnavailable: string | null;
  agreements: AgreementItem[];
  /**
   * Claim ids the chain read named as agreement attempts, lower case — the
   * current one and every superseded one the bound claims gave an id for. The
   * legacy award-vote path must leave every one of them alone.
   */
  boundClaims: ReadonlyMap<string, string>;
  /** A bound-claim read failed: the page says the check is unknown there. */
  linksUnreadable: boolean;
  /** The offer and corrections words could not be read from this server. */
  wordsUnreadable: boolean;
  /** The corrections words people published for this budget's claims. */
  correctionsWords: CorrectionsWords[] | null;
}

/** How the lane read went, per screen — never an error reshaped into empty. */
export type AgreementsRead =
  | { state: "loading" }
  | { state: "error" }
  | {
      state: "ready";
      lanes: ReadonlyMap<string, AgreementsLane>;
      /** How each mandate's lane failed, for the pages that say so plainly. */
      errors: ReadonlyMap<string, string>;
    };

// ── the chain seam this hook drives (bounded history, honoring fromBlock) ─────

/**
 * The agreed-reward reader's chain: the app's captured endpoint, with log
 * reads that honor the range the caller names. The generic work reader forces
 * whole history; bounded discovery needs the caller's start to mean what it
 * says, so this seam passes it through (bounded by the build's own history
 * floor inside `ethGetLogs`).
 */
function agreementsChain(endpoint: string): AgreementsChain {
  return {
    call: (to, data) => ethCall(endpoint, to, data),
    now: async () => {
      const head = Number(await ethBlockNumber(endpoint));
      const [sample] = await ethBlockTimestamps(endpoint, [head]);
      if (!sample) throw new Error("the chain did not report its latest block");
      return sample.timestampSeconds;
    },
    logs: (filter) =>
      ethGetLogs(endpoint, {
        address: filter.address,
        topics: [...filter.topics],
        fromBlock:
          filter.fromBlock === undefined
            ? "0x0"
            : typeof filter.fromBlock === "number"
              ? `0x${filter.fromBlock.toString(16)}`
              : String(filter.fromBlock),
        toBlock: "latest",
      }),
  };
}

/** How many newest claims one lane checks against agreement bindings, bounded. */
const LINK_READ_LIMIT = 24;

async function startBlockFor(
  endpoint: string,
  dao: string,
  mandate: string,
): Promise<number> {
  const policy = decodeAddress(
    await ethCall(endpoint, dao, encodeCall0(SIGNATURES.policy)),
  );
  const factory = decodeAddress(
    await ethCall(endpoint, policy, encodeCall0(SIGNATURES.factory)),
  );
  const logs = await ethGetLogs(endpoint, {
    address: factory,
    topics: [TOPIC_MANDATE_CREATED, addressTopic(dao), addressTopic(mandate)],
    fromBlock: "0x0",
    toBlock: "latest",
  });
  // The budget's creation block is the one its own creation event was written
  // in: a real chain fact, verified against the event's own subjects.
  const first = logs
    .map((log) => ({ event: decodeMandateCreated(log), log }))
    .find(
      (made) =>
        made.event !== null &&
        made.event.mandate.toLowerCase() === mandate.toLowerCase() &&
        made.event.dao.toLowerCase() === dao.toLowerCase(),
    );
  if (!first) throw new Error("the budget's creation block did not answer");
  return Number(BigInt(first.log.blockNumber as string));
}

/**
 * The words published beside the chain, from the same bounded update read the
 * evidence uses: each agreement's deliverable (`agreement`), and the reviewers'
 * corrections words for one claim (`agreementCorrections`).
 */
async function readAgreedWords(coordinate: string): Promise<{
  descriptors: AgreementDescriptor[];
  corrections: CorrectionsWords[];
}> {
  const contentOf = (raw: string): Record<string, unknown> | null => {
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed !== null && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  };
  const { events } = await readEvidenceEvents(
    (filter) => queryEvents(relayWsUrl(), filter),
    coordinate,
  );
  return {
    descriptors: descriptorsOfEvents(events, contentOf),
    corrections: correctionsOfEvents(events, contentOf),
  };
}

interface DraftsHint {
  mandate: string;
  agreementId: string;
  claimId: string;
}

/**
 * One mandate's lane, read on the app's real endpoint. Every failure inside
 * becomes part of the answer (`startBlock`, `wordsUnreadable`,
 * `linksUnreadable`), never a silently shrunken list.
 */
async function readLane(
  endpoint: string,
  dao: string,
  words: AgreementDescriptor[] | null,
  corrections: CorrectionsWords[] | null,
  drafts: DraftsHint[],
  mandateView: MandateView,
): Promise<AgreementsLane> {
  const mandate = mandateView.address.toLowerCase();
  const chain = agreementsChain(endpoint);
  // The base capability read first: version, records, and the kept attempt's
  // own ids — joining discovery with what this browser already holds.
  let startBlock: number | null = null;
  try {
    startBlock = await startBlockFor(endpoint, dao, mandate);
  } catch {
    startBlock = null;
  }
  let offers: Awaited<ReturnType<typeof discoverAgreementOffers>>["offers"] =
    [];
  let offersTruncated = false;
  let offersUnavailable: string | null = null;
  if (startBlock !== null) {
    try {
      const found = await discoverAgreementOffers(
        chain,
        mandate,
        startBlock,
        AGREEMENTS_DISCOVERY_LIMIT,
      );
      offers = found.offers;
      offersTruncated = found.truncated;
    } catch {
      offersUnavailable =
        "This budget's offers could not be read just now, so only the ones you already hold are listed. Refresh in a minute.";
    }
  } else {
    offersUnavailable =
      "This budget's offers are not listed here: the block its history starts from could not be read. Refresh in a minute, or ask for the offer directly.";
  }
  const draftsUnder = drafts
    .filter((draft) => draft.mandate.toLowerCase() === mandate)
    .map((draft) => draft.agreementId);
  // The words a manager published beside an offer name its agreement id, so an
  // offer is read from the chain even when the bounded log discovery cannot
  // reach it (or failed): the record itself still answers, by id.
  const publishedUnder = (words ?? [])
    .filter((item) => item.mandate.toLowerCase() === mandate)
    .map((item) => item.agreementId);
  const ids = [
    ...new Set([
      ...offers.map((o) => o.agreementId.toLowerCase()),
      ...draftsUnder.map((id) => id.toLowerCase()),
      ...publishedUnder.map((id) => id.toLowerCase()),
    ]),
  ];
  const snapshot = await readAgreementsSnapshot({ chain, mandate, ids });
  // The corrections count sits on the reviewer set the mandate was born with.
  const counts = await Promise.all(
    snapshot.rows.map(async (row): Promise<boolean | null> => {
      if (row.kind !== "present" || row.terms.claimId === null) return false;
      try {
        const hex = await chain.call(
          mandateView.verifiersAddress,
          encodeReadCorrectionsCount(row.terms.claimId),
        );
        return decodeWord(hex) > 0n;
      } catch {
        return null;
      }
    }),
  );
  // Which of the listed claims the chain has bound to an agreement — the
  // award-vote path must leave those alone. Opportunity-shaped reads only:
  // the claims the award step belongs to, up to a bound.
  const awardable = mandateView.claims
    .filter((claim) => claim.record.status === "Paid" && !claim.sharesAwarded)
    .slice(-LINK_READ_LIMIT);
  const links = new Map<string, string>();
  let linksUnreadable = false;
  await Promise.all(
    awardable.map(async (claim) => {
      try {
        const id = decodeWord(
          await chain.call(mandate, encodeReadAgreementOfClaim(claim.id)),
        );
        if (id !== 0n) {
          links.set(
            claim.id.toLowerCase(),
            `0x${id.toString(16).padStart(64, "0")}`,
          );
        }
      } catch {
        linksUnreadable = true;
      }
    }),
  );
  const agreements: AgreementItem[] = snapshot.rows.map((row, index) => {
    if (row.kind !== "present")
      return { row, descriptor: null, correctionsRequested: null, claim: null };
    const claimId = row.terms.claimId?.toLowerCase() ?? null;
    const descriptor =
      words === null
        ? null
        : (words.find((item) => item.agreementId === row.id.toLowerCase()) ??
          null);
    return {
      row,
      descriptor,
      correctionsRequested: counts[index],
      claim:
        claimId !== null
          ? (mandateView.claims.find(
              (claim) => claim.id.toLowerCase() === claimId,
            ) ?? null)
          : null,
    };
  });
  return {
    mandate,
    capability: snapshot.capability,
    versionUnreadable: snapshot.versionUnreadable,
    chainTime: snapshot.chainTime,
    startBlock,
    offersTruncated,
    idsTruncated: snapshot.truncatedIds,
    offersUnavailable,
    agreements,
    boundClaims: links,
    linksUnreadable,
    wordsUnreadable: words === null,
    correctionsWords:
      corrections === null
        ? null
        : corrections.filter((item) => item.mandate.toLowerCase() === mandate),
  };
}

/**
 * The agreed-reward lanes for every mandate the work read named, on the
 * launch's captured chain. Wallet goes into the key so a form that switches
 * account never reads another's kept attempts; the work snapshot is the read
 * the lanes hang from.
 */
export function useAgreements(
  launch: Launch,
  dao: string,
  wallet: string | null,
  work: WorkSnapshot | undefined,
) {
  const coordinate = launchCoordinate(launch.record.author, launch.record.id);
  return useQuery({
    queryKey: [
      "launchpad",
      "work",
      dao,
      "agreements",
      getRpcEndpoint(),
      relayWsUrl(),
      wallet ?? "",
    ],
    enabled: work !== undefined,
    queryFn: async (): Promise<AgreementsRead> => {
      const endpoint = getRpcEndpoint();
      let words: AgreementDescriptor[] | null = null;
      let corrections: CorrectionsWords[] | null = null;
      try {
        const read = await readAgreedWords(coordinate);
        words = read.descriptors;
        corrections = read.corrections;
      } catch {
        words = null;
        corrections = null;
      }
      const drafts = listedDrafts(undefined, {
        server: relayWsUrl(),
        account: existingUserPubkey() ?? "",
        wallet: wallet ?? "",
        chainId: launch.record.chainId ?? "",
      });
      const lanes = new Map<string, AgreementsLane>();
      const errors = new Map<string, string>();
      const mandates = (work as WorkSnapshot).mandates;
      const values = await Promise.all(
        mandates.map(async (mandateView) => {
          const key = mandateView.address.toLowerCase();
          try {
            const lane = await readLane(
              endpoint,
              dao,
              words,
              corrections,
              drafts,
              mandateView,
            );
            return [key, lane] as const;
          } catch (error) {
            errors.set(
              key,
              error instanceof Error ? error.message : `${error}`,
            );
            return [key, null] as const;
          }
        }),
      );
      for (const [key, lane] of values) {
        if (lane !== null) lanes.set(key, lane);
      }
      return { state: "ready", lanes, errors };
    },
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  });
}
