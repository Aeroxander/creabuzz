/**
 * Browser notifications: a heads-up from the browser itself when something new is waiting and the page is not in
 * view. No push server: it works while a tab of the app is open, and says so.
 *
 * - One choice, on or off, kept in the browser for one account on one server.
 * - The browser's permission is asked for only from a button the person presses, and that button is offered only
 *   after they did something that makes a heads-up worth having (followed a project, posted an update), never on
 *   arrival.
 * - A notification says how many things are new and nothing else: no names and no words from anyone's post reach
 *   the lock screen.
 * - One is shown only when the count goes up while the page is hidden; reading the page does not replay it.
 *
 * Pure and alias-free: `browser-notify.test.mjs` drives it under `node --test`.
 */

export type NotifyPref = "on" | "off";
export type NotifyPermission = "default" | "granted" | "denied" | "unsupported";

interface Store {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Said on the page after something that makes a heads-up worth having. */
export const MEANINGFUL_EVENT = "creaton:meaningful-action";
/** Said on the page when the choice changes, so the toggle and the notifier agree at once. */
export const NOTIFY_PREF_EVENT = "creaton:notify-pref";

const prefKey = (server: string, account: string) =>
  `creaton.notify.browser.${server}|${account.toLowerCase()}`;

/** The person's choice, or null when they have not made one (or the browser will not say). */
export function notifyPref(
  store: Store | null | undefined,
  server: string,
  account: string,
): NotifyPref | null {
  try {
    const value = store?.getItem(prefKey(server, account));
    return value === "on" || value === "off" ? value : null;
  } catch {
    return null;
  }
}

/** False when the browser would not keep the choice. */
export function setNotifyPref(
  store: Store | null | undefined,
  server: string,
  account: string,
  pref: NotifyPref,
): boolean {
  try {
    if (!store) return false;
    store.setItem(prefKey(server, account), pref);
    return true;
  } catch {
    return false;
  }
}

/** Whether to offer turning them on: the person has not chosen, and the browser has not been asked. */
export function offerNotifications(input: {
  pref: NotifyPref | null;
  permission: NotifyPermission;
}): boolean {
  return input.pref === null && input.permission === "default";
}

/** Whether notifications are really on: chosen, and allowed by the browser. */
export function notificationsOn(input: {
  pref: NotifyPref | null;
  permission: NotifyPermission;
}): boolean {
  return input.pref === "on" && input.permission === "granted";
}

/**
 * Whether to show one now: they are on, the page is hidden, and there are more new things than the last time one
 * was shown (or than there were when the page was last in view).
 */
export function shouldNotify(input: {
  pref: NotifyPref | null;
  permission: NotifyPermission;
  hidden: boolean;
  unread: number;
  told: number;
}): boolean {
  return notificationsOn(input) && input.hidden && input.unread > input.told;
}

/** "1 new notification", "3 new notifications". */
export function notifyBody(unread: number): string {
  return unread === 1 ? "1 new notification" : `${unread} new notifications`;
}

/** What the settings row says under the switch. */
export function notifyStateLine(input: {
  pref: NotifyPref | null;
  permission: NotifyPermission;
}): string {
  if (input.permission === "unsupported")
    return "This browser can't show notifications.";
  if (input.permission === "denied")
    return "Your browser is blocking notifications for this site. Allow them in the browser's site settings, then turn this on.";
  return notificationsOn(input)
    ? "On. You get a heads-up while a tab of the app is open, even in the background."
    : "Off. Turn it on for a heads-up when something new is waiting. It works while a tab of the app is open.";
}
