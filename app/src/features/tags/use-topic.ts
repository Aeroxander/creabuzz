import { KIND_TEXT_NOTE } from "@creaton/core/kinds.ts";
import { inAnyRoom } from "@creaton/core/social/feed/feed-events.ts";
import { useQuery } from "@tanstack/react-query";
import { read } from "../../lib/relay";
import type { SignedEvent } from "../posts/use-posts";
import { TOPIC_LIMIT } from "./tag-words";

/** The newest posts (and answers) under a topic, by their `t` tag. Room posts and hidden people are left out by the page. */
export function useTopic(tag: string) {
  return useQuery({
    queryKey: ["posts", "topic", tag],
    staleTime: 15_000,
    queryFn: async () =>
      (
        (await read({
          kinds: [KIND_TEXT_NOTE],
          "#t": [tag],
          limit: TOPIC_LIMIT,
        })) as SignedEvent[]
      )
        // Asked for by tag, checked again here: only a post that carries the topic belongs on its page, and a holder
        // room's posts are read in that room only.
        .filter(
          (event) =>
            !inAnyRoom(event) &&
            event.tags.some((t) => t[0] === "t" && t[1]?.toLowerCase() === tag),
        )
        .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? 1 : -1)),
  });
}
