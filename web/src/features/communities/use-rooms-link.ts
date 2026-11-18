import { relayWsUrl } from "@/shared/lib/relay-url";

import { onlyCommunityHost } from "./lib/community-label";
import { useCommunities } from "./use-communities";
import { useSelfServe } from "./use-self-serve";

/**
 * Where "Rooms" leads: straight into the one community when this server has only one (a directory of one is a page
 * nobody needs), otherwise to the list of them.
 */
export function useRoomsLink():
  | { to: "/c/$host"; params: { host: string } }
  | { to: "/c" } {
  const selfServe = useSelfServe();
  const directory = useCommunities();
  let host: string | null = null;
  try {
    host = onlyCommunityHost(
      selfServe.data?.enabled,
      directory.data?.communities,
      new URL(relayWsUrl()).host,
    );
  } catch {
    host = null;
  }
  return host ? { to: "/c/$host", params: { host } } : { to: "/c" };
}
