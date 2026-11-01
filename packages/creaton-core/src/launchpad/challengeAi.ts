/**
 * The AI's part in the challenge before a vote (`docs/v3-review/CHALLENGER-PLAN.md`, step 2): after the three
 * questions, up to two follow-ups that press on the weakest answer, then a three-line summary the person opening the
 * vote must accept or edit. The AI sees only what is given here, adds nothing, names and ranks no one, and decides
 * nothing. Pure: prompts out, readings in, driven by `challengeAi.test.mjs`.
 */

import {
  CHALLENGE_QUESTIONS,
  type ChallengeAnswers,
  type FollowUp,
  MAX_FOLLOW_UPS,
} from "./challenge.ts";

const QUESTION_MAX = 280;
const SUMMARY_MAX = 600;

/** What the AI is told about the vote and the project. */
export interface ChallengeContext {
  /** The kind of vote in words ("Award Shares for reviewed work"). */
  kind: string;
  aim: string;
  now: readonly string[];
  /** The latest check note's "what changed" and "what we change", when there is one. */
  lastCheck: { outside: string; change: string } | null;
}

const RULES = [
  "You help someone who is about to open a vote in a small open project think it through before they do.",
  "Work only from the facts you are given. Never add numbers, people, events or results that are not in them.",
  "Do not name or rank individuals and do not judge anyone's effort. You decide nothing: the person does.",
  "Use plain words, no jargon, no hype.",
];

function facts(
  context: ChallengeContext,
  answers: ChallengeAnswers,
  followUps: readonly FollowUp[],
): string {
  const lines = [
    `The vote: ${context.kind}.`,
    `The project's aim: ${context.aim.trim() || "(not set)"}`,
    `The team's priorities: ${context.now.length ? context.now.join("; ") : "(not set)"}`,
    context.lastCheck
      ? `The latest check note: what changed: ${context.lastCheck.outside}; what the team changes: ${context.lastCheck.change}`
      : "There is no check note yet.",
    "Their answers:",
    ...CHALLENGE_QUESTIONS.map(
      (q) => `- ${q.label} ${answers[q.key].trim() || "(skipped)"}`,
    ),
    ...followUps.map(
      (f) => `- ${f.question} ${f.answer.trim() || "(skipped)"}`,
    ),
  ];
  return lines.join("\n");
}

/** The messages asking for follow-up questions. */
export function followUpPrompt(
  context: ChallengeContext,
  answers: ChallengeAnswers,
): { system: string; user: string } {
  return {
    system: [
      ...RULES,
      `Ask at most ${MAX_FOLLOW_UPS} follow-up questions that press on the weakest or emptiest answer: what it assumes, what would have to be true, what was skipped. Each under ${QUESTION_MAX} characters.`,
      'Reply with JSON only: {"followUps": string[]}.',
    ].join("\n"),
    user: facts(context, answers, []),
  };
}

/** The messages asking for the three-line summary, once the follow-ups are answered or skipped. */
export function challengeSummaryPrompt(
  context: ChallengeContext,
  answers: ChallengeAnswers,
  followUps: readonly FollowUp[],
): { system: string; user: string } {
  return {
    system: [
      ...RULES,
      `Write a three-line summary of this challenge, under ${SUMMARY_MAX} characters: exactly three sentences, one each for what has to go right, the strongest case against, and the alternative. Say plainly where an answer was skipped. Give no advice and no verdict.`,
      'Reply with JSON only: {"summary": string}.',
    ].join("\n"),
    user: facts(context, answers, followUps),
  };
}

function json(reply: string): Record<string, unknown> | null {
  const text = reply
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The follow-up questions out of a reply (at most two, non-empty), or null when it is not the JSON asked for. */
export function parseFollowUps(reply: string): string[] | null {
  const body = json(reply);
  if (!body || !Array.isArray(body.followUps)) return null;
  return body.followUps
    .flatMap((q) =>
      typeof q === "string" && q.trim()
        ? [q.trim().slice(0, QUESTION_MAX)]
        : [],
    )
    .slice(0, MAX_FOLLOW_UPS);
}

/** The summary out of a reply, or null when it is not the JSON asked for. */
export function parseChallengeSummary(reply: string): string | null {
  const body = json(reply);
  return body && typeof body.summary === "string" && body.summary.trim()
    ? body.summary.trim().slice(0, SUMMARY_MAX)
    : null;
}
