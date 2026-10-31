/**
 * The challenge before a vote (`docs/v3-review/CHALLENGER-PLAN.md`, step 1): before someone opens a vote that commits
 * money or Shares, they answer three questions against it, and the answers are published with the vote.
 *
 * The vote's id is known before it is sent (`proposalId` on the DAO, from the same op, target, data and nonce), so the
 * challenge is published first and the vote opened after it. A challenge whose vote never opened names no vote, so it is
 * never shown: a failure at either step leaves nothing misleading. A challenge counts only when it names the wallet that
 * opened the vote and is signed by someone who bound that wallet, the check turn-down reasons make.
 *
 * Pure: a record out, a reading in, driven by `challenge.test.mjs`.
 */

import { KIND_LAUNCH_UPDATE } from "../kinds.generated.ts";

const ANSWER_MAX = 400;
/** At most this many AI follow-up questions (CHALLENGER-PLAN.md step 2). */
export const MAX_FOLLOW_UPS = 2;
const SUMMARY_MAX = 600;

/** A follow-up the AI asked, and the answer (empty when skipped). */
export interface FollowUp {
  question: string;
  answer: string;
}

/** What goes out with the vote beyond the three answers: the AI's follow-ups and the accepted summary, when used. */
export interface ChallengeExtras {
  followUps: FollowUp[];
  summary: string;
}

export const NO_EXTRAS: ChallengeExtras = { followUps: [], summary: "" };
const WORD_RE = /^0x[0-9a-f]{64}$/;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;

/** The three questions, in the order asked. */
export const CHALLENGE_QUESTIONS = [
  {
    key: "mustGoRight",
    label: "What has to go right for this to work?",
    hint: 'If the answer is "everything", say so.',
  },
  {
    key: "caseAgainst",
    label: "What is the strongest case against it?",
    hint: "The best argument someone who disagrees would make.",
  },
  {
    key: "instead",
    label: "What else could we do instead?",
    hint: 'At least one alternative, even if it is "wait".',
  },
] as const;

type ChallengeKey = (typeof CHALLENGE_QUESTIONS)[number]["key"];
/** An empty answer is a question skipped. */
export type ChallengeAnswers = Record<ChallengeKey, string>;

export const EMPTY_CHALLENGE: ChallengeAnswers = {
  mustGoRight: "",
  caseAgainst: "",
  instead: "",
};

/** The decision kinds a challenge is asked for: the ones that commit money or Shares (as `describeAction` names them). */
export const CHALLENGED_KINDS: ReadonlySet<string> = new Set([
  "work-budget",
  "project",
  "award",
  "payment",
]);

/** What is wrong with the answers as typed, or null. Skipping is allowed. */
export function challengeProblem(
  answers: ChallengeAnswers,
  extras: ChallengeExtras = NO_EXTRAS,
): string | null {
  if (
    CHALLENGE_QUESTIONS.some(
      (q) => [...answers[q.key].trim()].length > ANSWER_MAX,
    ) ||
    extras.followUps.some((f) => [...f.answer.trim()].length > ANSWER_MAX)
  )
    return `Keep each answer under ${ANSWER_MAX} characters.`;
  if ([...extras.summary.trim()].length > SUMMARY_MAX)
    return `Keep the summary under ${SUMMARY_MAX} characters.`;
  return null;
}

/** Whether anything was answered: with nothing, no record is published and the vote reads as not challenged. */
export function challengeAnswered(answers: ChallengeAnswers): boolean {
  return CHALLENGE_QUESTIONS.some((q) => answers[q.key].trim() !== "");
}

/** The launch update that publishes a challenge for the vote `decision` (its id), opened from `proposer`'s wallet. */
export function challengeContent(input: {
  decision: string;
  proposer: string;
  title: string;
  answers: ChallengeAnswers;
  extras?: ChallengeExtras;
}): Record<string, unknown> {
  const extras = input.extras ?? NO_EXTRAS;
  const problem = challengeProblem(input.answers, extras);
  if (problem) throw new Error(problem);
  const answers = Object.fromEntries(
    CHALLENGE_QUESTIONS.map((q) => [q.key, input.answers[q.key].trim()]),
  );
  return {
    title: `Before the vote: ${input.title}`,
    body: [
      ...(extras.summary.trim() ? [extras.summary.trim()] : []),
      ...CHALLENGE_QUESTIONS.map(
        (q) => `${q.label} ${input.answers[q.key].trim() || "(skipped)"}`,
      ),
      ...extras.followUps.map(
        (f) => `${f.question} ${f.answer.trim() || "(skipped)"}`,
      ),
    ].join("\n"),
    links: [],
    challenge: {
      v: 1,
      decision: input.decision.toLowerCase(),
      proposer: input.proposer.toLowerCase(),
      answers,
      ...(extras.followUps.length
        ? {
            followUps: extras.followUps
              .slice(0, MAX_FOLLOW_UPS)
              .map((f) => ({ question: f.question, answer: f.answer.trim() })),
          }
        : {}),
      ...(extras.summary.trim() ? { summary: extras.summary.trim() } : {}),
    },
  };
}

export const KIND_CHALLENGE = KIND_LAUNCH_UPDATE;

export interface Challenge {
  eventId: string;
  /** The key that signed it. */
  author: string;
  createdAt: number;
  decision: string;
  /** The wallet it says opened the vote, lower case. */
  proposer: string;
  answers: ChallengeAnswers;
  followUps: FollowUp[];
  summary: string;
}

/** A challenge out of a launch update, or null when the update is not one. */
export function parseChallenge(event: {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  content: string;
}): Challenge | null {
  if (event.kind !== KIND_CHALLENGE) return null;
  let body: unknown;
  try {
    body = JSON.parse(event.content);
  } catch {
    return null;
  }
  const raw = (body as { challenge?: unknown } | null)?.challenge as
    | Record<string, unknown>
    | undefined;
  if (
    !raw ||
    raw.v !== 1 ||
    typeof raw.decision !== "string" ||
    !WORD_RE.test(raw.decision) ||
    typeof raw.proposer !== "string" ||
    !ADDRESS_RE.test(raw.proposer) ||
    raw.answers === null ||
    typeof raw.answers !== "object"
  )
    return null;
  const given = raw.answers as Record<string, unknown>;
  const answers = { ...EMPTY_CHALLENGE };
  for (const q of CHALLENGE_QUESTIONS) {
    const value = given[q.key];
    if (typeof value === "string") answers[q.key] = value.slice(0, ANSWER_MAX);
  }
  if (!challengeAnswered(answers)) return null;
  return {
    eventId: event.id,
    author: event.pubkey,
    createdAt: event.created_at,
    decision: raw.decision,
    proposer: raw.proposer,
    answers,
    followUps: Array.isArray(raw.followUps)
      ? raw.followUps.slice(0, MAX_FOLLOW_UPS).flatMap((f) =>
          f && typeof f.question === "string" && typeof f.answer === "string"
            ? [
                {
                  question: f.question.slice(0, ANSWER_MAX),
                  answer: f.answer.slice(0, ANSWER_MAX),
                },
              ]
            : [],
        )
      : [],
    summary:
      typeof raw.summary === "string" ? raw.summary.slice(0, SUMMARY_MAX) : "",
  };
}

/**
 * The challenge to show for one vote: one naming it, naming the wallet that opened it, signed by a key that bound that
 * wallet (`bound` holds `pubkey:address` pairs, as `boundWallets` in the web app builds them). The newest wins.
 */
export function challengeFor(
  decision: { id: string; proposer: string },
  challenges: readonly Challenge[],
  bound: ReadonlySet<string>,
): Challenge | null {
  const id = decision.id.toLowerCase();
  const proposer = decision.proposer.toLowerCase();
  let best: Challenge | null = null;
  for (const c of challenges) {
    if (c.decision !== id || c.proposer !== proposer) continue;
    if (!bound.has(`${c.author}:${c.proposer}`)) continue;
    if (!best || c.createdAt > best.createdAt) best = c;
  }
  return best;
}
