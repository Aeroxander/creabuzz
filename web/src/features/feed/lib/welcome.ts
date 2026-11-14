/**
 * The newcomer's welcome on Home: three ways in (start a project, find work, follow some projects), shown once to an
 * account that is tied to no project yet.
 *
 * "Once" is kept in the browser, for one account on one server: choosing a way in or putting the welcome away both
 * count. A browser that keeps nothing shows it again on the next visit, which is the safe side of that failure.
 *
 * The projects offered to follow are the ones with real activity this week (`moving.ts`), topped up with the ones
 * first published most recently. Never by when a record was saved, never by a price.
 *
 * Pure and alias-free: `welcome.test.mjs` drives it under `node --test`.
 */

import { movingNow } from "./moving.ts";

interface Store {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const welcomeKey = (server: string, account: string) =>
  `creaton.welcome.seen.${server}|${account.toLowerCase()}`;

export function welcomeSeen(
  store: Store | null | undefined,
  server: string,
  account: string,
): boolean {
  try {
    return store?.getItem(welcomeKey(server, account)) === "1";
  } catch {
    return false;
  }
}

/** False when the browser would not keep it. */
export function markWelcomeSeen(
  store: Store | null | undefined,
  server: string,
  account: string,
): boolean {
  try {
    if (!store) return false;
    store.setItem(welcomeKey(server, account), "1");
    return true;
  } catch {
    return false;
  }
}

type Pickable = Parameters<typeof movingNow>[0][number];

/** Up to `count` projects to offer: the most active this week first, then the newest, none twice, none of `mine`. */
export function welcomePicks<T extends Pickable>(
  launches: readonly T[],
  now: number,
  mine: string | null,
  count = 5,
): T[] {
  const open = launches.filter((launch) => launch.record.author !== mine);
  const active = movingNow(open, now, count).map((entry) => entry.launch);
  const taken = new Set(active);
  const newest = open
    .filter((launch) => !taken.has(launch))
    .sort(
      (a, b) =>
        b.record.startedAt - a.record.startedAt ||
        (a.record.eventId < b.record.eventId ? -1 : 1),
    );
  return [...active, ...newest].slice(0, count);
}
