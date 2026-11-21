import { relayWsUrl } from "@creaton/core/client/relay-url.ts";
import { useQuery } from "@tanstack/react-query";
import { useAccount } from "../../lib/account";
import { read } from "../../lib/relay";
import type { Project } from "../project/project-record";
import { type BrainFile, readBrain } from "./brain-read";
import {
  type BrainRepo,
  brainRepoId,
  findBrainRepo,
  KIND_REPO_ANNOUNCEMENT,
} from "./brain-repo";

/**
 * Whether the project has a brain repository: one small read of the founder's repository records, nothing of the
 * files. Null is "none yet".
 */
export function useBrainRepo(project: Project) {
  return useQuery({
    queryKey: ["brain-repo", relayWsUrl(), project.coordinate],
    queryFn: async (): Promise<BrainRepo | null> =>
      findBrainRepo(
        await read({
          kinds: [KIND_REPO_ANNOUNCEMENT],
          authors: [project.author],
          "#d": [brainRepoId(project.id)],
          limit: 5,
        }),
        project.author,
        project.id,
      ),
    staleTime: 60_000,
  });
}

/**
 * The brain's files. Only asked for once `enabled` (the person opened the notes), never kept after they are closed
 * (`gcTime: 0`: a private brain does not stay in memory), and never retried by itself: a refusal is told, and the
 * person presses Try again.
 */
export function useBrainFiles(repo: BrainRepo, enabled: boolean) {
  const { pubkey } = useAccount();
  return useQuery<BrainFile[]>({
    queryKey: ["brain-files", relayWsUrl(), repo.owner, repo.id, pubkey],
    queryFn: async () => {
      const { gitTools } = await import("./brain-git");
      return readBrain(gitTools, repo);
    },
    enabled: enabled && Boolean(pubkey),
    gcTime: 0,
    staleTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
}
