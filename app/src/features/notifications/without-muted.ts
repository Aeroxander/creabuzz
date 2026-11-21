import type { NotificationGroup } from "@creaton/core/social/notifications.ts";
import type { JoinAsk } from "@creaton/core/project/join.ts";

/**
 * What names this person, without the people they hid: an actor they hid is taken out of a row (a like by two people, one hidden,
 * reads as a like by the other), a row with nobody left is dropped, and so is an ask to join from someone they hid. `newestAt`
 * stays what was read, so looking at the list still counts everything as seen. Pure.
 */
export function withoutMuted<
  T extends { groups: NotificationGroup[]; asks: JoinAsk[] },
>(data: T, muted: ReadonlySet<string>): T {
  if (muted.size === 0) return data;
  const hidden = (pubkey: string) => muted.has(pubkey.toLowerCase());
  return {
    ...data,
    groups: data.groups.flatMap((group) => {
      const actors = group.actors.filter((actor) => !hidden(actor));
      return actors.length > 0 ? [{ ...group, actors }] : [];
    }),
    asks: data.asks.filter((ask) => !hidden(ask.author)),
  };
}
