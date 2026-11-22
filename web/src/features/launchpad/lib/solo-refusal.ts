/**
 * When the server refuses the founder's own check for a reason no second try can change: someone else is on the
 * project now, or the account is an agent. Said once in plain words, with no "Try again" beside it.
 *
 * The server's two refusals (`OWN_WORK` and `AGENT_LIMIT` in `launch_update_authority.rs`) are matched as text, the
 * same way `shared/lib/refusal-text.ts` matches the others.
 *
 * Pure and alias-free: `solo-refusal.test.mjs` drives it under `node --test`.
 */

export type CheckRefusal = "own-work" | "agent";

const OWN_WORK =
  /^restricted: a task's work must be confirmed by someone other than its helper$/;
const AGENT_LIMIT =
  /^restricted: an agent account cannot check work, grant more time, sign goals and promises, or stand for a seat; a person must$/;

/** What a failed check was refused for, or null when it was refused for something else (or not refused). */
export function checkRefusalOf(error: unknown): CheckRefusal | null {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  const text = message.trim();
  if (OWN_WORK.test(text)) return "own-work";
  if (AGENT_LIMIT.test(text)) return "agent";
  return null;
}

/** Said when someone else is on the project: they check the work now, and a second try cannot change that. */
export const SOMEONE_ELSE_CHECKS =
  "Someone else is on this project now, so they need to check this work. Ask them to open the task and check it.";
