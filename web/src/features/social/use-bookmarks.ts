import {
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { toast } from "sonner";

import { SIGN_UP_EVENT } from "@/features/identity/lib/account-copy";
import { KIND_BOOKMARK_LIST } from "@/shared/constants/kinds";
import {
  existingUserPubkey,
  nip44DecryptAsUser,
  nip44EncryptAsUser,
} from "@/shared/lib/identity";
import { failureWords } from "@/shared/lib/readable-error";

import { latestList } from "../feed/lib/lists";
import { listScope, listWriter } from "../feed/use-feed";
import { bookmarkChange, savedIds } from "./lib/bookmark-change";
import { readEvents } from "./read";
import { socialKeys } from "./use-social-data";

/**
 * Your saved posts. They are the private part of the same list (kind 10003) the launch follows are written to, so
 * every change goes through the follow queue (`feed/lib/follow-queue.ts`): one at a time, each from the newest copy
 * of the list, never over a follow made a moment earlier.
 */

const bookmarksKey = (me: string | null) =>
  [...socialKeys.lists, "bookmarks", me] as const;

/** Ids of the notes you saved, oldest save first. */
export function useBookmarkIds() {
  const me = existingUserPubkey();
  return useQuery({
    queryKey: bookmarksKey(me),
    enabled: Boolean(me),
    staleTime: 60_000,
    queryFn: async () => {
      const author = me as string;
      const events = await readEvents({
        kinds: [KIND_BOOKMARK_LIST],
        authors: [author],
        limit: 5,
      });
      // A read that began before one of this tab's saves landed must not bring the older list back.
      const list = listWriter.newest(
        listScope(author),
        KIND_BOOKMARK_LIST,
        latestList(events, KIND_BOOKMARK_LIST, author),
      );
      return savedIds(list, (text) => nip44DecryptAsUser(author, text));
    },
  });
}

/** Save or remove one post. Resolves once the server accepted the new list and the saved posts are updated. */
function saveBookmark(
  queryClient: QueryClient,
  me: string,
  id: string,
  saved: boolean,
): Promise<unknown> {
  const after: { ids: string[] | null } = { ids: null };
  return listWriter
    .enqueue({
      scope: listScope(me),
      author: me,
      kind: KIND_BOOKMARK_LIST,
      target: id,
      follow: saved,
      apply: async (latest) => {
        const change = await bookmarkChange(latest, id, saved, {
          open: (text) => nip44DecryptAsUser(me, text),
          seal: (text) => nip44EncryptAsUser(me, text),
        });
        after.ids = change.ids;
        return change.template;
      },
      // Before the post stops showing as waiting, so the button never flickers back.
      onWritten: () => queryClient.setQueryData(bookmarksKey(me), after.ids),
    })
    .catch((error: unknown) => {
      // The write may have landed even though no answer came: read the truth again.
      void queryClient.invalidateQueries({ queryKey: bookmarksKey(me) });
      throw error;
    });
}

/**
 * One post's bookmark button. `saved` is what to show: the change still on its way if there is one, so a click is seen
 * at once, otherwise what the server holds (`bookmarked`). A refused or lost save says so and offers Try again, and
 * the button goes back to what is true. Signed out, a click opens sign-up.
 */
export function useBookmark(id: string, bookmarked: boolean) {
  const queryClient = useQueryClient();
  const me = existingUserPubkey();
  useSyncExternalStore(listWriter.subscribe, listWriter.version);
  const waiting = me
    ? listWriter.pendingFor(listScope(me), KIND_BOOKMARK_LIST, id)
    : undefined;
  const saved = waiting ?? bookmarked;

  const change = (wanted: boolean) => {
    if (!me) {
      window.dispatchEvent(new Event(SIGN_UP_EVENT));
      return;
    }
    saveBookmark(queryClient, me, id, wanted).catch((error: unknown) => {
      toast.error(
        wanted
          ? "Your bookmark was not saved"
          : "Your bookmark was not removed",
        {
          description: failureWords(
            error,
            "The server did not answer, so nothing was changed.",
          ).text,
          action: { label: "Try again", onClick: () => change(wanted) },
        },
      );
    });
  };

  return { saved, toggle: () => change(!saved) };
}
