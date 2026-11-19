import { type PotNetwork, parsePotNetwork } from "@creaton/core/pot/network.ts";

/**
 * The test network this build is for: its chain, its Launcher and its dollar, from the build's environment
 * (`VITE_CREATON_*`, or the deployments file named with `CREATON_DEPLOYMENTS_FILE` at build time). Null when the build names
 * none: then no money step is offered. Never typed into a component.
 */
export function potNetwork(
  env: Readonly<Record<string, unknown>> = import.meta.env,
): PotNetwork | null {
  return parsePotNetwork(env);
}
