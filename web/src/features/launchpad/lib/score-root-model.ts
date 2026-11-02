/**
 * The score-root record's shape and its strict parser, split out of
 * `models.ts` so both stay under the file-size gate. Alias-free with `.ts`
 * specifiers, so `node --test` drives it like its neighbours.
 */

import type { NostrEvent } from "@/shared/lib/nostr-client";
import { KIND_SCORE_ROOT } from "../../../shared/constants/kinds.ts";
import { contentObject, int, str, tagValue } from "./nostr-fields.ts";

export interface ScoreRoot {
  /**
   * The signed record's **event id** — one publisher's signature, so two
   * publishers' records for the same `program:epoch` never share an id
   * (selection, cache keys and proofs reads always answer for exactly the
   * record chosen). The replaceable coordinate it carries separately.
   */
  id: string;
  /** The record's `d` tag: `program:epoch`, validated against the content. */
  coordinate: string;
  author: string;
  createdAt: number;
  program: string;
  root: string;
  epoch: string;
  /** The proofs pointer as the record carries it (unfiltered, for transparency). */
  indexerUrl: string | null;
  /** The proofs pointer this app may actually follow; null when it may not. */
  proofUrl: string | null;
  anchorBlock: number | null;
  /**
   * Whether the record's publisher is one this community has accepted
   * (`lib/score-root-policy.ts`). A `publisher-claim` is never shown as the
   * community's reputation — only as what that publisher signed.
   */
  standing: "accepted" | "publisher-claim";
}

/**
 * Parse a score-root record (kind 37006, d = program:epoch).
 *
 * Callers verify a record's signature first (`lib/score-root-policy.ts`
 * `verifySignedEvent` — the read surface does not check signatures itself);
 * this parser parses whatever it is given without crash or invention, and the
 * classifying layer decisions rest on the verified keys, not on the fields.
 * A trustgraph operator publishes the proven Merkle root of a community's
 * scores each epoch; clients verify individual score claims against it with
 * `lib/trust-score.ts` (no prover needed). Malformed records are refused
 * rather than shown as authoritative — including one whose `d` tag does not
 * name the program and epoch its own content says: a record that cannot keep
 * itself together proves nothing about the tree it claims.
 */
export function parseScoreRoot(event: NostrEvent): ScoreRoot | null {
  if (event.kind !== KIND_SCORE_ROOT) return null;
  if (typeof event.id !== "string" || event.id.length === 0) return null;
  const coordinate = tagValue(event, "d");
  if (!coordinate) return null;
  const body = contentObject(event);
  const program = str(body.program);
  const root = str(body.root);
  const epoch = str(body.epoch);
  if (!program || !root || !/^0x[0-9a-fA-F]{64}$/.test(root)) return null;
  if (!epoch || coordinate !== `${program}:${epoch}`) return null;
  return {
    // The signature marks this exact record; the coordinate does not. An id
    // that is only the coordinate would let two publishers' records share a
    // selection, a cache slot and a proofs answer.
    id: event.id,
    coordinate,
    author: event.pubkey,
    createdAt: event.created_at,
    program,
    root,
    epoch,
    indexerUrl: str(body.indexerUrl),
    proofUrl: null,
    anchorBlock: int(body.anchorBlock),
    standing: "publisher-claim",
  };
}
