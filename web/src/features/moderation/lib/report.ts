/**
 * Telling a community's moderators about a message, a post or a person.
 *
 * A report is a signal and nothing more: it goes to the moderators' queue and nowhere else (it is not shown to anyone
 * else, and nothing is removed because of it). The server checks that the target exists in this community and takes
 * exactly one of the types below. Wording here is for the person reporting, so it says what they saw, not what a
 * protocol calls it.
 *
 * Alias-free for `node --test`.
 */

/** The record kind for a report (NIP-56). */
export const KIND_REPORT = 1984;

/** Longest note the dialog accepts. The server stores what it is given, so the page keeps it short. */
export const MAX_NOTE_LENGTH = 500;

export type ReportType =
  | "spam"
  | "impersonation"
  | "profanity"
  | "nudity"
  | "illegal"
  | "malware"
  | "other";

export const REPORT_REASONS: readonly {
  value: ReportType;
  label: string;
  hint: string;
}[] = [
  {
    value: "spam",
    label: "Spam or a scam",
    hint: "Unwanted ads, repeated posts, or an attempt to take money.",
  },
  {
    value: "impersonation",
    label: "Pretending to be someone else",
    hint: "Using another person's or project's name to mislead.",
  },
  {
    value: "profanity",
    label: "Abuse or hateful language",
    hint: "Harassment, threats, or hate aimed at a person or group.",
  },
  {
    value: "nudity",
    label: "Sexual content",
    hint: "Nudity or sexual material.",
  },
  {
    value: "illegal",
    label: "Something illegal",
    hint: "Content that breaks the law where you live.",
  },
  {
    value: "malware",
    label: "A harmful link or file",
    hint: "A link or file that could damage a device or steal an account.",
  },
  {
    value: "other",
    label: "Something else",
    hint: "Anything that does not fit the above. Say what in the note.",
  },
];

export type ReportTarget =
  | {
      kind: "message";
      /** The reported message or post. */
      eventId: string;
      /** Who wrote it. */
      authorPubkey: string;
    }
  | { kind: "person"; pubkey: string };

const HEX_64 = /^[0-9a-f]{64}$/;

function hex64(value: string, what: string): string {
  const v = value.trim().toLowerCase();
  if (!HEX_64.test(v)) throw new Error(`${what} must be a 64-character hex id`);
  return v;
}

/** The note as it will be sent: trimmed and cut to the limit. An empty note is no note. */
export function tidyNote(note: string): string {
  return note.trim().slice(0, MAX_NOTE_LENGTH);
}

/**
 * The record that reports `target`. A message names the message and its author (the server takes the author from its
 * own copy of the message and uses the tag only to check the shape); a person names only the person. The reason rides
 * on the tag that names the target.
 */
export function reportRecord(input: {
  target: ReportTarget;
  type: ReportType;
  note?: string;
}): { kind: number; content: string; tags: string[][] } {
  if (!REPORT_REASONS.some((reason) => reason.value === input.type)) {
    throw new Error(`unknown report type: ${input.type}`);
  }
  const content = tidyNote(input.note ?? "");
  if (input.target.kind === "message") {
    return {
      kind: KIND_REPORT,
      content,
      tags: [
        ["e", hex64(input.target.eventId, "message id"), input.type],
        ["p", hex64(input.target.authorPubkey, "author id")],
      ],
    };
  }
  return {
    kind: KIND_REPORT,
    content,
    tags: [["p", hex64(input.target.pubkey, "person id"), input.type]],
  };
}
