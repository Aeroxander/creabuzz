/**
 * What a project page says when its read failed: the one refusal that has a different next step (an invite-only server
 * turning away someone who is not on its list, often a person who followed a shared link and has no account) is told
 * in plain words with who to ask; every other failure keeps "Try again". The server stays the authority: this only
 * words what it said, it never opens a read.
 *
 * Pure and alias-free: `refusal-copy.test.mjs` drives it under `node --test`.
 */

import { relayMessageOf } from "../../../shared/lib/relay-failure.ts";
import {
  INVITE_ONLY_TEXT,
  restrictionText,
} from "../../../shared/lib/refusal-text.ts";

/** Who to ask when the server is invite-only: the person whose link brought the reader here. */
export const ASK_FOR_INVITE_TEXT =
  "No invite yet? Ask the person who sent you this link for one.";

/** The line before "Sign in" for someone who may already be on the server's list. */
export const ALREADY_MEMBER_TEXT = "Already on this server? Sign in.";

/**
 * Said with a project's public record, to someone the server does not let in. Some invite-only servers let anyone
 * read a project's record (its goal, updates, promises and accepted work); everything else is for people on the list.
 */
export const PUBLIC_RECORD_TEXT =
  "Anyone can read this project's record. To follow it, help or post, you need an invite.";

/**
 * Said when the server does let anyone read a project's record but could not answer this time: too many people are
 * reading at once, or it took too long. It is not "you need an invite": the reader is asked to try again.
 */
export const PUBLIC_RECORD_BUSY_TITLE =
  "This project's record can't be opened right now.";
export const PUBLIC_RECORD_BUSY_TEXT =
  "The server is busy. Try again in a minute.";

/**
 * What the read of a project's public record ended as, when it failed. "closed": the server turned the reader away
 * as someone who is not on its list, so it shows no public record and the invite sentence is the truth. "busy": it
 * answered anything else (a limit reached, a read that took too long) or did not answer, so asking for an invite
 * would send the reader the wrong way.
 */
export function publicRecordFailure(error: unknown): "closed" | "busy" {
  return isInviteOnlyRefusal(error) ? "closed" : "busy";
}

/** What the page says when it failed for any other reason. */
export const COULDNT_OPEN_TEXT = "Couldn't open this project.";

/** What the page says when the server is invite-only. */
export const NEEDS_INVITE_TITLE = "You need an invite to open this project.";

export type ProjectLoadFailure =
  | {
      kind: "invite-only";
      title: string;
      /** The sentences under the title, in order. */
      lines: string[];
      /** Sign in is the main action: only for someone who has not signed in on this browser. */
      signIn: boolean;
      retry: false;
    }
  | {
      kind: "other";
      title: string;
      lines: string[];
      signIn: false;
      retry: true;
    };

/** True when the server refused this read because the reader is not on an invite-only server's list. */
export function isInviteOnlyRefusal(error: unknown): boolean {
  const said = relayMessageOf(error);
  return said !== null && restrictionText(said) === INVITE_ONLY_TEXT;
}

/** The words, and the actions, for a project read that failed. `signedIn` is whether this browser has an account. */
export function projectLoadFailure(
  error: unknown,
  signedIn: boolean,
): ProjectLoadFailure {
  if (!isInviteOnlyRefusal(error))
    return {
      kind: "other",
      title: COULDNT_OPEN_TEXT,
      lines: [],
      signIn: false,
      retry: true,
    };
  return {
    kind: "invite-only",
    title: NEEDS_INVITE_TITLE,
    lines: signedIn
      ? [INVITE_ONLY_TEXT, ASK_FOR_INVITE_TEXT]
      : [INVITE_ONLY_TEXT, ASK_FOR_INVITE_TEXT, ALREADY_MEMBER_TEXT],
    signIn: !signedIn,
    retry: false,
  };
}
