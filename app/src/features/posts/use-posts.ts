import type { LaunchRef } from "@creaton/core/social/feed/feed-events.ts";
import { buildComposedPost } from "@creaton/core/social/post-compose.ts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { publishAsUser } from "../../lib/relay";

/** Write a post: words and the project it is about (the writing box). */
export function usePublishComposed() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { text: string; launch?: LaunchRef | null }) =>
      publishAsUser(
        buildComposedPost(input),
        "Your post was not sent. Try again.",
      ),
    onSettled: () => {
      // The project's updates list reads posts about it.
      void queryClient.invalidateQueries({ queryKey: ["project", "activity"] });
    },
  });
}
