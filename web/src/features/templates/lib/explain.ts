/**
 * What to tell a person when the server turns a step of a template down.
 * Alias-free; `explain.test.mjs` drives it under `node --test`.
 */

import type { PlanStep } from "@creaton/core/templates/apply.ts";

import {
  errorMessage,
  failureWords,
  plainErrorText,
} from "../../../shared/lib/readable-error.ts";

/**
 * A refusal in words a person can act on. The server speaks in short codes
 * ("restricted: …"); a person needs to know what to do next, and that what
 * already went through is kept.
 */
export function explainStepFailure(step: PlanStep, error: unknown): string {
  const text = error == null ? "" : errorMessage(error).trim();
  const kept =
    " Whatever already went through is kept, so trying again picks up where this stopped.";
  // A ban, a timeout, an invite-only server or the request limit have their own plain words.
  const plain = plainErrorText(error);
  if (plain !== null) return `${plain}${kept}`;
  if (/rate|too many/i.test(text)) {
    return `The server asked us to slow down. Wait a moment, then try again.${kept}`;
  }
  if (
    text.startsWith("restricted") ||
    /not (a )?member|permission|denied/i.test(text)
  ) {
    if (step.kind === "org") {
      return `Only this community's owner or an admin can set up the team. Ask one of them to finish setup.${kept}`;
    }
    if (step.kind === "channel") {
      return `You can't create channels here yet. Ask this community's owner to add you.${kept}`;
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
  // The server's own words when they are written for people; never its codes.
  return `${failureWords(error, "The server turned this step down.").text}${kept}`;
}
