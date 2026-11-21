/**
 * The posts this person saved: the private part of their bookmark list (kind 10003), sealed to their own key, so what
 * they save is not readable by anyone else on the server. (The same list carries the projects they follow, in plain
 * tags; saving a post never writes the post into those.) Every change goes through the shared list queue (`./lists`).
 *
 * A list that cannot be opened right now (a locked passkey, a refused signer) is a failure, never an empty list: saving
 * then says so and writes nothing, so a saved post is never lost to a read that failed.
 */
import {
  nip44DecryptAsUser,
  nip44EncryptAsUser,
} from "@creaton/core/client/identity.ts";
import { KIND_BOOKMARK_LIST } from "@creaton/core/kinds.ts";
import { bookmarkChange } from "@creaton/core/social/bookmark-change.ts";
import { latestList } from "@creaton/core/social/feed/lists.ts";
import { bookmarkedIds, parsePrivateTags } from "@creaton/core/social/lists.ts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { useAccount } from "./account";
import { listScope, listWriter } from "./lists";
import { read } from "./relay";

/** The most posts a person can keep saved (the sealed list has a size limit of its own; this stays well under it). */
export const MAX_SAVED = 500;

/** Said when the list cannot be opened (a locked passkey, a refused signer, a list another app wrote in a form this one cannot read). */
export const SAVED_UNREADABLE =
  "Your saved posts could not be opened, so nothing was changed. If your passkey is locked, unlock it and try again.";

/** Said when a save would pass the limit. */
export const SAVED_FULL = `You can save up to ${MAX_SAVED} posts. Remove one first.`;

const bookmarkKeys = {
  mine: (me: string | null) => ["bookmarks", me] as const,
};

/** Saved post ids, the newest save first. */
export interface SavedState {
  ids: string[];
}

/**
 * The saved posts in `list`, newest save first. Rejects when the list's private part cannot be opened: that is not
 * "nothing is saved".
 */
async function readSaved(
  list: Parameters<typeof bookmarkedIds>[0],
  open: (ciphertext: string) => Promise<string>,
): Promise<SavedState> {
  const privateTags = list?.content
    ? parsePrivateTags(await open(list.content))
    : [];
  // Other apps' public entries come first in the list and this app's newest saves last: newest first is the reverse.
  return { ids: bookmarkedIds(list, privateTags).reverse() };
}

/** The saved posts, whether a post is saved, and the two presses: save and remove. Empty for someone without an account. */
export function useBookmarks() {
  const { pubkey } = useAccount();
  const queryClient = useQueryClient();
  useSyncExternalStore(listWriter.subscribe, listWriter.version);
  const state = useQuery({
    queryKey: bookmarkKeys.mine(pubkey),
    enabled: pubkey !== null,
    staleTime: 60_000,
    retry: false,
    queryFn: async (): Promise<SavedState> => {
      const me = pubkey as string;
      const events = await read({
        kinds: [KIND_BOOKMARK_LIST],
        authors: [me],
        limit: 5,
      });
      // A read that began before one of this tab's own saves landed must not bring the older list back.
      const list = listWriter.newest(
        listScope(me),
        KIND_BOOKMARK_LIST,
        latestList(events, KIND_BOOKMARK_LIST, me),
      );
      return readSaved(list, (text) => nip44DecryptAsUser(me, text));
    },
  });
  const change = useMutation({
    mutationFn: (input: { id: string; saved: boolean }) => {
      const me = pubkey as string;
      const after: { ids: string[] | null } = { ids: null };
      return listWriter
        .enqueue({
          scope: listScope(me),
          author: me,
          kind: KIND_BOOKMARK_LIST,
          target: input.id,
          follow: input.saved,
          apply: async (latest) => {
            let openFailed = false;
            const next = await bookmarkChange(latest, input.id, input.saved, {
              open: (text) =>
                nip44DecryptAsUser(me, text).catch((error: unknown) => {
                  openFailed = true;
                  throw error;
                }),
              seal: (text) => nip44EncryptAsUser(me, text),
            }).catch((error: unknown) => {
              throw openFailed ? new Error(SAVED_UNREADABLE) : error;
            });
            // Nothing is written when the list is full.
            if (input.saved && next.ids.length > MAX_SAVED)
              throw new Error(SAVED_FULL);
            after.ids = next.ids.reverse();
            return next.template;
          },
          // Before the post stops showing as waiting, so the press never flickers back.
          onWritten: () =>
            queryClient.setQueryData<SavedState>(bookmarkKeys.mine(me), {
              ids: after.ids ?? [],
            }),
        })
        .catch((error: unknown) => {
          // The write may have landed even though no answer came: read the truth again.
          void queryClient.invalidateQueries({
            queryKey: bookmarkKeys.mine(me),
          });
          throw error;
        });
    },
  });
  const ids = state.data?.ids;
  /** What to show for a post: the change still on its way if there is one, else what the list holds. */
  const isSaved = (id: string): boolean => {
    const waiting = pubkey
      ? listWriter.pendingFor(listScope(pubkey), KIND_BOOKMARK_LIST, id)
      : undefined;
    return waiting ?? ids?.includes(id) ?? false;
  };
  return {
    /** The saved posts' ids, newest save first; empty until the list is read. */
    ids: ids ?? [],
    /** The list was read (or there is none). */
    ready: state.isSuccess,
    /** The list could not be opened, so what is saved is not known. */
    failed: state.isError,
    refetch: () => state.refetch(),
    isSaved,
    save: (id: string) => change.mutateAsync({ id, saved: true }),
    remove: (id: string) => change.mutateAsync({ id, saved: false }),
  };
}
