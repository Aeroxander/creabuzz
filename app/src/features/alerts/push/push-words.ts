/**
 * Every sentence of alerts away from the app (plan section 7.8), in one place. Pure. The three sentences a device shows
 * (`PUSH_WORDS`) are also written in `public/sw.js`, which is a plain file that cannot import this one: a test loads the
 * worker and holds the two to the same words, and the kinds are the three of the in-app news (planned, taken, ended).
 */

/** The title of every alert on the device: the worker file is plain and the product name is a build value, so it has none. */
export const PUSH_TITLE = "News about a project you back";

/** What each kind of alert says on the device. No amount, no name, no date: the message carries none. */
export const PUSH_WORDS = {
  planned:
    "A task was planned on a project you back. You can take your money out first.",
  taken: "A task was started on a project you back.",
  ended: "A task ended on a project you back.",
} as const;

export const PUSH_HEADING = "Alerts when you are away";
export const PUSH_EXPLAINED =
  "Get a short message on this device when a task is planned, taken or ended on a project you back. It says nothing about amounts or names. Open the app to read the news.";
export const PUSH_TURN_ON = "Turn on alerts";
export const PUSH_ASKING = "Waiting for your browser…";
export const PUSH_NEEDS_LINK =
  "To tell which projects you back, the server needs this account confirmed.";
export const PUSH_NO_PHONE =
  "Alerts are not switched on for phone accounts on this server.";
export const PUSH_IS_ON = "Alerts are on for this device.";
export const PUSH_TURN_OFF = "Turn off";
export const PUSH_OFF_DONE =
  "Alerts are off. What the server kept for this device is deleted.";
export const PUSH_OFF_PENDING =
  "Alerts are off on this device. The server could not be reached to delete what it kept; it will try again.";
export const PUSH_OFF_FAILED = "Alerts could not be turned off. Try again.";
export const PUSH_BLOCKED =
  "Alerts are blocked for this site in your browser settings.";
export const PUSH_CANNOT =
  "This browser cannot show alerts. On an iPhone, add the app to your Home Screen first.";
export const PUSH_FAILED = "Alerts could not be turned on. Try again.";
export const PUSH_SMALL = [
  "Alerts may arrive late or not at all. The news on this page is always the full story.",
  "You can turn alerts off any time.",
] as const;
