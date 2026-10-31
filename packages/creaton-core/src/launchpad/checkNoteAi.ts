/**
 * The AI draft for a check note (`docs/v3-review/CHECK-NOTE-PLAN.md`, step 4): from the note as the founder has it so
 * far, a short summary and one challenging question per Now item. Both are drafts: the summary must be accepted or
 * edited before the note can go out, and the questions are only shown, never published. The AI decides nothing.
 *
 * It works only from the facts given here (the project's aim and the note), says nothing it was not told, names no one
 * and ranks no one. Pure: a prompt out, a reading of the reply in, driven by `checkNoteAi.test.mjs`.
 */

import type { CheckNote } from "./checkNote.ts";

const SUMMARY_MAX = 600;
const QUESTION_MAX = 280;

const SYSTEM = [
  "You help the founder of a small open project write a short check note: what the team expected, what happened, and what changes next.",
  "Work only from the facts you are given. Never add numbers, people, events or results that are not in them. If something is unknown, say so.",
  "Do not name or rank individuals, and do not judge anyone's effort. Most problems come from how work is set up, not from the people doing it.",
  "Use plain words, no jargon, no hype.",
  'Reply with JSON only: {"summary": string, "questions": string[]}.',
  `"summary": at most three sentences (under ${SUMMARY_MAX} characters) saying what happened against what was expected and what the team changes next.`,
  `"questions": exactly one question per Now item, in the same order, each under ${QUESTION_MAX} characters, that challenges whether the item is still worth doing or what it assumes (for example: what would have to be true for this to work, what argues against keeping it, what else could be done instead).`,
].join("\n");

/** The messages for the AI service: the rules, and the facts as text. */
export function checkDraftPrompt(
  note: CheckNote,
  aim: string,
): { system: string; user: string } {
  const lines: string[] = [];
  lines.push(`Aim: ${aim.trim() || "(not set)"}`);
  lines.push(
    `What changed for the people the project is for: ${note.outside.trim() || "(the founder has not said yet)"}`,
  );
  lines.push("Now items:");
  note.items.forEach((item, i) => {
    const expected = item.expected
      ? ` Expected: ${item.expected}. Happened: ${item.happened ?? "not answered yet"}.`
      : " No expectation was set.";
    const seen = item.why.trim()
      ? ` What the founder saw: ${item.why.trim()}.`
      : "";
    const next = item.next ? ` The founder's choice: ${item.next}.` : "";
    lines.push(`${i + 1}. ${item.text}.${expected}${seen}${next}`);
  });
  lines.push(
    `Finished since the last note: ${note.finished.length ? note.finished.map((c) => c.title).join(", ") : "nothing"}.`,
  );
  lines.push(
    `Turned down since the last note: ${note.turnedDown.length}${note.causes.length ? ` (what was missing: ${note.causes.map((c) => `${c.label}, ${c.count}`).join("; ")})` : ""}.`,
  );
  lines.push(
    `"Taking this on" dates that passed without the work: ${note.lapsed}.`,
  );
  if (note.stuck.trim()) lines.push(`Stuck: ${note.stuck.trim()}`);
  if (note.change.trim())
    lines.push(
      `What the founder plans to change in how the team works: ${note.change.trim()}`,
    );
  return { system: SYSTEM, user: lines.join("\n") };
}

/**
 * The reply read back: a summary (cut to its limit) and one question per item, or null when it is not the JSON asked
 * for. A reply wrapped in a code fence is read too; anything else is refused rather than guessed at.
 */
export function parseCheckDraft(
  reply: string,
  itemCount: number,
): { summary: string; questions: string[] } | null {
  const text = reply
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  const { summary, questions } = value as {
    summary?: unknown;
    questions?: unknown;
  };
  if (typeof summary !== "string" || summary.trim() === "") return null;
  if (!Array.isArray(questions)) return null;
  const asked = questions
    .slice(0, itemCount)
    .map((q) => (typeof q === "string" ? q.trim().slice(0, QUESTION_MAX) : ""));
  while (asked.length < itemCount) asked.push("");
  return { summary: summary.trim().slice(0, SUMMARY_MAX), questions: asked };
}
