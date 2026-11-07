import { useMemo } from "react";

import { listedHere } from "../launchpad/lib/contributor-only";
import { raisesOffered } from "../launchpad/lib/raises-offered";
import { useLaunches } from "../launchpad/use-launches";
import { tickerOwners } from "./lib/cashtag";

/**
 * The launch each claimed ticker belongs to. Read from the launch directory the app already loads (shared cache), so
 * a post with a `$TICKER` costs no request of its own, and one that is still loading or failed shows plain text.
 *
 * Only launches this build lists can own a ticker: a contributor-only build leaves raises out, so their tickers stay
 * plain text there, as in every other listing. Such a build also shows no price beside a ticker (bids and a sale's
 * starting price are sale words), so the chip is given neither.
 *
 * Two choices this makes on purpose:
 * - The price stays out because `cashtagPrice` reads only `bids` and `floorPrice`. If it ever gains another source,
 *   that source must be blanked here too (or the chip told not to show a price), or prices return in the pilot.
 * - Raises are left out before `tickerOwners` picks an owner, so in a contributor-only build a listed project can own a
 *   ticker that an earlier, hidden raise also claimed. The pilot shows only what it lists, so that project's link wins.
 */
export function useCashtagOwners() {
  const { data } = useLaunches();
  return useMemo(() => {
    const raises = raisesOffered();
    const listed = (data ?? [])
      .filter((launch) => listedHere(launch.record, raises))
      .map((launch) =>
        raises
          ? launch
          : {
              ...launch,
              bids: [],
              record: { ...launch.record, floorPrice: null },
            },
      );
    return tickerOwners(listed);
  }, [data]);
}
