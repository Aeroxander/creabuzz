/**
 * How long a person has held a project's Shares: the number of whole units since their balance last became positive and
 * stayed so (plan section 2.5 and 7.5). It is worked out here, on the person's own device, from their own transfer logs on the
 * Shares token, and nothing is sent anywhere and no record holds it. It is only a figure to read: no points, no badge, nothing unlocks.
 *
 * The walk goes backwards from the balance the person holds now, one block at a time, newest first. A block's net change tells
 * the balance before it; the first block (going back) that began at nothing is when the holding started. A take-out to nothing
 * therefore resets it, and a transfer in does not move it. A read that cannot be finished (the node refuses, the logs do not
 * add up to the balance, a block's time cannot be had) gives null: the line is not drawn, and never "0 weeks".
 */
import { signatureOf } from "@creaton/core/pot/abi-codec.ts";
import { SHARE_TOKEN_ABI } from "@creaton/core/pot/abis.generated.ts";
import { topicOf } from "@creaton/core/launchpad/work.ts";
import { balanceOf, readUnit } from "@creaton/core/pot/pot-reads.ts";
import { dayText } from "../money/numbers";
import type { MoneyWallet } from "../money/wallet";

const TRANSFER = (() => {
  const item = SHARE_TOKEN_ABI.find(
    (i) => i.type === "event" && i.name === "Transfer",
  );
  if (!item) throw new Error("The Share token's ABI has no Transfer event.");
  return topicOf(signatureOf(item));
})();

/** The blocks a first page covers, and the smallest one a node that refuses is still asked for. */
const PAGE = 5_000;
const MIN_PAGE = 100;
/** The most pages one read goes through, after the one try over the whole chain. */
const MAX_PAGES = 40;
/** More logs than this in one answer is not a person's own few transfers: the read stops. */
const MAX_LOGS = 5_000;

type Source = Pick<MoneyWallet, "getLogs" | "blockNumber" | "blockTime">;

/** When a holding began and the network's time now, both in unix seconds, and the project's time unit. */
export interface HeldSince {
  since: number;
  now: number;
  unit: number;
}

const word = (account: string): string =>
  `0x${account.toLowerCase().slice(2).padStart(64, "0")}`;

interface Move {
  block: number;
  /** What the account's balance changed by (negative: it gave Shares up). */
  delta: bigint;
}

/** The moves of `account` in blocks `from` to `to`, from the logs of the Share token. Throws when the node refuses. */
async function movesIn(
  source: Source,
  token: string,
  account: string,
  from: number,
  to: number,
): Promise<Move[]> {
  const me = word(account);
  const [sent, received] = await Promise.all([
    source.getLogs({ address: token, topics: [TRANSFER, me], from, to }),
    source.getLogs({ address: token, topics: [TRANSFER, null, me], from, to }),
  ]);
  if (sent.length > MAX_LOGS || received.length > MAX_LOGS)
    throw new Error("Too many logs for one account.");
  const out: Move[] = [];
  for (const [list, outgoing] of [
    [sent, true],
    [received, false],
  ] as const) {
    for (const log of list) {
      if (
        log.address.toLowerCase() !== token.toLowerCase() ||
        log.topics.length !== 3 ||
        log.topics[0]?.toLowerCase() !== TRANSFER
      )
        continue;
      const fromWord = log.topics[1]?.toLowerCase();
      const toWord = log.topics[2]?.toLowerCase();
      // The account's own side of the log. A move to itself is in both lists and nets to nothing in its block.
      if (outgoing ? fromWord !== me : toWord !== me) continue;
      const value = BigInt(log.data);
      out.push({
        block: Number(BigInt(log.blockNumber)),
        delta: outgoing ? -value : value,
      });
    }
  }
  return out;
}

/**
 * The block in which the account's present holding began, from its balance now and its moves, or null when the moves do not
 * lead back to a balance of nothing. Pure over `movesOf`, which answers for a range of blocks (and throws when it cannot).
 */
export async function holdingBlock(
  balance: bigint,
  head: number,
  movesOf: (from: number, to: number) => Promise<Move[]>,
): Promise<number | null> {
  if (balance <= 0n) return null;
  let after = balance;
  const walk = async (low: number, high: number) => {
    const moves = await movesOf(low, high);
    const byBlock = new Map<number, bigint>();
    for (const m of moves)
      byBlock.set(m.block, (byBlock.get(m.block) ?? 0n) + m.delta);
    for (const block of [...byBlock.keys()].sort((a, b) => b - a)) {
      const net = byBlock.get(block) ?? 0n;
      const before = after - net;
      // Moves that do not add up to the balance: not believed.
      if (before < 0n) return "inconsistent" as const;
      if (before === 0n) return block;
      after = before;
    }
    return null;
  };
  // One try over the whole chain; a node that refuses it is read in pages, newest first.
  try {
    const found = await walk(0, head);
    if (found === "inconsistent" || found === null) return null;
    return found;
  } catch {
    // Read in pages below.
  }
  after = balance;
  let high = head;
  let page = PAGE;
  let pages = 0;
  while (high >= 0 && pages < MAX_PAGES) {
    const low = Math.max(0, high - page + 1);
    let found: Awaited<ReturnType<typeof walk>>;
    try {
      found = await walk(low, high);
    } catch {
      if (page <= MIN_PAGE) return null;
      page = Math.max(MIN_PAGE, Math.floor(page / 2));
      continue;
    }
    if (found === "inconsistent") return null;
    if (found !== null) return found;
    pages += 1;
    high = low - 1;
  }
  return null;
}

/**
 * When this account's holding of the project's Shares began, read from the network. Null when it cannot be said (the account
 * holds none, a read failed, the moves do not add up, or the sender cannot say a block's time). Never throws.
 */
export async function readHeldSince(
  source: Source,
  read: (to: string, data: string) => Promise<string>,
  input: { account: string; shares: string; treasury: string },
): Promise<HeldSince | null> {
  try {
    if (!source.blockTime) return null;
    const balance = await balanceOf(read, input.shares, input.account);
    if (balance <= 0n) return null;
    const head = await source.blockNumber();
    const block = await holdingBlock(balance, head, (from, to) =>
      movesIn(source, input.shares, input.account, from, to),
    );
    if (block === null) return null;
    const [since, now, unit] = await Promise.all([
      source.blockTime(block),
      source.blockTime("latest"),
      readUnit(read, input.treasury),
    ]);
    if (!(unit > 0) || now < since) return null;
    return { since, now, unit };
  } catch {
    return null;
  }
}

/**
 * The line under "You hold": whole units since the holding began ("weeks" on a real network), or the day it began when it is
 * under one unit. Said the same on a test network with a short unit: a unit is the project's week.
 */
export function heldLine(held: HeldSince): string {
  const n = Math.floor((held.now - held.since) / held.unit);
  if (n < 1) return `You backed ${dayText(held.since)}.`;
  return `You have held it for ${n.toLocaleString("en-GB")} ${n === 1 ? "week" : "weeks"}.`;
}
