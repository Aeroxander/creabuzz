/**
 * Whether the app offers a person a place to write, and what it says when it does not (plan sections 4.2 and 4.7). The server
 * decides who may write, from the network and never from a person's word; this is the app's reading of the same rule, so it
 * only offers what the server is likely to accept, and the server's own refusal still wins. Pure: every input is given.
 *
 * The order is the server's: a wallet link first, then holding, then the unit after taking out, then the team's stop.
 */
import type { TeamWallet } from "../team/use-wallets";

/** A seat needs at least 0.001 of a Share, in Shares and not in dollars, so a fall in the price never shuts a holder out. */
export const ROOM_MIN_SHARES = 10n ** 15n;
/** A link whose proof ends within this many seconds is asked to be renewed. */
export const RENEW_WITHIN = 30 * 86_400;

export interface StandingInput {
  /** The signed-in account, or null. */
  me: string | null;
  /** What the account's wallets hold of this project's Shares and Team Shares: undefined while read, null when it cannot be read. */
  holds: { shares: bigint; team: bigint } | null | undefined;
  /** A Team Share grant of one of the account's wallets still has something to claim. */
  claimable: boolean;
  /** When the account last took its money out of this project (this device's own record), or null. */
  tookOutAt: number | null;
  /** The project's time unit in seconds. */
  unit: number;
  now: number;
  /** The account's wallet link, or undefined while it is read. */
  link: TeamWallet | undefined;
  /** The server says it cannot check a phone account's link, and the account is one. */
  phoneUnsupported: boolean;
  /** The team's stop on this account (or a wallet it uses), and when it ends, or null. */
  mutedUntil: number | null;
}

export type Standing =
  | { kind: "signed-out" }
  | { kind: "checking" }
  | { kind: "not-holding" }
  | { kind: "phone-unsupported" }
  | { kind: "needs-link"; expired: boolean }
  | { kind: "muted"; until: number }
  | {
      kind: "write";
      /** The unit after taking out: when it ends, or null for a person who holds. */
      graceEndsAt: number | null;
      /** When the wallet link ends, when that is soon enough to ask for a new one. */
      renewBy: number | null;
    };

/** Whether the account holds now: Shares or Team Shares at the floor, or Team Shares still to claim. */
function holdsNow(input: StandingInput): boolean {
  const { holds } = input;
  if (input.claimable) return true;
  return Boolean(
    holds && (holds.shares >= ROOM_MIN_SHARES || holds.team >= ROOM_MIN_SHARES),
  );
}

/** When the unit after taking out ends, or null when the account did not take out within it. */
export function graceEnd(input: StandingInput): number | null {
  if (input.tookOutAt === null || input.unit <= 0) return null;
  const ends = input.tookOutAt + input.unit;
  return ends > input.now ? ends : null;
}

export function standingOf(input: StandingInput): Standing {
  if (!input.me) return { kind: "signed-out" };
  if (input.holds === undefined || input.link === undefined)
    return { kind: "checking" };
  const grace = holdsNow(input) ? null : graceEnd(input);
  if (!holdsNow(input) && grace === null) return { kind: "not-holding" };
  if (input.phoneUnsupported) return { kind: "phone-unsupported" };
  // A link that cannot be checked here (the network cannot be asked) is not a link the server will see either.
  if (input.link.state !== "linked")
    return { kind: "needs-link", expired: input.link.state === "expired" };
  if (input.mutedUntil !== null && input.mutedUntil > input.now)
    return { kind: "muted", until: input.mutedUntil };
  const renew = input.link.expires - input.now < RENEW_WITHIN;
  return {
    kind: "write",
    graceEndsAt: grace,
    renewBy: renew ? input.link.expires : null,
  };
}
