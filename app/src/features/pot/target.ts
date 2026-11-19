/**
 * Where a project's money lives, as far as a take-out or a look at what a person holds needs: the chain, the Treasury, the
 * two Share tokens and the Vester. It comes from the server's record when there is one and from the Launcher when there
 * is not, so a person can always reach their Shares.
 */
import { mustSayPlayMoney } from "@creaton/core/pot/network.ts";
import type { ProjectNumbers } from "../money/numbers";
import { recordFitsBuild } from "./use-pot";

export interface MoneyTarget {
  chainId: number;
  /** The project's chain key (what history is kept under). */
  key: string;
  treasury: string;
  shares: string;
  team: string;
  vester: string;
  /** The dollar's address when it is known (the record names it; the Launcher fallback reads it). */
  dollar: string | null;
  /** The dollars here are play money (always, until real money is switched on). */
  playMoney: boolean;
}

export function targetOf(numbers: ProjectNumbers): MoneyTarget {
  return {
    chainId: numbers.chainId,
    key: numbers.key,
    treasury: numbers.contracts.treasury,
    shares: numbers.contracts.shares,
    team: numbers.contracts.team,
    vester: numbers.contracts.vester,
    // A dollar this build does not know is not offered a faucet or a balance line.
    dollar: recordFitsBuild(numbers) ? numbers.contracts.dollar : null,
    playMoney: mustSayPlayMoney(numbers.playMoney),
  };
}
