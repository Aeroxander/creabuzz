/**
 * A post that another post quotes, as a small card that opens it: who wrote it, when, and its words. It follows the same
 * rule as every list (a post by someone the reader hid, or one they reported, is not shown), and says plainly when the post
 * is gone: the server no longer returns a post its author deleted, so a quote of it never keeps showing it.
 */
import { relativeTime } from "@creaton/core/client/relative-time.ts";
import { quotedPostState } from "@creaton/core/social/timeline.ts";
import { postParts } from "@creaton/core/social/post-compose.ts";
import { KIND_TEXT_NOTE } from "@creaton/core/kinds.ts";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { isServerPicture } from "../../lib/server-picture";
import { nameOf, useProfiles } from "../../lib/profiles";
import { read } from "../../lib/relay";
import { useHidden } from "../safety/use-hidden";
import { whyHidden } from "../safety/visible";
import {
  QUOTED_HIDDEN,
  QUOTED_LOADING,
  QUOTED_REMOVED,
  QUOTED_UNAVAILABLE,
} from "./post-words";

function useQuoted(id: string) {
  return useQuery({
    queryKey: ["posts", "quoted", id],
    staleTime: 30_000,
    queryFn: async () =>
      (await read({ ids: [id], kinds: [KIND_TEXT_NOTE], limit: 1 }))[0] ?? null,
  });
}

export function QuotedPost({ id }: { id: string }) {
  const quoted = useQuoted(id);
  const event = quoted.data ?? null;
  const profiles = useProfiles(event ? [event.pubkey] : []).data;
  const { rules, ready } = useHidden();
  const words = useMemo(
    () => (event ? postParts(event, isServerPicture).text : ""),
    [event],
  );
  const state = quotedPostState({
    found: event !== null,
    isPending: quoted.isPending,
    isError: quoted.isError,
  });
  const why = event ? whyHidden(event, rules) : null;
  if (!event || state !== "shown" || !ready || why !== null) {
    const text =
      why === "muted" || why === "reported"
        ? QUOTED_HIDDEN
        : why === "room"
          ? QUOTED_UNAVAILABLE
          : state === "loading" || !ready
            ? QUOTED_LOADING
            : state === "removed"
              ? QUOTED_REMOVED
              : QUOTED_UNAVAILABLE;
    return (
      <p
        className="plain rounded-xl p-3 text-sm text-muted"
        data-testid="quoted-post-missing"
      >
        {text}
      </p>
    );
  }
  return (
    <Link
      className="plain relative z-10 flex flex-col gap-1 rounded-xl p-3 text-sm"
      data-testid="quoted-post"
      params={{ id }}
      to="/post/$id"
    >
      <span className="flex items-baseline gap-2">
        <span className="truncate font-semibold">
          {nameOf(profiles, event.pubkey)}
        </span>
        <span className="shrink-0 text-xs text-muted">
          {relativeTime(event.created_at)}
        </span>
      </span>
      <span className="line-clamp-4 whitespace-pre-wrap break-words">
        {words || "Picture"}
      </span>
    </Link>
  );
}
