/**
 * "Will it get done?" forecasts without money (N3): a person's percent that a bounty will be paid, with a short reason,
 * as a signed record (kind 47008). Each revision is a new record; the latest one made before the question's cutoff
 * counts. No money, no extra votes, no say in who is chosen.
 *
 * A question is one bounty: `forecast:<workbounty|postbounty>:<chain>:<contract>:<id>`, the same shape the server
 * checks. It settles on the bounty's own end state: paid is yes; refunds is no. Its cutoff is the earlier of the day
 * before its deadline and the moment work started to win it (a post bounty's first run; a work-area bounty's first
 * released submission), so nobody scores by forecasting what is already decided.
 *
 * Accuracy is 100 × (1 − the average Brier score): saying 50% every time scores 75, being always right and sure 100.
 */

import { KIND_FORECAST } from "../kinds.generated.ts";
import { encodeFunctionData } from "./evmAbi.ts";
import {
  decodePostBounty,
  OPEN_BOUNTY_SIGNATURES,
  type PostBountyRecord,
  postRefundsOpen,
  readPostAppeal,
  readPostCourt,
  TOPIC_POST_RUN_STARTED,
} from "./openBounty.ts";
import {
  decodeAddress,
  decodeClaim,
  decodeWord,
  encodeCall0,
  encodeCallId,
  SIGNATURES,
  topicOf,
} from "./work.ts";
import { type BountyRecord, decodeBounty } from "./workBounty.ts";
import type { WorkChain } from "./workRead.ts";

export const MAX_REASON = 500;
export const DAY = 86_400;

type QuestionKind = "workbounty" | "postbounty";

export interface Question {
  kind: QuestionKind;
  chainId: number;
  contract: string;
  id: bigint;
}

const QUESTION_RE =
  /^forecast:(workbounty|postbounty):([1-9][0-9]{0,11}):(0x[0-9a-f]{40}):([1-9][0-9]{0,19})$/;

/** The question for one bounty, in the shape the server accepts. */
export function questionOf(q: Question): string {
  return `forecast:${q.kind}:${q.chainId}:${q.contract.toLowerCase()}:${q.id}`;
}

export function parseQuestion(text: string): Question | null {
  const m = QUESTION_RE.exec(text);
  if (!m) return null;
  return {
    kind: m[1] as QuestionKind,
    chainId: Number(m[2]),
    contract: m[3],
    id: BigInt(m[4]),
  };
}

/** The record to sign for a forecast, refused before signing when the server would refuse it. */
export function forecastTemplate(
  question: string,
  percent: number,
  reason: string,
): { kind: number; tags: string[][]; content: string } {
  if (!parseQuestion(question)) throw new Error("not a bounty question");
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
    throw new Error("Give a whole percent from 0 to 100.");
  }
  const text = reason.trim();
  if (text.length === 0 || [...text].length > MAX_REASON) {
    throw new Error(`Give a reason, in at most ${MAX_REASON} characters.`);
  }
  return {
    kind: KIND_FORECAST,
    tags: [
      ["t", question],
      ["forecast", String(percent)],
    ],
    content: text,
  };
}

export interface Forecast {
  id: string;
  author: string;
  question: string;
  percent: number;
  reason: string;
  createdAt: number;
}

interface EventLike {
  id?: unknown;
  pubkey?: unknown;
  kind?: unknown;
  tags?: unknown;
  content?: unknown;
  created_at?: unknown;
}

/** A forecast record, or null for anything the server would have refused. */
export function parseForecast(event: EventLike): Forecast | null {
  if (event.kind !== KIND_FORECAST) return null;
  if (typeof event.id !== "string" || typeof event.pubkey !== "string") {
    return null;
  }
  if (typeof event.content !== "string" || typeof event.created_at !== "number")
    return null;
  const tags = Array.isArray(event.tags) ? (event.tags as unknown[]) : [];
  const questions = tags.filter(
    (t): t is string[] => Array.isArray(t) && t[0] === "t",
  );
  const percents = tags.filter(
    (t): t is string[] => Array.isArray(t) && t[0] === "forecast",
  );
  if (questions.length !== 1 || percents.length !== 1) return null;
  const question = String(questions[0][1] ?? "");
  const raw = String(percents[0][1] ?? "");
  if (!parseQuestion(question) || !/^(0|[1-9][0-9]{0,2})$/.test(raw)) {
    return null;
  }
  const percent = Number(raw);
  const reason = event.content.trim();
  if (percent > 100 || reason.length === 0 || [...reason].length > MAX_REASON) {
    return null;
  }
  return {
    id: event.id,
    author: event.pubkey,
    question,
    percent,
    reason,
    createdAt: event.created_at,
  };
}

/** Each person's latest forecast made before `cutoff` (strictly), newest first. */
export function countingForecasts(
  forecasts: readonly Forecast[],
  cutoff: number,
): Forecast[] {
  const latest = new Map<string, Forecast>();
  for (const f of forecasts) {
    if (f.createdAt >= cutoff) continue;
    const seen = latest.get(f.author);
    if (!seen || f.createdAt > seen.createdAt) latest.set(f.author, f);
  }
  return [...latest.values()].sort((a, b) => b.createdAt - a.createdAt);
}

/** The middle forecast, in whole percent (the mean of the two middle ones, rounded, for an even count); null for none. */
export function middleForecast(forecasts: readonly Forecast[]): number | null {
  if (forecasts.length === 0) return null;
  const p = forecasts.map((f) => f.percent).sort((a, b) => a - b);
  const mid = Math.floor(p.length / 2);
  return p.length % 2 === 1 ? p[mid] : Math.round((p[mid - 1] + p[mid]) / 2);
}

/** The Brier score of one forecast: 0 is perfect, 1 is sure and wrong. */
export function brier(percent: number, done: boolean): number {
  const p = percent / 100;
  const o = done ? 1 : 0;
  return (p - o) ** 2;
}

/** Accuracy over settled questions, 0 to 100 (100 × (1 − mean Brier)); null with none settled. */
export function accuracy(
  settled: readonly { percent: number; done: boolean }[],
): number | null {
  if (settled.length === 0) return null;
  const mean =
    settled.reduce((sum, s) => sum + brier(s.percent, s.done), 0) /
    settled.length;
  return Math.round(100 * (1 - mean));
}

type Outcome = "done" | "not-done" | null;

export interface QuestionState {
  /** Forecasts made at or after this time do not count. */
  cutoff: number;
  outcome: Outcome;
}

/** A post bounty's question: cut off at its first run or a day before its deadline; settled by payment or refunds. */
export function postBountyQuestion(
  record: PostBountyRecord,
  firstRunSince: number | null,
  now: number,
): QuestionState {
  const dayBefore = record.deadline - DAY;
  return {
    cutoff:
      firstRunSince === null ? dayBefore : Math.min(firstRunSince, dayBefore),
    outcome:
      record.paidClaim !== 0
        ? "done"
        : postRefundsOpen(record, now)
          ? "not-done"
          : null,
  };
}

/** A work-area bounty's question: cut off at its first released submission or a day before its deadline. */
export function workBountyQuestion(
  record: BountyRecord,
  firstReleaseAt: number | null,
  now: number,
): QuestionState {
  const dayBefore = record.deadline - DAY;
  return {
    cutoff:
      firstReleaseAt === null ? dayBefore : Math.min(firstReleaseAt, dayBefore),
    outcome:
      record.paidClaim !== null
        ? "done"
        : now >= record.refundsFrom
          ? "not-done"
          : null,
  };
}

// ---- readers ------------------------------------------------------------------------------------

export const TOPIC_RUN_STARTED = TOPIC_POST_RUN_STARTED;
export const TOPIC_CLAIM_RELEASED = topicOf(
  "ClaimReleased(bytes32,address,uint256)",
);
/** At most this many released submissions are looked at for one work area's cutoff. */
const MAX_RELEASES = 100;

const idTopic = (id: bigint) => `0x${id.toString(16).padStart(64, "0")}`;

interface LogLike {
  topics?: unknown;
  data?: unknown;
}

/** The state of a post bounty's question, read from the chain. Null for a bounty that does not exist. */
export async function readPostBountyQuestion(
  chain: WorkChain,
  contract: string,
  id: bigint,
): Promise<QuestionState | null> {
  const [hex, runs, now] = await Promise.all([
    chain.call(
      contract,
      encodeFunctionData(OPEN_BOUNTY_SIGNATURES.bounties, ["uint256"], [id]),
    ),
    chain.logs({ address: contract, topics: [TOPIC_RUN_STARTED, idTopic(id)] }),
    chain.now(),
  ]);
  const decoded = decodePostBounty(hex);
  if (!decoded) return null;
  // With a court, refunds wait for the appeal window, and an upheld appeal pays: the outcome follows the same rule.
  const court = await readPostCourt(chain, contract);
  const record = court
    ? {
        ...decoded,
        court: true,
        appeal: await readPostAppeal(chain, contract, id),
      }
    : decoded;
  const starts = runs.flatMap((raw) => {
    const log = raw as LogLike;
    return typeof log.data === "string" ? [Number(decodeWord(log.data))] : [];
  });
  return postBountyQuestion(
    record,
    starts.length > 0 ? Math.min(...starts) : null,
    now,
  );
}

/** The state of a work-area bounty's question, read from the chain. Null for a bounty that does not exist. */
export async function readWorkBountyQuestion(
  chain: WorkChain,
  contract: string,
  id: bigint,
): Promise<QuestionState | null> {
  const [hex, now] = await Promise.all([
    chain.call(
      contract,
      encodeFunctionData("bounties(uint256)", ["uint256"], [id]),
    ),
    chain.now(),
  ]);
  const record = decodeBounty(hex);
  if (!record) return null;
  const claims = decodeAddress(
    await chain.call(record.mandate, encodeCall0(SIGNATURES.mandateClaims)),
  );
  const released = (
    await chain.logs({ address: claims, topics: [TOPIC_CLAIM_RELEASED] })
  )
    .flatMap((raw) => {
      const t = (raw as LogLike).topics;
      return Array.isArray(t) && typeof t[1] === "string" ? [t[1]] : [];
    })
    .slice(-MAX_RELEASES);
  const times = await Promise.all(
    released.map(async (claimId) => {
      const [project, claim] = await Promise.all([
        chain.call(
          record.mandate,
          encodeCallId(SIGNATURES.claimProject, claimId),
        ),
        chain.call(claims, encodeCallId(SIGNATURES.claim, claimId)),
      ]);
      const r = decodeClaim(claim);
      const bound = `0x${decodeWord(project).toString(16).padStart(64, "0")}`;
      return r &&
        bound.toLowerCase() === record.projectId.toLowerCase() &&
        r.releasedAt >= record.openedAt
        ? [r.releasedAt]
        : [];
    }),
  );
  const first = times.flat();
  return workBountyQuestion(
    record,
    first.length > 0 ? Math.min(...first) : null,
    now,
  );
}
