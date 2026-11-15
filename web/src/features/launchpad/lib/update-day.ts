/**
 * The founder's update day: the weekday their weekly update falls due, which they can change or turn off. It starts as
 * the weekday the project was started, so nobody has to choose before they have posted once.
 *
 * It is a quiet in-app reminder and a calendar event (`calendar-reminder.ts`), nothing more: no email, no push. The
 * words stay neutral: an update is "due", never missed or late, and turning the reminder off is one choice that stays
 * off. The choice is kept in this browser (like the founder's "Not now"), per project; the calendar event is how the
 * reminder reaches other devices.
 *
 * Days are counted in the person's own calendar time, like the calendar event. Pure and alias-free:
 * `update-day.test.mjs` drives it under `node --test`.
 */

/** Weekday names, indexed like `Date#getDay` (0 is Sunday). */
export const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/** The stored value that means "no reminder". */
const OFF = -1;

/** How many projects' update days a browser remembers. */
const KEPT = 50;

/** The weekday a project was started on (`startedAt` in seconds), in the person's own calendar time. */
export function defaultUpdateDay(startedAt: number): number {
  return new Date(startedAt * 1000).getDay();
}

/** What a browser remembers: per project, a weekday (0 to 6) or `-1` for no reminder. */
export type StoredUpdateDays = Record<string, number>;

/** The remembered choices from stored text. Anything unreadable is left out; nothing is guessed. */
export function parseUpdateDays(raw: string | null): StoredUpdateDays {
  try {
    const value: unknown = JSON.parse(raw ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          (entry): entry is [string, number] =>
            typeof entry[1] === "number" &&
            Number.isInteger(entry[1]) &&
            entry[1] >= OFF &&
            entry[1] <= 6,
        )
        .slice(-KEPT),
    );
  } catch {
    return {};
  }
}

/** The update day for a project: the remembered choice, or the weekday it started on. */
export function updateDayOf(
  stored: StoredUpdateDays,
  scope: string,
  startedAt: number,
): { weekday: number; off: boolean } {
  const choice = stored[scope];
  if (choice === OFF)
    return { weekday: defaultUpdateDay(startedAt), off: true };
  return {
    weekday: choice !== undefined ? choice : defaultUpdateDay(startedAt),
    off: false,
  };
}

/** The choices with one more: a weekday, or "off". The newest `KEPT` stay. */
export function withUpdateDay(
  stored: StoredUpdateDays,
  scope: string,
  choice: number | "off",
): StoredUpdateDays {
  const { [scope]: _, ...rest } = stored;
  const value = choice === "off" ? OFF : choice;
  if (value !== OFF && !(Number.isInteger(value) && value >= 0 && value <= 6))
    return stored;
  return Object.fromEntries(
    Object.entries({ ...rest, [scope]: value }).slice(-KEPT),
  );
}

/**
 * Whether the update is due on the update day: the day has come round since the last update (or there is none), so
 * it stays due until one is posted. An update posted on the day itself, or after it, settles it for the week. Times
 * are seconds.
 */
export function dueOnDay(
  weekday: number,
  lastAt: number | null,
  now: number,
): boolean {
  if (lastAt === null) return true;
  const today = new Date(now * 1000);
  const day = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  day.setDate(day.getDate() - ((day.getDay() - weekday + 7) % 7));
  return lastAt * 1000 < day.getTime();
}

/** The line shown when the update day has come but a week has not yet passed. Neutral: it says what is due. */
export function dueOnDayWords(weekday: number): string {
  return `Your weekly update is due. ${WEEKDAY_NAMES[weekday]} is your update day.`;
}

/** What the setting says, for its label: "Every Tuesday", or "No reminder". */
export function updateDayLabel(setting: {
  weekday: number;
  off: boolean;
}): string {
  return setting.off
    ? "No reminder"
    : `Every ${WEEKDAY_NAMES[setting.weekday]}`;
}

/** The browser's storage, as far as this needs it. */
interface Storage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The key the choices are kept under. */
export const UPDATE_DAY_KEY = "creaton.update-day.v1";

/** The choices this browser remembers. Empty when storage cannot be read. */
export function readUpdateDays(storage: Storage | null): StoredUpdateDays {
  try {
    return parseUpdateDays(storage?.getItem(UPDATE_DAY_KEY) ?? null);
  } catch {
    return {};
  }
}

/** Remembers a choice. False when it could not be saved (the page still uses it for this visit). */
export function writeUpdateDay(
  storage: Storage | null,
  scope: string,
  choice: number | "off",
): boolean {
  try {
    if (!storage) return false;
    storage.setItem(
      UPDATE_DAY_KEY,
      JSON.stringify(withUpdateDay(readUpdateDays(storage), scope, choice)),
    );
    return true;
  } catch {
    return false;
  }
}
