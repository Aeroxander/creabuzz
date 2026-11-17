import { KIND_LAUNCH_RECORD } from "@creaton/core/kinds.ts";
import { useQuery } from "@tanstack/react-query";
import { read } from "../../lib/relay";
import { latestProjects } from "../project/project-record";

/** The projects a person started (their records), newest first. */
export function useProjectsBy(author: string | null) {
  return useQuery({
    queryKey: ["projects-by", author],
    enabled: author !== null,
    staleTime: 30_000,
    queryFn: async () =>
      latestProjects(
        await read({
          kinds: [KIND_LAUNCH_RECORD],
          authors: [author as string],
          limit: 100,
        }),
      ),
  });
}
