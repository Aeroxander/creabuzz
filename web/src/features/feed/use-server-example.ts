import { useQuery } from "@tanstack/react-query";

import { relayHttpBaseUrl } from "@/shared/lib/relay-url";
import { timedFetchStreamed } from "@/shared/lib/timed-fetch";

import { serverExampleSlug } from "./lib/server-example";

/**
 * The example project the server names for itself (`lib/server-example.ts`), as a scorecard address without its
 * `/p/`. Null while the read is pending, when it failed, or when the server names none: then nothing is offered.
 * Asked only when `wanted`, and of the server's public information document, which needs no account.
 */
export function useServerExample(wanted: boolean): string | null {
  const url = relayHttpBaseUrl();
  const { data } = useQuery({
    queryKey: ["server-example", url],
    enabled: wanted,
    staleTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: async ({ signal }): Promise<string | null> => {
      const response = await timedFetchStreamed(`${url}/info`, {
        headers: { Accept: "application/nostr+json" },
        signal,
      });
      if (!response.ok) return null;
      return serverExampleSlug(await response.json().catch(() => null));
    },
  });
  return data ?? null;
}
