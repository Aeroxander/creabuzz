import { KIND_TEXT_NOTE } from "@creaton/core/kinds.ts";
import { useQuery } from "@tanstack/react-query";
import { read } from "../../lib/relay";
import type { SignedEvent } from "../posts/use-posts";

/** How many saved posts are read and shown (the newest saves); a person with more is told so. */
export const SAVED_SHOWN = 100;

/**
 * The posts behind the newest saved ids, in the order saved (newest first). A post the server no longer returns (its author
 * removed it) is simply not there; the caller counts the difference.
 */
export function useSavedPosts(ids: readonly string[]) {
  const wanted = ids.slice(0, SAVED_SHOWN);
  return useQuery({
    queryKey: ["posts", "saved", ...wanted],
    enabled: wanted.length > 0,
    staleTime: 15_000,
    queryFn: async (): Promise<SignedEvent[]> => {
      const events = (await read({
        ids: wanted,
        kinds: [KIND_TEXT_NOTE],
        limit: wanted.length,
      })) as SignedEvent[];
      const byId = new Map(events.map((event) => [event.id, event]));
      return wanted.flatMap((id) => {
        const event = byId.get(id);
        return event?.kind === KIND_TEXT_NOTE ? [event] : [];
      });
    },
  });
}
