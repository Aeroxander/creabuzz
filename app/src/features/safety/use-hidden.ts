/**
 * What this reader hides, as one answer for a list of posts: the people they hid and the posts they reported, whether the
 * hidden list has been read yet, and whether it could not be opened. A list waits for `ready` before it draws, so a hidden
 * person's post is never shown for a moment and then taken away; when the list cannot be opened (a locked passkey) the list
 * draws and says so, as the room does.
 */
import { useMemo } from "react";
import { useAccount } from "../../lib/account";
import { useMutes } from "../../lib/mutes";
import { type HideRules, visiblePosts, whyHidden } from "./visible";
import { useReported } from "./reported";

export function useHidden() {
  const { pubkey } = useAccount();
  const mutes = useMutes();
  const { reported } = useReported();
  const rules = useMemo<HideRules>(
    () => ({ muted: mutes.muted, reported }),
    [mutes.muted, reported],
  );
  return {
    rules,
    /** Someone without an account hides nobody; otherwise the hidden people have been read. */
    ready: pubkey === null || mutes.ready || mutes.failed,
    /** The hidden people could not be opened, so someone hidden may show. */
    unknown: mutes.failed,
  };
}

/** `posts` as this reader sees them. */
export function useVisiblePosts<
  T extends { id: string; pubkey: string; tags: readonly string[][] },
>(posts: readonly T[] | undefined) {
  const hidden = useHidden();
  const result = useMemo(
    () => visiblePosts(posts ?? [], hidden.rules),
    [posts, hidden.rules],
  );
  return { ...result, ready: hidden.ready, unknown: hidden.unknown };
}

/**
 * `rows` (posts, and posts someone reposted) as this reader sees them: a post is left out by the same rule as everywhere,
 * and so is a repost by someone the reader hid, whoever wrote the post.
 */
export function useVisibleRows<
  T extends {
    event: { id: string; pubkey: string; tags: readonly string[][] };
    repostedBy?: { pubkey: string };
  },
>(rows: readonly T[]) {
  const hidden = useHidden();
  const shown = useMemo(
    () =>
      rows.filter(
        (row) =>
          whyHidden(row.event, hidden.rules) === null &&
          !(
            row.repostedBy &&
            hidden.rules.muted.has(row.repostedBy.pubkey.toLowerCase())
          ),
      ),
    [rows, hidden.rules],
  );
  return { shown, ready: hidden.ready, unknown: hidden.unknown };
}
