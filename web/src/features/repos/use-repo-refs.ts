import { useQuery } from "@tanstack/react-query";
import { queryEvents } from "@/shared/lib/nostr-client";
import { relayHttpUrl, relayWsUrl } from "@/shared/lib/relay-url";
import { timedFetchStreamed } from "@/shared/lib/timed-fetch";
import {
  fetchRepoRefsFrom,
  repoRefsQueryKey,
  type RepoRefs,
} from "./lib/repo-refs";

export type { RepoRefs } from "./lib/repo-refs";

/** The server's public information document; a failed read throws so it is never mistaken for "no key". */
async function fetchServerInfo(wsUrl: string): Promise<unknown> {
  const response = await timedFetchStreamed(`${relayHttpUrl(wsUrl)}/info`, {
    headers: { Accept: "application/nostr+json" },
  });
  if (!response.ok) {
    throw new Error(`the server answered ${response.status}`);
  }
  return response.json();
}

const mockRefs: RepoRefs = {
  branches: ["main"],
  tags: ["v0.1.0"],
  head: { ref: "main", sha: "a".repeat(40) },
};

/**
 * Branches, tags and HEAD of a repository, believed only from the record the community's own server signed (see
 * `lib/repo-refs.ts`). The cache key carries the server address, and the server's key is read from that same address
 * inside the same fetch, so switching community never reuses the previous community's key or refs.
 */
export function useRepoRefs(repoId: string, { preview = false } = {}) {
  const wsUrl = relayWsUrl();
  return useQuery({
    queryKey: preview
      ? ["repo-refs", "mock", repoId]
      : repoRefsQueryKey(wsUrl, repoId),
    queryFn: preview
      ? async () => mockRefs
      : () =>
          fetchRepoRefsFrom(wsUrl, repoId, {
            fetchInfo: fetchServerInfo,
            queryEvents: (url, filter) => queryEvents(url, filter),
          }),
    initialData: preview ? mockRefs : undefined,
    staleTime: 60_000,
    retry: (failures, error) =>
      error.name !== "RepoSignerUnknownError" && failures < 2,
  });
}
