/**
 * Which pages and panels this build serves. The hosted pilot is a contributor-only build (`VITE_CONTRIBUTOR_ONLY=1`):
 * people, communities and contributor projects. Pages that belong to other builds (a court on a test network, the
 * passkey prototype, the desktop hand-off, the Projects board, code browsing, AI helpers) send an address typed by hand
 * somewhere useful instead of opening a page that cannot work there.
 *
 * Alias-free on purpose: `build-gates.test.mjs` drives it under `node --test`. Every function takes the build's settings
 * (and, where it matters, whether this is a dev server) so the test drives the same rule the routes use.
 */

import {
  type ChainEnv,
  courtAddress,
  defaultChainPreset,
  isDevBuild,
  viteEnv,
} from "../../features/launchpad/chain-config.ts";
import { raisesOffered } from "../../features/launchpad/lib/raises-offered.ts";

/** The settings these gates read, on top of the chain's. */
export type GateEnv = ChainEnv & {
  /** "1" in a build that offers the desktop app. */
  VITE_DESKTOP_APP?: string;
  /** "1" serves the passkey prototype page in any build (a test build of the hosted image, say). */
  VITE_IDENTITY_DEMO?: string;
};

/** The court page: only where the default chain names a court. */
export function courtOffered(
  given: GateEnv | undefined = viteEnv(),
  dev: boolean = isDevBuild(),
): boolean {
  return courtAddress(defaultChainPreset(given, dev).chainId, given) !== null;
}

/**
 * The passkey prototype (`/identity-demo`). It can send a sponsored payment and remove this browser's passkey, so the
 * hosted build never serves it; a dev server, a build that asks for it, and the developer and test builds (the ones
 * that offer raises: the passkey specs run there) do.
 */
export function identityDemoOffered(
  given: GateEnv | undefined = viteEnv(),
  dev: boolean = isDevBuild(),
): boolean {
  return (
    dev || given?.VITE_IDENTITY_DEMO?.trim() === "1" || raisesOffered(given)
  );
}

/** Handing an account to the desktop app: only in a build that offers the desktop app. */
export function linkDeviceOffered(
  given: GateEnv | undefined = viteEnv(),
): boolean {
  return given?.VITE_DESKTOP_APP?.trim() === "1";
}

/**
 * The Projects board (`/projects`), code browsing (`/repos`), the sale list (`/launchpad` without a project), AI helpers
 * and the helper budgets on Org: not in a contributor-only build. A pitch there would hand out Shares outside reviewed
 * work, and the pilot server runs no AI service.
 */
export function beyondContributorProjects(
  given: GateEnv | undefined = viteEnv(),
): boolean {
  return raisesOffered(given);
}
