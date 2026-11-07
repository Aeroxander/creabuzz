import type { Launch } from "./models";
import { useChainSend } from "./use-chain-send";

function chainNumber(value: string | null): number | null {
  if (value === null) return null;
  const n = Number(value.trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * `useChainSend` for a screen that acts on a DAO: on the project's own network, re-reading everything under the DAO's
 * work queries and the challenge queries once a step landed. Screens that act on a milestone lock read it under their
 * own key.
 */
export function useWalletSend(launch: Launch, dao: string) {
  return useChainSend(
    chainNumber(launch.record.chainId),
    ["launchpad", "work", dao],
    ["launchpad", "challenge"],
  );
}
