/**
 * Whether other apps can reach the person on this server: their message server list (kind 10050) names it. The list is
 * public and replaces itself, so it is changed through the shared list queue (`lib/lists`), from the newest copy, keeping
 * every server and tag put there from another app. A list that cannot be read is "not known", never "off": nothing is written
 * from a guess.
 */
import { KIND_DM_RELAY_LIST } from "@creaton/core/kinds.ts";
import { relayWsUrl } from "@creaton/core/client/relay-url.ts";
import { latestList } from "@creaton/core/social/feed/lists.ts";
import {
  listsServer,
  messageServersChange,
} from "@creaton/core/social/message-servers.ts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { useAccount } from "../../lib/account";
import { listScope, listWriter } from "../../lib/lists";
import { read } from "../../lib/relay";

const keys = { mine: (me: string | null) => ["message-servers", me] as const };

/** Whether this server is on the person's list; `known` is false until it has been read. */
export function useMessageServers() {
  const { pubkey } = useAccount();
  const queryClient = useQueryClient();
  useSyncExternalStore(listWriter.subscribe, listWriter.version);
  const state = useQuery({
    queryKey: keys.mine(pubkey),
    enabled: pubkey !== null,
    staleTime: 60_000,
    retry: false,
    queryFn: async (): Promise<boolean> => {
      const me = pubkey as string;
      const events = await read({
        kinds: [KIND_DM_RELAY_LIST],
        authors: [me],
        limit: 5,
      });
      return listsServer(
        listWriter.newest(
          listScope(me),
          KIND_DM_RELAY_LIST,
          latestList(events, KIND_DM_RELAY_LIST, me),
        ),
        relayWsUrl(),
      );
    },
  });
  const change = useMutation({
    mutationFn: (on: boolean) => {
      const me = pubkey as string;
      const community = relayWsUrl();
      return listWriter.enqueue({
        scope: listScope(me),
        author: me,
        kind: KIND_DM_RELAY_LIST,
        target: community,
        follow: on,
        apply: (latest) => messageServersChange(latest, community, on),
      });
    },
    onSuccess: (_written, on) =>
      queryClient.setQueryData(keys.mine(pubkey), on),
  });
  return {
    /** On the list, when it has been read. */
    on: state.data ?? null,
    isPending: state.isPending,
    isError: state.isError,
    refetch: state.refetch,
    change,
  };
}
