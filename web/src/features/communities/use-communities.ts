import { useQuery } from "@tanstack/react-query";
import { friendlyRelayError } from "@/shared/lib/relay-errors";

import { relayHttpBaseUrl } from "@/shared/lib/relay-url";

/** One community as listed by the relay's unauthenticated `GET /communities`. */
export interface CommunityDirectoryEntry {
  host: string;
  name: string;
  description: string;
  icon?: string | null;
  member_count: number;
  archived: boolean;
}

export interface CommunityDirectory {
  communities: CommunityDirectoryEntry[];
  /** False when the server does not publish a public directory (HTTP 404). */
  available: boolean;
}

async function fetchCommunityDirectory(): Promise<CommunityDirectory> {
  const response = await fetch(`${relayHttpBaseUrl()}/communities`);
  // Directory publication is opt-in. A 404 says nothing about whether the
  // connected community exists or whether its channel reads work.
  if (response.status === 404) {
    return { communities: [], available: false };
  }
  if (!response.ok) {
    throw new Error(
      friendlyRelayError(
        String(
          `Community directory unavailable (relay responded ${response.status})`,
        ),
      ),
    );
  }
  const directory = (await response.json()) as CommunityDirectory;
  return { ...directory, available: true };
}

/**
 * Public, unauthenticated community directory for the discovery landing page.
 * An unpublished directory is distinct from a failed read. The connected
 * community remains reachable in either case.
 */
export function useCommunities() {
  return useQuery({
    queryKey: ["communities"],
    queryFn: fetchCommunityDirectory,
    staleTime: 60_000,
    retry: 1,
    refetchOnWindowFocus: false,
  });
}
