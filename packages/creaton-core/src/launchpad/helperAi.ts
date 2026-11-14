/**
 * Two AI helpers for contributors (`docs/v3-review/CHECK-AND-NEWCOMER-PLAN.md`, step 3), offered only when the server's
 * AI service is on:
 *
 * - **Checking work before it is submitted:** the evidence and the person's own check, compared with the work area's
 *   "done when", as a list of what looks missing or unclear. Shown only to the person submitting; never published (the
 *   words do go to the server's AI service, `AI_DISCLOSURE`).
 * - **The newcomer interviewer:** three short answers (what they are good at, how much time they have, what they care
 *   about here) turned into a first "taking this on" draft for them to edit.
 *
 * The AI sees only what is given here, adds nothing, judges no one and decides nothing. It cannot open links: it is told
 * so, and says so. Pure: prompts out, readings in, driven by `helperAi.test.mjs`.
 */

const ITEM_MAX = 280;
const DELIVER_MAX = 280;
const FOR_MAX = 140;
const MAX_DAYS = 90;

const RULES = [
  "You help someone working on a small open project. Work only from what you are given; never add facts, people or results.",
  "Do not judge the person or their effort. You decide nothing: they do.",
  "Use plain words, no jargon, no hype.",
];

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

/**
 * Said beside every AI helper: what is typed goes to the AI service the server's operator configured, an outside
 * company. "Not published" alone would hide that.
 */
export const AI_DISCLOSURE =
  "What you type here is sent to this server's AI service.";

/**
 * Fences one AI request against what the person does while it runs (CLAUDE.md, review-proven rule 2). `inputs` reads,
 * as they are now, the words the request was written from; `open` says whether the form that asked is still there. The
 * returned check is true only while both hold: an answer written from words that have since changed, or for a form that
 * was cancelled, is dropped instead of overwriting newer edits or reopening the form.
 */
export function fenceAiRequest(
  inputs: () => unknown,
  open: () => boolean,
): () => boolean {
  const asked = JSON.stringify(inputs());
  return () => open() && JSON.stringify(inputs()) === asked;
}

// ---- checking work against its "done when" ---------------------------------------------------

export function workCheckPrompt(input: {
  doneWhen: string;
  evidence: string;
  met: string;
  notMet: string;
}): { system: string; user: string } {
  return {
    system: [
      ...RULES,
      "Compare the work as described with the words it will be judged against, and list what looks missing or unclear, so the person can fix it before reviewers see it.",
      "You cannot open links. If the evidence is only a link, say that you could not see the work itself and what the description should say.",
      `At most five items, each under ${ITEM_MAX} characters. An empty list means nothing looks missing.`,
      'Reply with JSON only: {"gaps": string[]}.',
    ].join("\n"),
    user: [
      `It will be judged against: ${input.doneWhen.trim() || "(no words given)"}`,
      `The work, as they describe it: ${input.evidence.trim() || "(nothing yet)"}`,
      `How they checked it: ${input.met.trim() || "(not said)"}`,
      `What they say it does not meet yet: ${input.notMet.trim() || "(nothing)"}`,
    ].join("\n"),
  };
}

/**
 * The list out of a reply (at most five, each gap once), or null when it is not the JSON asked for. An entry that is not
 * a non-blank string rejects the whole reply rather than being dropped: an empty list says "nothing looks missing", so
 * it must come only from a reply that said so, never from one whose findings could not be read.
 */
export function parseWorkCheck(reply: string): string[] | null {
  const body = json(reply);
  if (!body || !Array.isArray(body.gaps)) return null;
  const gaps: string[] = [];
  for (const g of body.gaps) {
    if (typeof g !== "string" || !g.trim()) return null;
    const gap = g.trim().slice(0, ITEM_MAX);
    if (!gaps.includes(gap)) gaps.push(gap);
  }
  return gaps.slice(0, 5);
}

// ---- the newcomer interviewer ----------------------------------------------------------------

/** The interviewer's three questions, asked one at a time. */
export const INTERVIEW_QUESTIONS = [
  { key: "good", label: "What are you good at, or want to get better at?" },
  {
    key: "time",
    label: "How much time do you have for this in the next week or two?",
  },
  { key: "care", label: "What in this work area do you care about?" },
] as const;

export type InterviewAnswers = Record<
  (typeof INTERVIEW_QUESTIONS)[number]["key"],
  string
>;

export function takeOnDraftPrompt(input: {
  area: string;
  doneWhen: string | null;
  answers: InterviewAnswers;
}): { system: string; user: string } {
  return {
    system: [
      ...RULES,
      "Draft what this person will take on first in this work area: one small, specific piece they can finish in their time, that moves the work area towards its words.",
      `"deliver" under ${DELIVER_MAX} characters, "for" (who will use it) under ${FOR_MAX}, "days" a whole number from 1 to ${MAX_DAYS} that fits the time they said.`,
      'Reply with JSON only: {"deliver": string, "for": string, "days": number}.',
    ].join("\n"),
    user: [
      `Work area: ${input.area}`,
      `Done when: ${input.doneWhen?.trim() || "(its words are not published)"}`,
      ...INTERVIEW_QUESTIONS.map(
        (q) => `${q.label} ${input.answers[q.key].trim() || "(no answer)"}`,
      ),
    ].join("\n"),
  };
}

/** The draft out of a reply, or null when it is not the JSON asked for (days kept within 1 to 90). */
export function parseTakeOnDraft(
  reply: string,
): { deliver: string; for: string; days: number } | null {
  const body = json(reply);
  if (!body) return null;
  const { deliver, days } = body;
  const forWhom = body.for;
  if (
    typeof deliver !== "string" ||
    !deliver.trim() ||
    typeof forWhom !== "string" ||
    !forWhom.trim() ||
    typeof days !== "number" ||
    !Number.isFinite(days)
  )
    return null;
  return {
    deliver: deliver.trim().slice(0, DELIVER_MAX),
    for: forWhom.trim().slice(0, FOR_MAX),
    days: Math.min(MAX_DAYS, Math.max(1, Math.round(days))),
  };
}
