/**
 * Whether this build has anything to do with money or Shares at all, and when a project is offered Shares.
 *
 * A server whose build offers no sales, keeps investing off and names no contributor kit cannot make Shares, hold them
 * or pay anyone. Cards that only make sense with one of those (the Shares someone holds, a payment wallet, a score
 * beside a record that says nobody is scored) stay off its pages. A build with any one of the three shows them as
 * before. Legal text is not gated by this.
 *
 * Alias-free on purpose: `money-offered.test.mjs` drives it under `node --test`.
 */

import { type ChainEnv, namesAnyAddress, viteEnv } from "../chain-config.ts";
import { investingOffered } from "./investing-offered.ts";
import { raisesOffered } from "./raises-offered.ts";

/** True when the build names a contributor kit on some network: the one thing that can set up Shares for helpers. */
export function contributorKitNamed(
  env: ChainEnv | undefined = viteEnv(),
): boolean {
  return (
    namesAnyAddress(env?.VITE_CONTRIBUTOR_KITS) ||
    (investingOffered(env) && namesAnyAddress(env?.VITE_CONTRIBUTOR_KIT_V3))
  );
}

/** False only for a build with no sales, investing off and no contributor kit: a server with no money on it. */
export function moneyOffered(env: ChainEnv | undefined = viteEnv()): boolean {
  return (
    raisesOffered(env) || investingOffered(env) || contributorKitNamed(env)
  );
}

/**
 * Whether a project's next steps offer "Set up Shares for people who help". Shares thank people whose work was
 * accepted, so the offer waits for the first piece of accepted work, and it is never made where the build has no kit to
 * set them up with. `acceptedWork` is how many of the project's tasks someone other than the person who did the work
 * accepted (`acceptedByOthers`); null while that is still read. Work a founder did alone and checked themself is
 * never in that number: {@link sharesAcceptedWork} is the one way to count it.
 */
export function sharesSetupOffered(input: {
  kitNamed: boolean;
  acceptedWork: number | null;
}): boolean {
  return input.kitNamed && (input.acceptedWork ?? 0) >= 1;
}

/**
 * How many of a project's tasks count toward setting up Shares: the confirmed ones that someone other than the
 * person who did the work accepted. A founder's own check of their own work (`selfChecked`) never counts.
 */
export function sharesAcceptedWork(
  tasks: readonly { state: string; selfChecked: boolean }[],
): number {
  return tasks.filter((task) => task.state === "confirmed" && !task.selfChecked)
    .length;
}
