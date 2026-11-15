/**
 * The server's own example project: the listed project its owner started, so a first visitor can read what a record
 * looks like (`docs/v3-review/CREATON-EXAMPLE-PROJECT.md`). Nothing in a project's record says it is the server's, so
 * it is told by who started it: the owner named in the server's own member list. When the list cannot be read, or the
 * owner has no listed project, there is no example and nothing is offered in its place.
 *
 * Pure and alias-free: `example-project.test.mjs` drives it under `node --test`.
 */

interface ExampleLaunch {
  record: {
    author: string;
    eventId: string;
    startedAt: number;
    listing?: "unlisted" | null;
  };
}

/**
 * The owner's oldest listed project, or null. `owner` is the owner's account as the member list names it (any case);
 * `launches` are the projects already filtered to the ones this build lists.
 */
export function exampleProject<T extends ExampleLaunch>(
  launches: readonly T[],
  owner: string | null,
): T | null {
  if (!owner) return null;
  const who = owner.trim().toLowerCase();
  const mine = launches
    .filter(
      (launch) =>
        launch.record.author.toLowerCase() === who &&
        launch.record.listing !== "unlisted",
    )
    .sort(
      (a, b) =>
        a.record.startedAt - b.record.startedAt ||
        (a.record.eventId < b.record.eventId ? -1 : 1),
    );
  return mine[0] ?? null;
}

/**
 * `picks` with the example project first (added when it was not among them), at most `count` long, nobody twice. The
 * reader's own project is never added: a list to follow does not offer someone their own. Projects are the same when
 * their records are.
 */
export function exampleFirst<
  T extends { record: { eventId: string; author: string } },
>(
  picks: readonly T[],
  example: T | null,
  me: string | null = null,
  count = 5,
): T[] {
  if (!example || (me !== null && example.record.author === me))
    return [...picks];
  return [
    example,
    ...picks.filter((pick) => pick.record.eventId !== example.record.eventId),
  ].slice(0, Math.max(count, 1));
}
