/**
 * Reading a chain's event history from a node that limits how much one request may cover.
 *
 * A local chain answers `eth_getLogs` from block 0 to the head in one request. A real node usually refuses: most cap the
 * block range of one request (commonly 10,000 to 50,000 blocks) or the number of results, and say so in an error. A read
 * that asks for the whole history then fails on exactly the chains where there is a lot of it.
 *
 * So the read asks for everything first (nothing changes where that works), and only when the node says the range is too
 * wide does it fall back to pages. Where the history starts is a fact about the chain, not about the node: every contract
 * this app reads was made after the launch kit was deployed, so a build can name that block and no page before it is asked
 * for. Without it a read from block 0 would take far too many pages, so it stops and says what to set.
 *
 * Pure and alias-free: `log-pages.test.mjs` drives it under `node --test`.
 */

/** The most requests one read may make. A read that needs more is refused instead of run for minutes. */
export const MAX_PAGES = 120;

/** The smallest page tried before giving up on a node that refuses everything. */
const MIN_PAGE = 10n;

/** The page size tried when the node does not say its limit. */
const DEFAULT_PAGE = 10_000n;

const RANGE_WORDS =
  /block range|range (?:is )?too|too (?:large|wide)|too many (?:results|logs|blocks)|exceed|more than \d+ results|limit(?:ed)? (?:of|to)|response size|result set|query returned/i;

/** Whether a node's error says the request covered too much (as opposed to a node that is down or a bad request). */
export function isRangeLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return RANGE_WORDS.test(message);
}

/** The block-range limit a node names in its error ("maximum block range: 50000", "up to a 10000 block range"), or null. */
export function rangeLimitFrom(error: unknown): bigint | null {
  const message = error instanceof Error ? error.message : String(error);
  const named =
    /(?:block range|range)\D{0,25}?(\d[\d,]*)/i.exec(message) ??
    /(\d[\d,]*)\s*block/i.exec(message);
  if (!named?.[1]) return null;
  const value = BigInt(named[1].replace(/,/g, ""));
  return value >= MIN_PAGE ? value : null;
}

/** The history was asked for in more pages than a read may make. Says what to set. */
export class HistoryTooWideError extends Error {
  constructor(from: bigint, to: bigint) {
    super(
      `This node limits how much history one request may read, and reading blocks ${from} to ${to} would take more than ${MAX_PAGES} requests. Name the block the launch kit was deployed at (VITE_HISTORY_FROM_BLOCKS), or use a node without that limit.`,
    );
    this.name = "HistoryTooWideError";
  }
}

export interface PagedRead<T> {
  /** One request over `from..to`, both included. Throws the node's error. */
  fetchPage: (from: bigint, to: bigint) => Promise<T[]>;
  from: bigint;
  to: bigint;
  /** The page size to start from, when the node's error named one. */
  pageSize?: bigint;
}

/**
 * Read `from..to` page by page, oldest first, halving the page whenever the node still says it is too wide. Any other
 * error is the caller's to see: a node that is down is not a range problem.
 */
export async function readInPages<T>(read: PagedRead<T>): Promise<T[]> {
  const { fetchPage, from, to } = read;
  if (to < from) return [];
  let size = read.pageSize ?? DEFAULT_PAGE;
  if (size < MIN_PAGE) size = MIN_PAGE;
  const out: T[] = [];
  let cursor = from;
  let requests = 0;
  while (cursor <= to) {
    const end = cursor + size - 1n < to ? cursor + size - 1n : to;
    if (requests >= MAX_PAGES) throw new HistoryTooWideError(from, to);
    requests += 1;
    try {
      out.push(...(await fetchPage(cursor, end)));
      cursor = end + 1n;
    } catch (error) {
      if (!isRangeLimitError(error) || size <= MIN_PAGE) throw error;
      const named = rangeLimitFrom(error);
      // A named limit smaller than the page is the node's own word; otherwise halve.
      size = named !== null && named < size ? named : size / 2n;
      if (size < MIN_PAGE) size = MIN_PAGE;
    }
  }
  return out;
}
