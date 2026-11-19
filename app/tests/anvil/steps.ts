/**
 * The steps the anvil scenarios share, each through the app's own call builders and wallet: launching a project,
 * backing and closing a round, and a Pair's proposal confirmed from its `Proposed` log as the app's card does.
 */
import { encodeFunctionData } from "../../../packages/creaton-core/src/launchpad/evmAbi.ts";
import {
  chainKeyOf,
  projectIdOf,
} from "../../../packages/creaton-core/src/launchpad/project-chain.ts";
import { backCalls } from "../../src/features/money/calls";
import {
  injectedWallet,
  type MoneyWallet,
} from "../../src/features/money/wallet";
import {
  PROPOSED_TOPIC,
  type Proposal,
  proposalOf,
} from "../../src/features/team/pair";
import {
  LAUNCHER_READS,
  launchCall,
  pairConfirmCall,
  pairProposeCall,
} from "../../src/features/team/team-calls";
import { exitCall, readExitPlan } from "../../src/features/market/exit-plan";
import { collectCalls } from "../../src/features/market/market-calls";
import { readWord } from "../../src/features/team/use-team";
import { mintDollars, type Platform } from "./deploy";
import {
  blockNumber,
  call,
  passTime,
  providerFor,
  send,
  waitReceipt,
} from "./rpc";

export const DOLLAR = 1_000_000n;
export const SHARE = 10n ** 18n;
export const DAY = 86_400;
export const data = (
  signature: string,
  types: Parameters<typeof encodeFunctionData>[1] = [],
  values: Parameters<typeof encodeFunctionData>[2] = [],
) => encodeFunctionData(signature, types, values);

export const walletOf = (account: string): MoneyWallet =>
  injectedWallet(providerFor(account), { polls: 100, pollMs: 20 });

/** The `round` id a Launcher's `RoundOpened` log in a call's receipt carries (topic 3). */
export async function openedRound(
  hash: string,
  launcher: string,
): Promise<bigint> {
  const receipt = await waitReceipt(hash);
  const log = receipt.logs.find(
    (l) => l.address.toLowerCase() === launcher && l.topics.length === 4,
  );
  if (!log) throw new Error("no round opened");
  return BigInt(log.topics[3]);
}

export interface Project {
  key: string;
  shares: string;
  treasury: string;
  vester: string;
  finisher: string;
  rounds: string;
}

export async function launched(
  platform: Platform,
  founder: string,
  coordinate: string,
): Promise<Project> {
  const wallet = walletOf(founder);
  const projectId = projectIdOf(coordinate);
  const key = chainKeyOf(founder, projectId);
  const hash = await readWord(
    wallet,
    platform.launcher,
    LAUNCHER_READS.launchHash(key),
  );
  await wallet.sendCalls(
    [
      launchCall({
        launcher: platform.launcher,
        projectId,
        name: "Lantern",
        symbol: "LANTERN",
        settingsHash: `0x${hash.toString(16).padStart(64, "0")}`,
      }),
    ],
    31337,
  );
  const words = (
    await call(platform.launcher, LAUNCHER_READS.projectByKey(key))
  )
    .slice(2)
    .match(/.{64}/g) as string[];
  const at = (i: number) => `0x${words[i].slice(24)}`;
  return {
    key,
    shares: at(1),
    treasury: at(2),
    vester: at(3),
    finisher: at(4),
    rounds: at(5),
  };
}

/** Back round `round` with `amount` from each of `backers`, close it after its 24 hours, and deliver everyone's Shares. */
export async function backAndClose(
  platform: Platform,
  p: Project,
  round: bigint,
  backers: string[],
  amount: bigint,
  stranger: string,
) {
  for (const backer of backers) {
    await mintDollars(stranger, platform.quote, backer, amount);
    await walletOf(backer).sendCalls(
      backCalls({
        quote: platform.quote,
        rounds: p.rounds,
        round: Number(round),
        amount,
      }),
      31337,
    );
  }
  await passTime(DAY + 60);
  await send(stranger, p.rounds, data("close(uint256)", ["uint256"], [round]));
  for (const backer of backers)
    await send(
      stranger,
      p.rounds,
      data("settle(uint256,address)", ["uint256", "address"], [round, backer]),
    );
}

/** One signer proposes `inner` for `target`; the proposal is read back from the Pair's newest `Proposed` log. */
export async function proposeThrough(
  pair: string,
  proposer: MoneyWallet,
  target: string,
  inner: string,
): Promise<Proposal> {
  await proposer.sendCalls([pairProposeCall(pair, target, inner)], 31337);
  const head = await blockNumber();
  const logs = await proposer.getLogs({
    address: pair,
    topics: [PROPOSED_TOPIC],
    from: Math.max(0, head - 50),
    to: head,
  });
  const proposal = logs
    .map((l) => proposalOf(l, pair))
    .filter((x) => x !== null)
    .pop();
  if (!proposal) throw new Error("no proposal");
  if (proposal.data !== inner.toLowerCase())
    throw new Error("the log does not carry the proposed call");
  return proposal;
}

/** Both sign: one proposes, the other confirms the exact call read back from the log. */
export async function confirmThrough(
  pair: string,
  proposer: MoneyWallet,
  confirmer: MoneyWallet,
  target: string,
  inner: string,
) {
  const proposal = await proposeThrough(pair, proposer, target, inner);
  return confirmer.sendCalls(
    [pairConfirmCall(pair, proposal.target, proposal.data, proposal.nonce)],
    31337,
  );
}

/**
 * The app's calls that collect one bid after the sale finished: what settles it is read from the auction as the app's
 * Collect press does (whole, or a partly filled bid with the auction's hints), then its Shares when `claim`.
 */
export async function collectBid(
  wallet: MoneyWallet,
  auction: string,
  bidId: bigint,
  claim: boolean,
) {
  const plan = await readExitPlan(wallet, auction, bidId);
  if (plan.kind === "unavailable")
    throw new Error(`no way to settle the bid: ${plan.reason}`);
  return collectCalls(auction, bidId, {
    exit: exitCall(auction, bidId, plan),
    claim,
  });
}
