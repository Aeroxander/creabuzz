import { useQuery } from "@tanstack/react-query";

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
}

async function fetchCommunityDirectory(): Promise<CommunityDirectory> {
  const response = await fetch(`${relayHttpBaseUrl()}/communities`);
  if (!response.ok) {
    throw new Error(
      `Community directory unavailable (relay responded ${response.status})`,
    );
  }
  return (await response.json()) as CommunityDirectory;
}

/**
 * Public, unauthenticated community directory for the discovery landing page.
 * Fails fast: on any error the caller falls back to the repository browser so
 * older relays without the endpoint still work.
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
