/**
 * Why joining from an invite did not work, in words people can act on. The server's refusals are short codes
 * (`invite_expired`, `join_policy_required`, …) and its request limits are sentences of its own; anything this page
 * does not know is said plainly, with the server's own words kept for whoever helps (Technical details).
 *
 * Alias-free: `invite-errors.test.mjs` drives it under `node --test`.
 */

import { requestLimitText } from "../../shared/lib/refusal-text.ts";

/** A refused invite request, with the status the server answered and its own reason. */
export class InviteRequestError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "InviteRequestError";
    this.status = status;
  }
}

export interface InviteProblem {
  /** What happened and what to do next. */
  text: string;
  /** The server's or browser's own words, for the collapsed Technical details; null when the text says it all. */
  detail: string | null;
  /** The terms on this page are out of date (or their agreement ran out): load them again and ask for new ticks. */
  reloadTerms: boolean;
}

const TERMS_CHANGED = "The terms changed. Read them and tick the box again.";

function plain(text: string, reloadTerms = false): InviteProblem {
  return { text, detail: null, reloadTerms };
}

/** Joining did not work: what to say, and whether the terms must be loaded again. */
export function inviteProblem(error: unknown): InviteProblem {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const status = error instanceof InviteRequestError ? error.status : null;
  const name =
    error && typeof error === "object" && "name" in error
      ? String((error as { name?: unknown }).name)
      : "";

  if (message.includes("invite_exhausted")) {
    return plain(
      "This invite has reached its use limit. Ask for a new invite.",
    );
  }
  if (message.includes("invite_expired")) {
    return plain("This invite has expired. Ask for a new invite.");
  }
  if (message.includes("invite_invalid")) {
    return plain(
      "This invite is invalid. Check the link or ask for a new invite.",
    );
  }
  // Agreeing to the terms gave a version the server no longer has (`join_policy_not_accepted`, a 400), or the
  // agreement did not reach the claim, or ran out on the way (`join_policy_required`).
  if (message.includes("join_policy_not_accepted")) {
    return plain(TERMS_CHANGED, true);
  }
  // The terms were taken down since this page loaded them.
  if (message.includes("join_policy_not_configured")) {
    return plain(
      "This server's terms changed. Look over the page again, then join.",
      true,
    );
  }
  if (message.includes("join_policy_required")) {
    return plain(
      "This server needs you to agree to its terms before you join. Read them, tick the box again and try again.",
      true,
    );
  }
  const limited = requestLimitText(message);
  if (limited !== null) return plain(limited);
  if (status === 429 || /too many invite claim attempts/i.test(message)) {
    return plain(
      "You've tried to join several times in a row. Wait a minute, then try again.",
    );
  }
  if (name === "TimeoutError") {
    return {
      text: "The server didn't answer in time. Check your connection and try again.",
      detail: message || null,
      reloadTerms: false,
    };
  }
  if (name === "TypeError") {
    return {
      text: "Couldn't reach the server. Check your connection and try again.",
      detail: message || null,
      reloadTerms: false,
    };
  }
  return {
    text: "Couldn't join with this invite. Try again in a moment, or ask the person who sent it for a new one.",
    detail: message || (status !== null ? `HTTP ${status}` : null),
    reloadTerms: false,
  };
}
