import { useState, type Dispatch, type SetStateAction } from "react";

import { allocationForMode, type SupplyAllocation } from "../../lib/allocation";

export type TokenMode = "mint" | "import" | "dao";

/**
 * Which token a launch form is for, and the supply split that goes with it: choosing another kind swaps an untouched
 * standard split for that kind's standard one, and leaves a split the founder edited alone.
 */
export function useTokenMode(
  initial: TokenMode,
  setAllocation: Dispatch<SetStateAction<SupplyAllocation>>,
): [TokenMode, (next: TokenMode) => void] {
  const [mode, setMode] = useState<TokenMode>(initial);
  return [
    mode,
    (next) => {
      setMode(next);
      setAllocation((previous) => allocationForMode(previous, next === "dao"));
    },
  ];
}
