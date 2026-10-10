/**
 * What to tell a person when the server turns a step of a template down.
 * Alias-free; `explain.test.mjs` drives it under `node --test`.
 */

import type { PlanStep } from "@creaton/core/templates/apply.ts";

/** The reason a refused write carries, or the text of whatever was thrown. */
export function refusalText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error ?? "");
  return text.trim();
}

/**
 * A refusal in words a person can act on. The server speaks in short codes
 * ("restricted: …"); a person needs to know what to do next, and that what
 * already went through is kept.
 */
export function explainStepFailure(step: PlanStep, error: unknown): string {
  const text = refusalText(error);
  const kept =
    " Whatever already went through is kept, so trying again picks up where this stopped.";
  if (/rate|too many/i.test(text)) {
    return `The server asked us to slow down. Wait a moment, then try again.${kept}`;
  }
  if (
    text.startsWith("restricted") ||
    /not (a )?member|permission|denied/i.test(text)
  ) {
    if (step.kind === "org") {
      return `Only this community's owner or an admin can set up the team. Ask one of them, or start the project in a community you run.${kept}`;
    }
    if (step.kind === "channel") {
      return `You can't create channels here yet. Ask this community's owner to add you, or start the project in a community you run.${kept}`;
    }
    return `You don't have permission to do that here. Ask this community's owner.${kept}`;
  }
  if (text === "") {
    return `The server did not answer. Check the connection, then try again.${kept}`;
  }
  if (
    /timed out|connection|failed to fetch|network|closed before/i.test(text)
  ) {
    return `The connection dropped. Check it, then try again.${kept}`;
  }
  return `The server said no: ${text}.${kept}`;
}
