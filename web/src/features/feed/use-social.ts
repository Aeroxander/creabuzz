import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  nip44DecryptFromSelf,
  nip44EncryptToSelf,
} from "@/shared/lib/nostr-signer";
import {
  KIND_BOOKMARKS,
  KIND_CONTACTS,
  KIND_MUTES,
  KIND_PROFILE,
  KIND_REACTION,
  tagValues,
} from "./feed-model";
import { fetchEvents, fetchLatest, isFeedPreview } from "./use-feed";
import { publishEvent } from "./publish-event";

const FOLLOWER_SCAN_LIMIT = 1000;

const contactsKey = (pubkey: string | null) => ["feed", "contacts", pubkey];
const mutedKey = (pubkey: string | null) => ["feed", "muted", pubkey];
const bookmarksKey = (pubkey: string | null) => ["feed", "bookmarks", pubkey];

/** Pubkeys a user follows (their kind 3 `p` tags). */
export function useContacts(pubkey: string | null) {
  return useQuery({
    queryKey: contactsKey(pubkey),
    enabled: pubkey !== null,
    staleTime: 60_000,
    queryFn: async () => {
      const latest = pubkey ? await fetchLatest(KIND_CONTACTS, pubkey) : null;
      return tagValues(latest?.tags ?? [], "p");
    },
  });
}

/** Accounts whose latest kind 3 follows `pubkey`. Capped at the scan limit. */
export function useFollowers(pubkey: string) {
  return useQuery({
    queryKey: ["feed", "followers", pubkey],
    staleTime: 60_000,
    queryFn: async () => {
      const events = await fetchEvents({
        kinds: [KIND_CONTACTS],
        "#p": [pubkey],
        limit: FOLLOWER_SCAN_LIMIT,
      });
      return {
        count: new Set(events.map((e) => e.pubkey)).size,
        capped: events.length >= FOLLOWER_SCAN_LIMIT,
      };
    },
  });
}

/** Pubkeys the viewer has muted (public NIP-51 kind 10000 `p` tags). */
export function useMuted(viewer: string | null) {
  return useQuery({
    queryKey: mutedKey(viewer),
    enabled: viewer !== null,
    staleTime: 60_000,
    queryFn: async () => {
      const latest = viewer ? await fetchLatest(KIND_MUTES, viewer) : null;
      return tagValues(latest?.tags ?? [], "p");
    },
  });
}

/**
 * Add/remove one `p` tag on a replaceable list (follows, mutes).
 *
 * These kinds replace the whole list, so we re-read the newest copy right
 * before publishing and refuse to continue if the read looks lossy.
 */
function useToggleListTag(
  kind: number,
  keyOf: typeof contactsKey,
  viewer: string | null,
) {
  const queryClient = useQueryClient();
  const key = keyOf(viewer);
  return useMutation({
    mutationFn: async ({ value, add }: { value: string; add: boolean }) => {
      if (isFeedPreview()) return;
      if (!viewer) throw new Error("Sign in to do that.");
      const latest = await fetchLatest(kind, viewer);
      const cached = queryClient.getQueryData<string[]>(key) ?? [];
      const current = tagValues(latest?.tags ?? [], "p");
      if (cached.some((v) => v !== value && !current.includes(v))) {
        throw new Error(
          "Couldn't load your current list. Try again in a moment.",
        );
      }
      const base = latest?.tags ?? [];
      const without = base.filter((t) => !(t[0] === "p" && t[1] === value));
      const tags = add ? [...without, ["p", value]] : without;
      await publishEvent({ kind, tags, content: latest?.content ?? "" });
    },
    onMutate: async ({ value, add }) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<string[]>(key);
      const base = previous ?? [];
      queryClient.setQueryData<string[]>(
        key,
        add
          ? [...base.filter((v) => v !== value), value]
          : base.filter((v) => v !== value),
      );
      return { previous };
    },
    onError: (_error, _vars, context) =>
      queryClient.setQueryData(key, context?.previous),
    onSettled: () => {
      if (!isFeedPreview()) {
        queryClient.invalidateQueries({ queryKey: ["feed"] });
      }
    },
  });
}

export const useToggleFollow = (viewer: string | null) =>
  useToggleListTag(KIND_CONTACTS, contactsKey, viewer);
export const useToggleMute = (viewer: string | null) =>
  useToggleListTag(KIND_MUTES, mutedKey, viewer);

async function readPrivateBookmarks(content: string): Promise<string[][]> {
  if (!content) return [];
  try {
    const parsed = JSON.parse(await nip44DecryptFromSelf(content));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    throw new Error(
      "Couldn't read your existing bookmarks, so nothing was changed.",
    );
  }
}

/** Bookmarked note ids: private (NIP-44) entries plus any public `e` tags. */
export function useBookmarks(viewer: string | null) {
  return useQuery({
    queryKey: bookmarksKey(viewer),
    enabled: viewer !== null,
    staleTime: 60_000,
    queryFn: async () => {
      const latest = viewer ? await fetchLatest(KIND_BOOKMARKS, viewer) : null;
      if (!latest) return [];
      const privateTags = await readPrivateBookmarks(latest.content).catch(
        () => [],
      );
      return tagValues([...latest.tags, ...privateTags], "e");
    },
  });
}

/**
 * Bookmarks are private: new entries live in the NIP-44-encrypted `content`
 * of the kind 10003 list, so other community members can't see them.
 */
export function useToggleBookmark(viewer: string | null) {
  const queryClient = useQueryClient();
  const key = bookmarksKey(viewer);
  return useMutation({
    mutationFn: async ({ id, add }: { id: string; add: boolean }) => {
      if (isFeedPreview()) return;
      if (!viewer) throw new Error("Sign in to do that.");
      const latest = await fetchLatest(KIND_BOOKMARKS, viewer);
      const cached = queryClient.getQueryData<string[]>(key) ?? [];
      if (!latest && cached.length > 0) {
        throw new Error("Couldn't load your bookmarks. Try again in a moment.");
      }
      const privateTags = await readPrivateBookmarks(latest?.content ?? "");
      const keep = (t: string[]) => !(t[0] === "e" && t[1] === id);
      const nextPrivate = add
        ? [...privateTags.filter(keep), ["e", id]]
        : privateTags.filter(keep);
      await publishEvent({
        kind: KIND_BOOKMARKS,
        tags: (latest?.tags ?? []).filter(keep),
        content: await nip44EncryptToSelf(JSON.stringify(nextPrivate)),
      });
    },
    onMutate: async ({ id, add }) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<string[]>(key);
      const base = previous ?? [];
      queryClient.setQueryData<string[]>(
        key,
        add
          ? [...base.filter((v) => v !== id), id]
          : base.filter((v) => v !== id),
      );
      return { previous };
    },
    onError: (_error, _vars, context) =>
      queryClient.setQueryData(key, context?.previous),
    onSettled: () => {
      if (!isFeedPreview()) {
        queryClient.invalidateQueries({ queryKey: ["feed"] });
      }
    },
  });
}

export type ProfilePatch = Partial<
  Record<
    "display_name" | "name" | "about" | "picture" | "banner" | "website",
    string
  >
>;

/** Merge edited fields into the viewer's kind 0, preserving fields we don't edit. */
export function useUpdateProfile(viewer: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (patch: ProfilePatch) => {
      if (isFeedPreview()) throw new Error("Editing is disabled in preview.");
      if (!viewer) throw new Error("Sign in to do that.");
      const latest = await fetchLatest(KIND_PROFILE, viewer);
      let existing: Record<string, unknown> = {};
      try {
        const parsed = latest ? JSON.parse(latest.content) : {};
        if (parsed && typeof parsed === "object") existing = parsed;
      } catch {
        // Unreadable profile JSON — start from the edited fields only.
      }
      const merged: Record<string, unknown> = { ...existing };
      for (const [field, value] of Object.entries(patch)) {
        const trimmed = value?.trim();
        if (trimmed) merged[field] = trimmed;
        else delete merged[field];
      }
      return publishEvent({
        kind: KIND_PROFILE,
        tags: latest?.tags ?? [],
        content: JSON.stringify(merged),
      });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["feed"] }),
  });
}

/** Ids of notes a user has liked (their kind 7 `e` tags), newest first. */
export function useLikedIds(pubkey: string) {
  return useQuery({
    queryKey: ["feed", "liked-ids", pubkey],
    staleTime: 30_000,
    queryFn: async () => {
      const events = await fetchEvents({
        kinds: [KIND_REACTION],
        authors: [pubkey],
        limit: 100,
      });
      return [
        ...new Set(
          events
            .filter((e) => e.content === "+" || e.content === "")
            .sort((a, b) => b.created_at - a.created_at)
            .flatMap((e) => tagValues(e.tags, "e").slice(-1)),
        ),
      ];
    },
  });
}
