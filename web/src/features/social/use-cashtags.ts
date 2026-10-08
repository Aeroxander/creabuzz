import { useMemo } from "react";

import { useLaunches } from "../launchpad/use-launches";
import { tickerOwners } from "./lib/cashtag";

/**
 * The launch each claimed ticker belongs to. Read from the launch directory the app already loads (shared cache), so
 * a post with a `$TICKER` costs no request of its own, and one that is still loading or failed shows plain text.
 */
export function useCashtagOwners() {
  const { data } = useLaunches();
  return useMemo(() => tickerOwners(data ?? []), [data]);
}
