/**
 * The AI draft for a check note (`docs/v3-review/CHECK-NOTE-PLAN.md`, step 4): from the note as the founder has it so
 * far, a short summary and one challenging question per Now item. Both are drafts: the summary must be accepted or
 * edited before the note can go out, and the questions are only shown, never published. The AI decides nothing.
 *
 * It works only from the facts given here (the project's aim and the note), says nothing it was not told, names no one
 * and ranks no one. The words go to the server's AI service (the relay's `/llm` gateway), so the form says so. Pure: a
 * prompt out, a reading of the reply in, driven by `checkNoteAi.test.mjs`.
 */

import type { CheckNote } from "./checkNote.ts";

const SUMMARY_MAX = 600;
const QUESTION_MAX = 280;

const SYSTEM = [
  "You help the founder of a small open project write a short check note: what the team expected, what happened, and what to keep or change next.",
  "Work only from the facts you are given. Never add numbers, people, events or results that are not in them. If something is unknown, say so.",
  'Never say something was finished, shipped or done unless the facts say so: an expectation answered "partly" or "not yet" was not met, and a priority is not finished because work in it was.',
  "Do not name or rank individuals, and do not judge anyone's effort. Most problems come from how work is set up, not from the people doing it.",
  "Separate the supplied observations from explanations and suggestions. A verdict without an observation is not evidence; say what is still unknown. Agreement between AI replies is not independent evidence.",
  "Keeping the current method or gathering more evidence is a valid choice. Do not invent a process change to complete the note. One slow period or a few turn-down counts do not establish a trend, a cause or a person's performance; do not invent normal ranges or statistical signals. A confirmed defect or safety problem still needs prompt action.",
  "Use plain words, no jargon, no hype.",
  'Reply with JSON only: {"summary": string, "questions": string[]}.',
  `"summary": at most three sentences (under ${SUMMARY_MAX} characters) saying what was observed against what was expected and what the founder chose to keep, change or investigate next.`,
  `"questions": exactly one question per priority, in the same order, each under ${QUESTION_MAX} characters, that challenges whether the item is still worth doing or what it assumes (for example: what would have to be true for this to work, what argues against keeping it, what else could be done instead).`,
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
  lines.push("Priorities:");
  note.items.forEach((item, i) => {
    const expected = item.expected
      ? ` Expected: ${item.expected}. Happened: ${item.happened ?? "not answered yet"}.`
      : " No expectation was set.";
    const seen = item.why.trim()
      ? ` What the founder saw: ${item.why.trim()}.`
      : item.expected && item.happened !== null && item.happened !== "not-yet"
        ? " Observation supporting the verdict: (not provided; the outcome is not established here)."
        : "";
    const next = item.next ? ` The founder's choice: ${item.next}.` : "";
    lines.push(`${i + 1}. ${item.text}.${expected}${seen}${next}`);
  });
  lines.push(
    `Finished since the last note: ${note.finished.length ? note.finished.map((c) => c.title).join(", ") : "nothing"}.`,
  );
  lines.push(
    `Turned down since the last note: ${note.turnedDown.length}${note.causes.length ? ` (reasons reported, not proven causes or trends: ${note.causes.map((c) => `${c.label}, ${c.count}`).join("; ")})` : ""}.`,
  );
  // The count of "taking this on" dates that passed is left out: it counts work finished on time too, so given to the AI
  // it would read as work that never came in.
  if (note.stuck.trim()) lines.push(`Stuck: ${note.stuck.trim()}`);
  if (note.change.trim())
    lines.push(
      `How the founder plans to work next (keep, change or investigate): ${note.change.trim()}`,
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

/**
 * The draft's summary on the note as it is now, or null when the founder changed the note while the AI was writing
 * (`asked` is the note the prompt was made from). Then the summary was written from facts that are no longer the
 * note's, and adding it would also be the only way to keep or lose those newer edits: it is set aside instead.
 */
export function acceptCheckDraft(
  asked: CheckNote,
  current: CheckNote,
  summary: string,
): CheckNote | null {
  return JSON.stringify(asked) === JSON.stringify(current)
    ? { ...current, summary }
    : null;
}
