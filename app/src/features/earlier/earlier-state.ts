/**
 * What the earlier-backers page says about one line of the list, decided from what the contract answers for that line
 * and nothing else. Pure: the page only draws it. The contract is the source of truth for every rule here
 * (`contracts/next/src/EarlierBackers.sol`); the page never decides a rule the contract would also check, it only avoids
 * offering a press that would be refused.
 */
import {
  CLAIM_CHALLENGE_SECONDS,
  CLAIM_REPLACE_WAIT_SECONDS,
  type ClaimEntry,
} from "@creaton/core/launchpad/earlier-claim.ts";

export interface ClaimFacts {
  /** The holder in the link, lower case. */
  linkHolder: string;
  /** Whether the link's own data hashes to the line's stored leaf. */
  leafMatches: boolean;
  /** The wallet this site may see, lower case, or null. */
  me: string | null;
  entry: ClaimEntry;
  /** Shares released and not yet delivered for this line. */
  due: bigint;
  closed: boolean;
  /** Whether the Shares for the whole list are in place (the contract refuses agreements before). */
  funded: boolean;
  /** Seconds since 1970. */
  now: number;
}

export type ClaimView =
  /** The link's data does not hash to the stored leaf: nothing is offered. */
  | { kind: "not-on-list" }
  /** The line was agreed to; delivery follows the clock. */
  | {
      kind: "agreed";
      receiver: string | null;
      amount: bigint;
      taken: bigint;
      due: bigint;
      /** Seconds: the first moment anyone may send the Shares. */
      deliverFrom: number;
      canDeliver: boolean;
    }
  | { kind: "closed" }
  | { kind: "not-funded" }
  /** The line is for another wallet than the one connected (or none is connected). */
  | { kind: "wrong-wallet"; holder: string; connected: string | null }
  | {
      kind: "open";
      /** A replacement wallet the keeper proposed, while it waits. */
      replacement: {
        applyAt: number;
        /** The holder's one veto is still theirs to use. */
        canVeto: boolean;
      } | null;
    };

/** The holder of the line now: the replacement once one applied, else the one in the link. */
export function holderOf(facts: Pick<ClaimFacts, "linkHolder" | "entry">) {
  return facts.entry.holder ?? facts.linkHolder;
}

export function claimView(f: ClaimFacts): ClaimView {
  if (!f.leafMatches) return { kind: "not-on-list" };
  const e = f.entry;
  if (e.consentAt > 0n) {
    const deliverFrom = Number(e.consentAt) + CLAIM_CHALLENGE_SECONDS;
    return {
      kind: "agreed",
      receiver: e.receiver,
      amount: e.amount,
      taken: e.taken,
      due: f.due,
      deliverFrom,
      canDeliver: f.now >= deliverFrom && f.due > 0n,
    };
  }
  if (f.closed) return { kind: "closed" };
  const holder = holderOf(f);
  if (!f.me || f.me !== holder)
    return { kind: "wrong-wallet", holder, connected: f.me };
  if (!f.funded) return { kind: "not-funded" };
  const replacement = e.pending
    ? {
        applyAt: Number(e.pendingAt) + CLAIM_REPLACE_WAIT_SECONDS,
        // One bare veto per line, never for a wallet the keeper voided; agreeing also stops the replacement.
        canVeto: !e.vetoed && e.barred !== f.me,
      }
    : null;
  return { kind: "open", replacement };
}
