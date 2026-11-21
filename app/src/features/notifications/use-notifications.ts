import {
  KIND_CONTACT_LIST,
  KIND_LAUNCH_UPDATE,
  KIND_REACTION,
  KIND_REPOST,
  KIND_TEXT_NOTE,
} from "@creaton/core/kinds.ts";
import { relayWsUrl } from "@creaton/core/client/relay-url.ts";
import { type JoinAsk, parseJoinAsk } from "@creaton/core/project/join.ts";
import {
  buildNotifications,
  groupNotifications,
  type NotificationGroup,
  readSeenAt,
  writeSeenAt,
} from "@creaton/core/social/notifications.ts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { useMutes } from "../../lib/mutes";
import { withoutMuted } from "./without-muted";
import { useAccount } from "../../lib/account";
import { readMulti } from "../../lib/relay";
import { useUnseenNews } from "../alerts/use-news";

export type { NotificationGroup };

export interface Notifications {
  groups: NotificationGroup[];
  /** Asks to join the person's projects (they are the founder). */
  asks: JoinAsk[];
  newestAt: number;
}

const notificationKeys = {
  mine: (me: string | null) => ["notifications", me] as const,
};

/** Read again this often while the app is open, never while it is hidden. */
const POLL_MS = 30_000;

/**
 * What names the person: replies, mentions, likes, reposts and follows (the social bell web/ has), and asks to join
 * their projects. One read on one connection.
 */
export function useNotifications() {
  const { pubkey } = useAccount();
  // What people the reader hid did is not shown, nor counted on the tab's dot.
  const { muted } = useMutes();
  const hideMuted = useCallback(
    (data: Notifications) => withoutMuted(data, muted),
    [muted],
  );
  return useQuery({
    select: hideMuted,
    queryKey: notificationKeys.mine(pubkey),
    enabled: pubkey !== null,
    staleTime: 15_000,
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: false,
    queryFn: async (): Promise<Notifications> => {
      const me = pubkey as string;
      const [social, updates] = await readMulti([
        {
          kinds: [
            KIND_TEXT_NOTE,
            KIND_REACTION,
            KIND_REPOST,
            KIND_CONTACT_LIST,
          ],
          "#p": [me],
          limit: 150,
        },
        { kinds: [KIND_LAUNCH_UPDATE], "#p": [me], limit: 100 },
      ]);
      const groups = groupNotifications(buildNotifications(social, me));
      const asks = updates
        .map(parseJoinAsk)
        .filter((ask): ask is JoinAsk => ask !== null && ask.author !== me);
      const newestAt = Math.max(
        0,
        ...groups.map((g) => g.at),
        ...asks.map((a) => a.createdAt),
      );
      return { groups, asks, newestAt };
    },
  });
}

/**
 * How many notifications arrived since the person last looked, and how many pieces of news about their projects they have
 * not read (the dot on You: one count, the sum).
 */
export function useUnseenCount(): number {
  const { pubkey } = useAccount();
  const data = useNotifications().data;
  const news = useUnseenNews();
  if (!pubkey) return 0;
  if (!data) return news;
  const seen = readSeenAt(relayWsUrl(), pubkey);
  return (
    data.groups.filter((g) => g.at > seen).length +
    data.asks.filter((a) => a.createdAt > seen).length +
    news
  );
}

/** Mark everything up to now as seen. */
export function useMarkSeen() {
  const { pubkey } = useAccount();
  const queryClient = useQueryClient();
  return useCallback(
    (at: number) => {
      if (!pubkey || at <= 0) return;
      if (readSeenAt(relayWsUrl(), pubkey) >= at) return;
      writeSeenAt(relayWsUrl(), pubkey, at);
      void queryClient.invalidateQueries({
        queryKey: notificationKeys.mine(pubkey),
      });
    },
    [pubkey, queryClient],
  );
}
