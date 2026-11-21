import { KIND_BOOKMARK_LIST, KIND_CONTACT_LIST } from "@creaton/core/kinds.ts";
import {
  followedLaunches,
  followedPeople,
  latestList,
  withLaunch,
  withPerson,
} from "@creaton/core/social/feed/lists.ts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAccount } from "./account";
import { listScope, listWriter } from "./lists";
import { publishAsUser, read } from "./relay";

const followKeys = {
  mine: (me: string | null) => ["follows", me] as const,
};

/**
 * Who and what the person follows: people in their contact list (kind 3), projects in their bookmark list (kind
 * 10003), the lists web/ writes too. Empty for someone without an account.
 */
export function useFollows() {
  const { pubkey } = useAccount();
  return useQuery({
    queryKey: followKeys.mine(pubkey),
    enabled: pubkey !== null,
    staleTime: 60_000,
    queryFn: async () => {
      const me = pubkey as string;
      const events = await read({
        kinds: [KIND_CONTACT_LIST, KIND_BOOKMARK_LIST],
        authors: [me],
        limit: 10,
      });
      const people = latestList(events, KIND_CONTACT_LIST, me);
      // A read that began before one of this tab's own changes landed must not bring the older list back.
      const projects = listWriter.newest(
        listScope(me),
        KIND_BOOKMARK_LIST,
        latestList(events, KIND_BOOKMARK_LIST, me),
      );
      return {
        peopleList: people,
        projectList: projects,
        people: followedPeople(people),
        projects: followedLaunches(projects),
      };
    },
  });
}

/**
 * Follow or stop following a project. It goes through the list queue (`./lists`), which reads the newest copy of the list
 * first and keeps whatever else the list holds (saved posts, other apps' entries), so a change made elsewhere is not lost.
 */
export function useFollowProject() {
  const { pubkey } = useAccount();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { coordinate: string; follow: boolean }) => {
      const me = pubkey as string;
      return listWriter.enqueue({
        scope: listScope(me),
        author: me,
        kind: KIND_BOOKMARK_LIST,
        target: input.coordinate,
        follow: input.follow,
        apply: (latest) => withLaunch(latest, input.coordinate, input.follow),
      });
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: followKeys.mine(pubkey) }),
  });
}

/** Follow or stop following a person. */
export function useFollowPerson() {
  const { pubkey } = useAccount();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { pubkey: string; follow: boolean }) => {
      const me = pubkey as string;
      const events = await read({
        kinds: [KIND_CONTACT_LIST],
        authors: [me],
        limit: 5,
      });
      const list = latestList(events, KIND_CONTACT_LIST, me);
      return publishAsUser(
        withPerson(list, input.pubkey, input.follow),
        "Your follow was not saved. Try again.",
      );
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: followKeys.mine(pubkey) }),
  });
}
