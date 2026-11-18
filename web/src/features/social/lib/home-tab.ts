/**
 * Which tab Home opens on.
 *
 * Home is the feed of project records, so with nothing else to go on it opens on Updates (Just started, Update day,
 * This week and the records themselves) for everyone, signed in or not. The other tabs stay one press away. A tab named
 * in the address wins, so a link and Back still open what they say. A person who picked a tab keeps it: the pick is
 * kept in this browser, for that person on that server, and the bare address then opens on it.
 *
 * Pure and alias-free: `home-tab.test.mjs` drives it under `node --test`.
 */

export type HomeTab = "everyone" | "following" | "boards" | "updates";

const HOME_TABS: readonly HomeTab[] = [
  "everyone",
  "following",
  "boards",
  "updates",
];

/** The tab Home opens on when nothing says otherwise: the feed of project records. */
const HOME_LANDING: HomeTab = "updates";

const KEY = "creaton.home.tab";

interface Store {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The tab `scope` (the server and the person) last picked, or null when they never picked one or it cannot be read. */
export function storedHomeTab(
  store: Store | null | undefined,
  scope: string | null,
): HomeTab | null {
  if (scope === null) return null;
  try {
    const value: unknown = JSON.parse(store?.getItem(KEY) ?? "null");
    if (!value || typeof value !== "object") return null;
    const { scope: kept, tab } = value as Record<string, unknown>;
    if (kept !== scope) return null;
    return HOME_TABS.find((known) => known === tab) ?? null;
  } catch {
    return null;
  }
}

/** Keep the tab `scope` picked. A browser that refuses to keep it only means Home opens on Updates next time. */
export function rememberHomeTab(
  store: Store | null | undefined,
  scope: string | null,
  tab: HomeTab,
): void {
  if (scope === null) return;
  try {
    store?.setItem(KEY, JSON.stringify({ scope, tab }));
  } catch {
    // Nothing to do: the pick still holds for this visit, in the address.
  }
}

/** The tab to show: the one the address asks for, else the person's own pick, else the feed of project records. */
export function homeTab(input: {
  asked: HomeTab | undefined;
  stored: HomeTab | null;
}): HomeTab {
  return input.asked ?? input.stored ?? HOME_LANDING;
}

/**
 * The address for a tab someone picked: bare when the bare address already opens on it, `?tab=` otherwise. `stored` is
 * what the browser kept after the pick, read back: a browser that kept nothing gets the tab in the address, so the
 * pick still holds.
 */
export function homeTabSearch(
  picked: HomeTab,
  stored: HomeTab | null,
): { tab?: HomeTab } {
  return homeTab({ asked: undefined, stored }) === picked
    ? {}
    : { tab: picked };
}
