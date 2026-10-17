/**
 * Read a DAO's contributor work from the chain: its mandates, their projects and their claims, with each claim's
 * state and the number of reviewers who agreed. Every count is bounded (Review-Proven Rule 4); a DAO with more than
 * the bounds is shown truncated and says so, never silently cut.
 *
 * The chain is injected, so `workRead.test.mjs` runs the real reader against a fake one.
 */

import {
  type ClaimRecord,
  type ClaimView,
  type MandateCreated,
  type ProjectApproved,
  type ProjectRecord,
  SIGNATURES,
  TOPIC_CLAIM_SUBMITTED,
  TOPIC_MANDATE_CREATED,
  TOPIC_PROJECT_APPROVED,
  TOPIC_VERIFIER_ACCEPTED,
  addressTopic,
  decodeAddress,
  decodeBool,
  decodeClaim,
  decodeClaimSubmitted,
  decodeMandateCreated,
  decodeProject,
  decodeUnbond,
  decodeProjectApproved,
  decodeVerifier,
  decodeWord,
  encodeCall0,
  encodeCallId,
  encodeIsReviewer,
  encodeUnbonds,
} from "./work.ts";
import { encodeFunctionData } from "./evmAbi.ts";

export const MAX_MANDATES = 8;
export const MAX_PROJECTS = 50;
export const MAX_CLAIMS = 100;
export const MAX_REVIEWERS = 32;

export interface WorkChain {
  /** An `eth_call`'s raw hex answer. */
  call(to: string, data: string): Promise<string>;
  /** The latest block's timestamp in seconds: what "now" means to the contracts' windows. */
  now(): Promise<number>;
  /** `eth_getLogs` over the chain's whole history for one address and topic filter. */
  logs(filter: {
    address: string;
    topics: (string | null)[];
  }): Promise<readonly unknown[]>;
}

export interface ProjectView {
  id: string;
  approved: ProjectApproved;
  record: ProjectRecord;
}

/** One person on a mandate's reviewer panel, and the bond they hold (null when it could not be read). */
export interface ReviewerView {
  address: string;
  /** The bond they hold and count toward judging; null when it could not be read. */
  stake: bigint | null;
  /**
   * A bond they asked back and have not taken yet, and when they can. It no longer counts toward judging but stays
   * slashable until then, so it is part of what the DAO can take. Null when nothing is pending.
   */
  pending: { amount: bigint; availableAt: number } | null;
  /** The pending amount could not be read (not the same as nothing pending: asking for the whole bond leaves a stake of zero). */
  pendingUnreadable: boolean;
}

export interface MandateView {
  address: string;
  created: MandateCreated;
  closed: boolean;
  expiresAt: number;
  sharesAllocated: bigint;
  claimsAddress: string;
  verifiersAddress: string;
  quorum: number;
  challengeWindow: number;
  projects: ProjectView[];
  claims: ClaimView[];
  /** This is the panel the DAO named at launch to judge its team's milestones: it holds no money and awards no Shares. */
  isMilestonePanel: boolean;
  /** The connected wallet is on this mandate's reviewer panel. */
  walletIsReviewer: boolean;
  /** Claim ids the connected wallet already gave a verdict on. */
  walletAttested: string[];
  /**
   * The bond each reviewer must hold to judge claims, or null when none is asked. It is paid in `token`, which is the
   * claim currency unless the vote that made the budget named another; `symbol` and `decimals` are that token's.
   */
  bond: {
    token: string;
    minBond: bigint;
    symbol: string;
    decimals: number;
    /** False when the bond token's `decimals()` could not be read: never scale an amount by `decimals` then. */
    decimalsKnown: boolean;
  } | null;
  /**
   * The bond could not be read, which is not the same as the budget asking for none (`bond` is null in both): a budget
   * made before bonds existed has no bond functions and is bond-free, but a failed read of a bonded one says nothing.
   * The page then says so and offers a retry, and still lets a reviewer take back a bond that was asked back.
   */
  bondUnreadable: boolean;
  /** The reviewer panel, as accepted when the mandate was made. */
  reviewers: ReviewerView[];
  /** The bond the connected wallet holds as a reviewer (0 when none, or no wallet). */
  walletStake: bigint;
  /** Bond the connected wallet asked back and is waiting to take, with when it can; null when none is pending. */
  walletUnbond: { amount: bigint; availableAt: number } | null;
  /** Whether the pending bond could not be read: the page then says so and offers a retry, instead of showing nothing. */
  walletBondUnreadable: boolean;
  /** The currency's symbol and decimals, read once; null when the mandate moves no currency. */
  currency: {
    symbol: string;
    decimals: number;
    /** False when the token's `decimals()` could not be read: `decimals` is then a placeholder, never a scale to use. */
    decimalsKnown: boolean;
  } | null;
  truncated: boolean;
}

export interface WorkSnapshot {
  dao: string;
  /**
   * The mandate the DAO named, when it was born, as the panel that judges the milestones its team's Shares are locked
   * behind; null when it named none (the milestone lock then accepts any mandate the DAO made). It is one of
   * `mandates` when it could be read.
   */
  milestonePanel: string | null;
  /** The chain's own clock when this was read. */
  chainTime: number;
  mandates: MandateView[];
  truncated: boolean;
}

const number = (hex: string): number => Number(decodeWord(hex));

/**
 * `symbol()` and `decimals()` of an ERC-20, tolerating a token that answers neither. When `decimals()` does not answer
 * (or answers nonsense) the precision is unknown: `decimals` then holds 18 only so the type stays a number, and
 * `decimalsKnown` is false. Nothing may scale an amount by it: a six-decimal token read as 18 decimals prints (and
 * parses typed amounts) a trillion times off. Callers show raw units and refuse quantity-sensitive actions instead.
 */
async function readCurrency(
  chain: WorkChain,
  token: string,
): Promise<{ symbol: string; decimals: number; decimalsKnown: boolean }> {
  let decimals = 18;
  let decimalsKnown = false;
  let symbol = "units";
  try {
    const d = decodeWord(await chain.call(token, encodeCall0("decimals()")));
    if (d <= 36n) {
      decimals = Number(d);
      decimalsKnown = true;
    }
  } catch {
    // Unknown: shown as raw units, and amounts cannot be typed in until it is read.
  }
  try {
    const hex = (await chain.call(token, encodeCall0("symbol()"))).replace(
      /^0x/,
      "",
    );
    const length = Number(BigInt(`0x${hex.slice(64, 128) || "0"}`));
    if (length > 0 && length <= 32) {
      const bytes = hex.slice(128, 128 + length * 2).match(/../g) ?? [];
      symbol = String.fromCharCode(...bytes.map((b) => Number.parseInt(b, 16)));
    }
  } catch {
    // Keep the neutral word.
  }
  return { symbol, decimals, decimalsKnown };
}

/** A call the contract refused (no such function, or it reverted), as opposed to one that did not get an answer. */
function isRevert(error: unknown): boolean {
  return error instanceof Error && /revert/i.test(error.message);
}

type BondTerms = {
  token: string;
  minBond: bigint;
  symbol: string;
  decimals: number;
  /** False when the bond token's `decimals()` could not be read: `decimals` is then a placeholder, never a scale to use. */
  decimalsKnown: boolean;
};

/**
 * The bond a panel asks of its reviewers. A panel made before bonds existed has no such functions, so the contract
 * refuses the call: that is a bond-free panel. A call that gets no answer (a slow node, a dropped connection) says
 * nothing about the panel, so it is reported as unreadable and never as "no bond".
 */
async function readBond(
  chain: WorkChain,
  verifiers: string,
): Promise<
  | { status: "set"; bond: BondTerms }
  | { status: "none" }
  | { status: "unreadable" }
> {
  try {
    const token = decodeAddress(
      await chain.call(verifiers, encodeCall0(SIGNATURES.bondToken)),
    );
    if (/^0x0+$/.test(token)) return { status: "none" }; // bonding is off
    const minBond = decodeWord(
      await chain.call(verifiers, encodeCall0(SIGNATURES.minBond)),
    );
    return {
      status: "set",
      bond: { token, minBond, ...(await readCurrency(chain, token)) },
    };
  } catch (error) {
    return isRevert(error) ? { status: "none" } : { status: "unreadable" };
  }
}

/**
 * One reviewer's bond waiting to come back, bounded to the same calls as the rest. A panel without bonds has no such
 * function (the contract refuses: nothing pending); a call that got no answer is unreadable, never "nothing pending".
 */
async function readPending(
  chain: WorkChain,
  verifiers: string,
  reviewer: string,
): Promise<{
  pending: { amount: bigint; availableAt: number } | null;
  pendingUnreadable: boolean;
}> {
  try {
    const pending = decodeUnbond(
      await chain.call(verifiers, encodeUnbonds(reviewer)),
    );
    return {
      pending: pending.amount > 0n ? pending : null,
      pendingUnreadable: false,
    };
  } catch (error) {
    return { pending: null, pendingUnreadable: !isRevert(error) };
  }
}

/** The panel and each member's bond, bounded; a bond that cannot be read is reported as unknown, never as zero. */
async function readReviewers(
  chain: WorkChain,
  verifiers: string,
): Promise<ReviewerView[]> {
  let logs: readonly unknown[] = [];
  try {
    logs = await chain.logs({
      address: verifiers,
      topics: [TOPIC_VERIFIER_ACCEPTED],
    });
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const addresses: string[] = [];
  for (const log of logs as { topics?: string[] }[]) {
    const topic = log.topics?.[1];
    if (!topic) continue;
    const address = decodeAddress(topic);
    if (seen.has(address.toLowerCase())) continue;
    seen.add(address.toLowerCase());
    addresses.push(address);
  }
  return Promise.all(
    addresses.slice(0, MAX_REVIEWERS).map(async (address) => {
      const [stake, pending] = await Promise.all([
        (async () => {
          try {
            return decodeVerifier(
              await chain.call(verifiers, encodeIsReviewer(address)),
            ).stake;
          } catch {
            return null;
          }
        })(),
        readPending(chain, verifiers, address),
      ]);
      return { address, stake, ...pending };
    }),
  );
}

async function readMandate(
  chain: WorkChain,
  created: MandateCreated,
  wallet: string | null,
): Promise<MandateView> {
  const mandate = created.mandate;
  const [claimsHex, verifiersHex, closedHex, expiresHex, allocatedHex] =
    await Promise.all([
      chain.call(mandate, encodeCall0(SIGNATURES.mandateClaims)),
      chain.call(mandate, encodeCall0(SIGNATURES.mandateVerifiers)),
      chain.call(mandate, encodeCall0(SIGNATURES.mandateClosed)),
      chain.call(mandate, encodeCall0(SIGNATURES.mandateExpiresAt)),
      chain.call(mandate, encodeCall0(SIGNATURES.mandateSharesAllocated)),
    ]);
  const claimsAddress = decodeAddress(claimsHex);
  const verifiersAddress = decodeAddress(verifiersHex);
  const [quorumHex, windowHex, projectLogs, claimLogs] = await Promise.all([
    chain.call(verifiersAddress, encodeCall0(SIGNATURES.quorum)),
    chain.call(claimsAddress, encodeCall0(SIGNATURES.challengeWindow)),
    chain.logs({ address: mandate, topics: [TOPIC_PROJECT_APPROVED] }),
    chain.logs({ address: claimsAddress, topics: [TOPIC_CLAIM_SUBMITTED] }),
  ]);
  const quorum = number(quorumHex);

  let truncated = false;
  const approved = projectLogs.flatMap((log) => {
    const decoded = decodeProjectApproved(log as never);
    return decoded ? [decoded] : [];
  });
  if (approved.length > MAX_PROJECTS) truncated = true;
  const projects = (
    await Promise.all(
      approved
        .slice(0, MAX_PROJECTS)
        .map(async (a): Promise<ProjectView | null> => {
          const record = decodeProject(
            await chain.call(
              mandate,
              encodeCallId(SIGNATURES.project, a.projectId),
            ),
          );
          return record ? { id: a.projectId, approved: a, record } : null;
        }),
    )
  ).flatMap((p) => (p ? [p] : []));

  const submitted = claimLogs.flatMap((log) => {
    const decoded = decodeClaimSubmitted(log as never);
    return decoded ? [decoded] : [];
  });
  if (submitted.length > MAX_CLAIMS) truncated = true;
  // The newest claims are the ones people act on.
  const recent = submitted.slice(-MAX_CLAIMS);
  const walletAttested: string[] = [];
  const claims = (
    await Promise.all(
      recent.map(async (s): Promise<ClaimView | null> => {
        const record: ClaimRecord | null = decodeClaim(
          await chain.call(
            claimsAddress,
            encodeCallId(SIGNATURES.claim, s.claimId),
          ),
        );
        if (!record) return null;
        const [
          projectHex,
          awardedHex,
          approvalsHex,
          objectionsHex,
          attestedHex,
        ] = await Promise.all([
          chain.call(mandate, encodeCallId(SIGNATURES.claimProject, s.claimId)),
          chain.call(mandate, encodeCallId(SIGNATURES.awarded, s.claimId)),
          chain.call(
            verifiersAddress,
            encodeCallId(SIGNATURES.approvalCount, s.claimId),
          ),
          chain.call(
            verifiersAddress,
            encodeCallId(SIGNATURES.objectionCount, s.claimId),
          ),
          wallet
            ? chain.call(
                verifiersAddress,
                encodeFunctionData(
                  "attested(bytes32,address)",
                  ["bytes32", "address"],
                  [s.claimId, wallet],
                ),
              )
            : Promise.resolve("0x0"),
        ]);
        if (decodeBool(attestedHex)) walletAttested.push(s.claimId);
        const projectWord = decodeWord(projectHex);
        return {
          id: s.claimId,
          record,
          project:
            projectWord === 0n
              ? null
              : `0x${projectWord.toString(16).padStart(64, "0")}`,
          approvals: number(approvalsHex),
          objections: number(objectionsHex),
          quorum,
          sharesAwarded: decodeBool(awardedHex),
        };
      }),
    )
  ).flatMap((c) => (c ? [c] : []));

  // One read says both whether the wallet is on the panel and what bond it holds, so the bond never depends on the
  // panel listing (a listing that could not be read must not turn a held bond into "none").
  const walletVerifier = wallet
    ? decodeVerifier(
        await chain.call(verifiersAddress, encodeIsReviewer(wallet)),
      )
    : { active: false, stake: 0n };
  const walletIsReviewer = walletVerifier.active;
  const [bondRead, reviewers] = await Promise.all([
    readBond(chain, verifiersAddress),
    readReviewers(chain, verifiersAddress),
  ]);
  const bond = bondRead.status === "set" ? bondRead.bond : null;
  const bondUnreadable = bondRead.status === "unreadable";
  const walletStake = walletVerifier.stake;
  // A bond asked back waits out a delay and stays slashable meanwhile; a panel without bonds has no such record. A read
  // that fails is reported as unreadable, never as nothing pending: asking for the whole bond back leaves a stake of
  // zero, and the pending amount is then the only sign the reviewer has money waiting.
  let walletUnbond: { amount: bigint; availableAt: number } | null = null;
  let walletBondUnreadable = false;
  // This does not depend on the bond's terms being readable: a failed read of those must not hide a bond that is
  // waiting to come back. Only a panel confirmed to have no bond skips it.
  if (wallet && walletIsReviewer && bondRead.status !== "none") {
    const mine = await readPending(chain, verifiersAddress, wallet);
    walletUnbond = mine.pending;
    walletBondUnreadable = mine.pendingUnreadable;
  }
  const moves =
    bond !== null ||
    created.budget > 0n ||
    claims.some((c) => c.record.amount > 0n || c.record.stake > 0n);
  return {
    address: mandate,
    created,
    closed: decodeBool(closedHex),
    expiresAt: number(expiresHex),
    sharesAllocated: decodeWord(allocatedHex),
    claimsAddress,
    verifiersAddress,
    quorum,
    challengeWindow: number(windowHex),
    projects,
    claims,
    isMilestonePanel: false, // `readWork` knows which one the DAO named
    walletIsReviewer,
    walletAttested,
    bond,
    bondUnreadable,
    reviewers,
    walletStake,
    walletUnbond,
    walletBondUnreadable,
    currency: moves ? await readCurrency(chain, created.currency) : null,
    truncated,
  };
}

/** A DAO's mandates and everything under them. `wallet` is the connected account, if any. */
/** The mandate the DAO named as its milestone panel, or null: a factory made before panels existed has no such function. */
async function readMilestonePanel(
  chain: WorkChain,
  factory: string,
  dao: string,
): Promise<string | null> {
  try {
    const panel = decodeAddress(
      await chain.call(
        factory,
        encodeFunctionData(SIGNATURES.milestoneMandate, ["address"], [dao]),
      ),
    );
    return /^0x0+$/.test(panel) ? null : panel.toLowerCase();
  } catch {
    return null;
  }
}

export async function readWork(
  chain: WorkChain,
  dao: string,
  wallet: string | null,
): Promise<WorkSnapshot> {
  const chainTime = await chain.now();
  const policy = decodeAddress(
    await chain.call(dao, encodeCall0(SIGNATURES.policy)),
  );
  const factory = decodeAddress(
    await chain.call(policy, encodeCall0(SIGNATURES.factory)),
  );
  const logs = await chain.logs({
    address: factory,
    topics: [TOPIC_MANDATE_CREATED, addressTopic(dao)],
  });
  const created = logs.flatMap((log) => {
    const decoded = decodeMandateCreated(log as never);
    return decoded ? [decoded] : [];
  });
  const milestonePanel = await readMilestonePanel(chain, factory, dao);
  // The panel is read whatever else was made after it: it is the one that matters for the team's Shares.
  const recent = created.slice(-MAX_MANDATES);
  const panelCreated = milestonePanel
    ? created.find((c) => c.mandate.toLowerCase() === milestonePanel)
    : undefined;
  const wanted =
    panelCreated && !recent.includes(panelCreated)
      ? [panelCreated, ...recent.slice(1)]
      : recent;
  const mandates = (
    await Promise.all(wanted.map((c) => readMandate(chain, c, wallet)))
  ).map((m) => ({
    ...m,
    isMilestonePanel: m.address.toLowerCase() === milestonePanel,
  }));
  return {
    dao,
    milestonePanel,
    chainTime,
    mandates,
    truncated:
      created.length > MAX_MANDATES || mandates.some((m) => m.truncated),
  };
}
