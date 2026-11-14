/**
 * Following records live wherever they are kept.
 *
 * The server delivers a record live only to subscriptions on the same side as the record
 * (`buzz-relay/src/subscription.rs`): a subscription tied to rooms or boards (its filter names them with `#h`) hears only
 * records kept under those rooms; an untied one hears only records kept under none. So records that can be kept either
 * way (a task may belong to a room or to no room) need one untied subscription and one per room.
 *
 * Alias-free; `live-scope.test.mjs` drives it under `node --test`.
 */

/** The untied filter, then one tied to each room or board. */
export function liveFiltersFor<F extends object>(
  base: F,
  channelIds: readonly string[],
): (F | (F & { "#h": string[] }))[] {
  return [base, ...channelIds.map((id) => ({ ...base, "#h": [id] }))];
}
