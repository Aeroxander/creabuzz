/**
 * Every sentence of the holder room, in one place (plan section 7.6), and the server's refusals said in plain words with what
 * to do next. The server's own wording is the contract (`docs/next-version/ROOM-AND-SEASON-RECORDS.md`, section 3): each
 * refusal is matched by its tail, so the server's prefix (`restricted:`, `invalid:`, `retry:`) may change without breaking this.
 */
import {
  plainRefusalText,
  SERVER_FAILED_TEXT,
} from "@creaton/core/client/refusal-text.ts";

export const READ_LINE =
  "Anyone can read this room. Only people who back the project can write here.";
/**
 * The first half of the line above, said alone where the status line under it already says who may write (`MAY_NOT_WRITE`): the
 * sentence is on the screen once, never twice.
 */
export const READ_LINE_OPEN = "Anyone can read this room.";
/** Said where people post and vote: never hidden, never reworded. */
export const PUBLIC_LINE = "Posts and votes are public.";
export const KIND_LINE = "The team can remove posts. Be kind.";

export const PERKS_HEADING = "Perks from the team";
export const PERKS_NOT_MONEY =
  "These are the team's own words. They are not money and not a promise of a return.";
export const PERKS_LABEL = "What do people who back this get?";
export const PERKS_HINT =
  "Say it in words, for example early looks at what you are making. Do not promise money.";

export const COMPOSER_LABEL = "Write to the people who back this";
export const COMPOSER_PLACEHOLDER = "Say something";
export const MAY_NOT_WRITE =
  "Only people who back this project can write here.";
export const NEED_LINK =
  "To tell that you back this project, the server needs this account confirmed.";
/** What the wallet link makes public: said beside every press that makes it. */
const LINK_PUBLIC =
  "This links your wallet to your account. Anyone on this server can see the link, and so can see how many Shares that wallet holds.";
/** The same line for a passkey account, which holds the person's Shares in place of a wallet. */
const LINK_PUBLIC_PASSKEY =
  "This links your passkey account, where your Shares are held, to your account. Anyone on this server can see the link, and so can see how many Shares that passkey account holds.";
/** The line beside every press that makes the link, for the sender in use. */
export const linkPublicFor = (passkey: boolean) =>
  passkey ? LINK_PUBLIC_PASSKEY : LINK_PUBLIC;
export const LINK_CHOICE = "Let me write in this project's room";
export const linkChoiceHint = (passkey: boolean) =>
  `${linkPublicFor(passkey)} Leave it unticked to back without it: you can still take your money out any time.`;
/** Said in the Back sheet in place of the box when nobody is signed in: a link needs an account, and Back does not. */
export const LINK_NEEDS_ACCOUNT =
  "To write in this project's room you need an account first. You can back now without one.";
export const CONFIRM_LABEL = "Confirm this account backs the project";
export const NO_PHONE_ROOMS =
  "Rooms are not switched on for phone accounts on this server.";
export const NOT_READY = "Not ready yet. Try again in a minute.";
export const EMPTY =
  "Nothing here yet. People who back this project can write the first post.";
export const READ_FAILED = "The room could not be read. Try again.";
export const COULD_NOT_CHECK =
  "We could not check right now whether you back this project. Your money is not affected.";
export const TRY_AGAIN = "Try again";
export const CHECKING = "Checking whether you back this project…";

export const linkEnding = (date: string, passkey = false) =>
  `Your ${passkey ? "passkey account" : "wallet"} link ends on ${date}. Confirm it again to keep writing here.`;
export const tookOutLine = (when: string, left: string) =>
  `You took out ${when}. You can write here for ${left} more, then this room is read only for you.`;
export const mutedLine = (date: string) =>
  `The team has stopped you writing here until ${date}. You can still read, and you can take your money out any time.`;

/** The five plain choices of a report, and the record type each is sent as (the server's own types). */
export const REPORT_CHOICES = [
  { value: "spam", label: "Spam" },
  { value: "impersonation", label: "Pretending to be someone" },
  { value: "profanity", label: "Rude or harmful" },
  { value: "illegal", label: "Illegal" },
  { value: "other", label: "Something else" },
] as const;
export type ReportChoice = (typeof REPORT_CHOICES)[number]["value"];
export const REPORT_DONE =
  "Thanks. The people who run this server will look at it.";

export const REMOVE_REASON_MAX = 280;
export const HIDES_UNKNOWN =
  "Your list of hidden people could not be opened, so someone you hid may show here.";
export const NOT_SAVED = "That was not saved. Try again.";
export const LIKE_FAILED = "Your like was not sent. Try again.";
export const REMOVE_FAILED = "The post was not removed. Try again.";
/** The heading over the reasons the team gave for taking posts out of this room. */
export const REMOVED_HEADING = "Removed by the team";
/** One removed post and why: the team's own words, or that it gave none. */
export const removedLine = (reason: string) =>
  reason
    ? `A post was removed here. Reason: ${reason}`
    : "A post was removed here. The team gave no reason.";
/** Said under the list when the room has more removals than it lists. */
export const REMOVED_CUT = "Only the newest removals are listed here.";
/** Said to the team when the read of its stops on people took as many records as it takes at once. */
export const STOPS_CUT =
  "Only the newest 200 team records are read here, so an older stop on a person may not show as a stop.";
/** Said when the room has run out of earlier posts to show: nothing was left out. */
export const NO_EARLIER = "That is every post this room has.";
/** Said when the room read as many posts as it takes at once: older ones are not read here. */
export const READ_CUT =
  "This page shows the newest posts only. Older ones are not read here.";
export const MUTE_DAYS = [1, 7, 30] as const;

export const HIDE_DONE = (name: string) =>
  `You will not see posts by ${name} any more. Only you stop seeing them.`;

/** What a refusal of a room write says, and whether it is the kind that clears by itself (the server has not caught up). */
export interface RoomRefusal {
  words: string;
  /** Not ready yet: the composer keeps the draft and tries once more by itself. */
  catchingUp: boolean;
  /** The account is not confirmed: the confirm button is what fixes it. */
  needsLink: boolean;
}

const refusal = (
  words: string,
  more: Partial<Omit<RoomRefusal, "words">> = {},
): RoomRefusal => ({ words, catchingUp: false, needsLink: false, ...more });

/** The refusals the server's room rule gives, by the tail of the sentence, in the order they are tried. */
const TAILS: [RegExp, RoomRefusal][] = [
  [
    /rooms are not switched on/,
    refusal("Rooms are not switched on for this server yet."),
  ],
  [
    /this project is not here/,
    refusal("This project is not here, so nothing can be posted to it."),
  ],
  [
    /a room post names its project and its room/,
    refusal(
      "That post could not be placed in this room. Reload the page and try again.",
    ),
  ],
  [
    /the room is for text/,
    refusal("The room is for text: leave out pictures and files."),
  ],
  [
    /a room post is at most 2000 characters/,
    refusal("A post can be at most 2,000 characters. Make it shorter."),
  ],
  [
    /the server has not read this project yet/,
    refusal(NOT_READY, { catchingUp: true }),
  ],
  [
    /link your wallet to your account first/,
    refusal(NEED_LINK, { needsLink: true }),
  ],
  [
    /only people who back this project can write/,
    // The app only offers a composer to someone who holds: from them this is the server not having caught up yet.
    refusal(NOT_READY, { catchingUp: true }),
  ],
  [
    /the team has stopped you writing/,
    refusal(
      "The team has stopped you writing here for now. You can still read, and you can take your money out any time.",
    ),
  ],
  [
    /you are writing too fast/,
    refusal("You are writing too fast. Try again in a few minutes."),
  ],
  [
    /too many accounts write from this wallet/,
    refusal("Too many accounts write from this wallet."),
  ],
  [
    /a reply belongs in the same room/,
    refusal("A reply belongs in the same room as the post it answers."),
  ],
];

/** A refusal in plain words. `message` is what the server said; a failure that is not the server's words says `failure`. */
export function roomRefusal(
  message: string,
  failure = "Your post was not sent. Try again.",
): RoomRefusal {
  for (const [pattern, said] of TAILS) if (pattern.test(message)) return said;
  // A ban, a timeout or a request limit has its own plain words.
  const plain = plainRefusalText(message);
  if (plain) return refusal(plain);
  if (/^error:|database/i.test(message)) return refusal(SERVER_FAILED_TEXT);
  return refusal(failure);
}

/** A stretch of time for a sentence: "3 days", "5 hours", "20 minutes" (at least one minute). */
export function leftText(seconds: number): string {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  if (minutes < 60) return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 48) return hours === 1 ? "1 hour" : `${hours} hours`;
  const days = Math.ceil(hours / 24);
  return `${days} days`;
}

export const linkEnded = (passkey = false) =>
  `Your ${passkey ? "passkey account" : "wallet"} link has ended. Confirm this account again to write here.`;
