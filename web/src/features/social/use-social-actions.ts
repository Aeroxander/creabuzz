import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  KIND_BOOKMARK_LIST,
  KIND_MUTE_LIST,
  KIND_PROFILE,
} from "@/shared/constants/kinds";
import {
  existingUserPubkey,
  nip44DecryptAsUser,
  nip44EncryptAsUser,
} from "@/shared/lib/identity";

import type { EventTemplate, SignedEventLike } from "../feed/lib/feed-events";
import { latestList } from "../feed/lib/lists";
import { publishFeedEvent } from "../feed/use-feed";
import {
  bookmarkedIds,
  mutedPeople,
  parsePrivateTags,
  withBookmark,
  withMuted,
} from "./lib/lists";
import { readEvents, readLatest } from "./read";
import { socialKeys } from "./use-social-data";

/** Publish any social event, then refresh what it can change. */
export function useSocialPublish() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (template: EventTemplate) => publishFeedEvent(template),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: socialKeys.all });
      void queryClient.invalidateQueries({ queryKey: ["feed"] });
    },
  });
}

/* ── Mutes (public NIP-51 list) ─────────────────────────────────────────── */

export function useMutedPeople() {
  const me = existingUserPubkey();
  return useQuery({
    queryKey: [...socialKeys.lists, "muted", me],
    enabled: Boolean(me),
    staleTime: 60_000,
    queryFn: async () =>
      mutedPeople(
        latestList(
          await readEvents({
            kinds: [KIND_MUTE_LIST],
            authors: [me as string],
            limit: 5,
          }),
          KIND_MUTE_LIST,
          me as string,
        ),
      ),
  });
}

/**
 * Mute or unmute a person. The mute list replaces itself on every write, so
 * the newest copy is re-read first and the write is refused if it no longer
 * contains someone this session already saw in it.
 */
export function useToggleMute() {
  const queryClient = useQueryClient();
  const me = existingUserPubkey();
  return useMutation({
    mutationFn: async ({
      pubkey,
      muted,
    }: {
      pubkey: string;
      muted: boolean;
    }) => {
      if (!me) throw new Error("Sign in to mute people.");
      const known = queryClient.getQueryData<Set<string>>([
        ...socialKeys.lists,
        "muted",
        me,
      ]);
      const latest = latestList(
        await readEvents({ kinds: [KIND_MUTE_LIST], authors: [me], limit: 5 }),
        KIND_MUTE_LIST,
        me,
      );
      const current = mutedPeople(latest);
      for (const seen of known ?? []) {
        if (!current.has(seen)) {
          throw new Error(
            "Couldn't load your mute list. Try again in a moment.",
          );
        }
      }
      return publishFeedEvent(withMuted(latest, pubkey, muted));
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: socialKeys.lists });
    },
  });
}

/* ── Bookmarks (private: NIP-44 in the list's content) ──────────────────── */

interface BookmarkState {
  list: SignedEventLike | null;
  privateTags: string[][];
  readable: boolean;
}

async function readBookmarkState(me: string): Promise<BookmarkState> {
  const list = latestList(
    await readEvents({ kinds: [KIND_BOOKMARK_LIST], authors: [me], limit: 5 }),
    KIND_BOOKMARK_LIST,
    me,
  );
  if (!list?.content) return { list, privateTags: [], readable: true };
  try {
    return {
      list,
      privateTags: parsePrivateTags(await nip44DecryptAsUser(me, list.content)),
      readable: true,
    };
  } catch {
    // Written by another client in a form we cannot read: show the public
    // entries, but never overwrite it.
    return { list, privateTags: [], readable: false };
  }
}

/** Ids of the notes you saved. */
export function useBookmarkIds() {
  const me = existingUserPubkey();
  return useQuery({
    queryKey: [...socialKeys.lists, "bookmarks", me],
    enabled: Boolean(me),
    staleTime: 60_000,
    queryFn: async () => {
      const state = await readBookmarkState(me as string);
      return bookmarkedIds(state.list, state.privateTags);
    },
  });
}

export function useToggleBookmark() {
  const queryClient = useQueryClient();
  const me = existingUserPubkey();
  return useMutation({
    mutationFn: async ({ id, saved }: { id: string; saved: boolean }) => {
      if (!me) throw new Error("Sign in to save posts.");
      const state = await readBookmarkState(me);
      if (!state.readable) {
        throw new Error(
          "Your saved posts were written by another app in a form this one can't read, so nothing was changed.",
        );
      }
      const next = withBookmark(state.list, state.privateTags, id, saved);
      const content = next.privateTags.length
        ? await nip44EncryptAsUser(me, JSON.stringify(next.privateTags))
        : "";
      return publishFeedEvent({ kind: next.kind, tags: next.tags, content });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: socialKeys.lists });
    },
  });
}

/* ── Profile (kind 0) ───────────────────────────────────────────────────── */

export type ProfilePatch = Partial<
  Record<
    "display_name" | "name" | "about" | "picture" | "banner" | "website",
    string
  >
>;

/** Merge edited fields into your kind 0, keeping every field this form doesn't touch. */
export function useUpdateProfile() {
  const queryClient = useQueryClient();
  const me = existingUserPubkey();
  return useMutation({
    mutationFn: async (patch: ProfilePatch) => {
      if (!me) throw new Error("Sign in to edit your profile.");
      const latest = await readLatest(KIND_PROFILE, me);
      let existing: Record<string, unknown> = {};
      try {
        const parsed = latest ? JSON.parse(latest.content) : {};
        if (parsed && typeof parsed === "object") existing = parsed;
      } catch {
        // Unreadable profile JSON — start from the edited fields alone.
      }
      const merged: Record<string, unknown> = { ...existing };
      for (const [field, value] of Object.entries(patch)) {
        const trimmed = value?.trim();
        if (trimmed) merged[field] = trimmed;
        else delete merged[field];
      }
      return publishFeedEvent({
        kind: KIND_PROFILE,
        tags: latest?.tags ?? [],
        content: JSON.stringify(merged),
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["profiles"] });
    },
  });
}
