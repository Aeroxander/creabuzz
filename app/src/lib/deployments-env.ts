/**
 * The network a build is for, from the deployments file the deploy script wrote (`contracts/pot/deployments/pot-<chain>.json`,
 * named with `CREATON_DEPLOYMENTS_FILE` when the app is built). It fills in `VITE_CREATON_CHAIN_ID`,
 * `VITE_CREATON_LAUNCHER` and `VITE_CREATON_DOLLAR` where the build's own environment names nothing: a value set by hand
 * always wins. A file that is named but cannot be read, or is not a deployments file, stops the build, loudly: a build
 * that quietly points at no network would show no money at all.
 */
import { envFromDeployments } from "@creaton/core/pot/network.ts";

/** The variables `file`'s text gives, minus any that `env` already has. Throws, naming the file, when it is not usable. */
export function deploymentsEnv(
  file: string,
  text: string,
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${file} is not JSON: it cannot name the network.`);
  }
  const fromFile = envFromDeployments(json);
  if (Object.keys(fromFile).length === 0)
    throw new Error(
      `${file} is not a deployments file (it needs a chain id, a launcher and a dollar).`,
    );
  return Object.fromEntries(
    Object.entries(fromFile).filter(([name]) => !env[name]),
  );
}
