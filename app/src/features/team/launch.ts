/**
 * Putting a project on the chain from its page: where the Launcher is, the name and ticker its Shares get, and the two
 * writes it takes (the launch on the network, then the founder's own record naming it).
 *
 * The link from the record to its launch (the record's `chain-key` tag, `@creaton/core/launchpad/project-chain.ts`) is
 * the lead's proposal from milestone 6 part 2 and still waits for the owner's decision; this file writes exactly that
 * tag and nothing the decision could change elsewhere. Pure, apart from reading the build's settings.
 */
export {
  launchIdentity,
  recordWithLaunch,
  sharesName,
  sharesSymbol,
} from "../launch/launch-ids";

/** The Launcher and its network: the build's own (`VITE_CREATON_LAUNCHER`, `VITE_CREATON_CHAIN_ID`), or null. */
export function builtLauncher(
  env: Record<string, unknown> = import.meta.env,
): { launcher: string; chainId: number } | null {
  const launcher = env.VITE_CREATON_LAUNCHER;
  const chain = Number(env.VITE_CREATON_CHAIN_ID);
  if (typeof launcher !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(launcher))
    return null;
  if (!Number.isSafeInteger(chain) || chain <= 0) return null;
  return { launcher: launcher.toLowerCase(), chainId: chain };
}

/** The Launcher a server-signed record of numbers names (its `launcher` and `chain` tags), or null. */
export function launcherFromRecord(
  tags: readonly (readonly string[])[],
): { launcher: string; chainId: number } | null {
  const launcher = tags.find((t) => t[0] === "launcher")?.[1];
  const chain = Number(tags.find((t) => t[0] === "chain")?.[1]);
  if (!launcher || !/^0x[0-9a-fA-F]{40}$/.test(launcher)) return null;
  if (!Number.isSafeInteger(chain) || chain <= 0) return null;
  return { launcher: launcher.toLowerCase(), chainId: chain };
}
