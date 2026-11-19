/**
 * The earlier-backers page's reads, all through the person's wallet and all about the one line their link names. Nothing
 * here asks the contract for any other line: the read calls carry this line's index only (`earlier.test.tsx` holds that).
 */
import { serverRelaySigner } from "@creaton/core/client/server-settings.ts";
import {
  CLAIM_READS,
  type ClaimEntry,
  type ClaimLink,
  fingerprintOf,
  leafOf,
  parseBytes32,
  parseEntry,
  parseFlag,
  parseWord,
} from "@creaton/core/launchpad/earlier-claim.ts";
import { useQuery } from "@tanstack/react-query";
import { investingOn } from "../../lib/server";
import type { EarlierCounts } from "../money/numbers-market";
import { parseNumbers } from "../money/numbers";
import { useRecentNumbers, useWallet } from "../money/use-money";

/** Where the list is: the claim contract, its network and the counts the server's record tells. */
export interface EarlierPlace {
  claim: string;
  chainId: number;
  counts: EarlierCounts;
}

/** The newest record of numbers (signed by the server) that names a claim contract, or null. */
export function useEarlierPlace() {
  const recent = useRecentNumbers(true, 3);
  const signer = serverRelaySigner();
  if (!recent.data)
    return { place: null, loading: recent.isPending, error: recent.isError };
  for (const event of recent.data.events) {
    const numbers = parseNumbers(event, signer);
    if (!numbers || numbers.removed) continue;
    const counts = numbers.market.earlier;
    if (counts) {
      return {
        place: {
          claim: counts.claim,
          chainId: numbers.chainId,
          counts,
        } as EarlierPlace,
        loading: false,
        error: false,
      };
    }
  }
  return { place: null, loading: false, error: false };
}

export interface ClaimList {
  textHash: string;
  summaryHash: string;
  textVersion: bigint;
  key: string;
  closed: boolean;
  closeAt: bigint;
  funded: boolean;
  entryCount: bigint;
}

/** The list's own fixed facts, which are the same for every line (no line is asked for). */
export function useClaimList(place: EarlierPlace | null) {
  const wallet = useWallet();
  return useQuery({
    queryKey: ["team", "earlier", "list", place?.chainId, place?.claim],
    enabled: investingOn() && Boolean(place) && wallet.isAvailable(),
    staleTime: 15_000,
    queryFn: async (): Promise<ClaimList> => {
      if (!place) throw new Error("No list.");
      const ask = (data: string) => wallet.readCall(place.claim, data);
      const [
        textHash,
        summaryHash,
        textVersion,
        key,
        closed,
        closeAt,
        total,
        funding,
        entryCount,
      ] = await Promise.all([
        ask(CLAIM_READS.textHash),
        ask(CLAIM_READS.summaryHash),
        ask(CLAIM_READS.textVersion),
        ask(CLAIM_READS.key),
        ask(CLAIM_READS.closed),
        ask(CLAIM_READS.closeAt),
        ask(CLAIM_READS.total),
        ask(CLAIM_READS.funding),
        ask(CLAIM_READS.entryCount),
      ]);
      const need = parseWord(total);
      return {
        textHash: parseBytes32(textHash),
        summaryHash: parseBytes32(summaryHash),
        textVersion: parseWord(textVersion),
        key: parseBytes32(key),
        closed: parseFlag(closed),
        closeAt: parseWord(closeAt),
        funded: need > 0n && parseWord(funding) === need,
        entryCount: parseWord(entryCount),
      };
    },
  });
}

export interface ClaimLine {
  leafMatches: boolean;
  entry: ClaimEntry;
  due: bigint;
}

/** The one line the link names: whether its data matches the stored leaf, its state and what is due. */
export function useClaimLine(
  place: EarlierPlace | null,
  link: ClaimLink | null,
) {
  const wallet = useWallet();
  return useQuery({
    queryKey: [
      "team",
      "earlier",
      "line",
      place?.chainId,
      place?.claim,
      link ? String(link.entry) : "",
    ],
    enabled: investingOn() && Boolean(place && link) && wallet.isAvailable(),
    staleTime: 10_000,
    queryFn: async (): Promise<ClaimLine> => {
      if (!place || !link) throw new Error("No line.");
      const [stored, entry, due] = await Promise.all([
        wallet.readCall(place.claim, CLAIM_READS.leaf(link.entry)),
        wallet.readCall(place.claim, CLAIM_READS.entryOf(link.entry)),
        wallet.readCall(place.claim, CLAIM_READS.due(link.entry)),
      ]);
      return {
        leafMatches:
          parseBytes32(stored) ===
          leafOf(link.entry, link.holder, link.amount, link.salt),
        entry: parseEntry(entry),
        due: parseWord(due),
      };
    },
  });
}

/** The agreement as the site publishes it; shown only when its fingerprints are the contract's. */
export interface PublishedText {
  version: number;
  text: string;
  summary: string;
}

export type TextState =
  | { kind: "checking" }
  | { kind: "missing" }
  | { kind: "moved" }
  | { kind: "ok"; text: string; summary: string };

const TEXT_PATH = "/earlier-text.json";

function publishedText(value: unknown): PublishedText | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.text !== "string" || typeof v.summary !== "string") return null;
  return { version: Number(v.version), text: v.text, summary: v.summary };
}

/**
 * The agreement text and one-line summary, from the site's own files. They are believed only when their fingerprints are
 * the ones the contract holds now: a text that does not match is never shown as the agreement.
 */
export function useAgreementText(list: ClaimList | undefined) {
  const fetched = useQuery({
    queryKey: ["team", "earlier", "text"],
    enabled: investingOn() && Boolean(list),
    staleTime: 60_000,
    retry: false,
    queryFn: async (): Promise<PublishedText | null> => {
      const response = await fetch(TEXT_PATH, {
        headers: { accept: "application/json" },
      });
      if (!response.ok) return null;
      try {
        return publishedText(await response.json());
      } catch {
        return null;
      }
    },
  });
  if (!list || fetched.isPending) return { kind: "checking" } as TextState;
  const text = fetched.data;
  if (!text) return { kind: "missing" } as TextState;
  if (
    fingerprintOf(text.text) !== list.textHash ||
    fingerprintOf(text.summary) !== list.summaryHash ||
    BigInt(text.version) !== list.textVersion
  )
    return { kind: "moved" } as TextState;
  return { kind: "ok", text: text.text, summary: text.summary } as TextState;
}
