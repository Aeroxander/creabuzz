/**
 * What Shares earned on a test network are: test records that stay there. Said where people start a contributor project
 * and where they see who earned what, so nobody works for Sepolia Shares expecting them to carry over.
 *
 * Only for networks the app knows to be test networks (Sepolia, Base Sepolia, a local chain): a chain it does not know
 * could be a real one, so it says nothing there rather than guess.
 *
 * Alias-free on purpose: `test-network.test.mjs` drives it under `node --test`.
 */

import { chainPresetByChainId, LOCAL_ANVIL_PRESET } from "../chain-config.ts";

/**
 * A network's name for main copy: its everyday name (Sepolia, Base), "the test network" for a chain run on this
 * computer (its tool's name means nothing to people), or "another network" for one the app does not know.
 */
export function plainNetworkName(
  chainId: number | string | null | undefined,
): string {
  if (chainId === null || chainId === undefined || chainId === "")
    return "another network";
  const preset = chainPresetByChainId(chainId);
  if (!preset) return "another network";
  return preset.chainId === LOCAL_ANVIL_PRESET.chainId
    ? "the test network"
    : preset.label;
}

/** The sentence for `chainId`, or null when it is a real network or one the app does not know. */
export function testRecordsNotice(
  chainId: number | string | null | undefined,
): string | null {
  if (chainId === null || chainId === undefined || chainId === "") return null;
  const preset = chainPresetByChainId(chainId);
  if (!preset || preset.mainnet) return null;
  const name = plainNetworkName(chainId);
  return `${name === "the test network" ? "This" : name} is a test network. Shares earned here are test records: they will not move to a real network automatically.`;
}
