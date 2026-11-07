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
 * for. Reads start there straight away (`chain.ts`), not only after a refusal. Without it a read from block 0 would take far
 * too many pages, so it stops and says so.
 *
 * Pure and alias-free: `log-pages.test.mjs` drives it under `node --test`.
 */

/** The most requests one read may make. A read that needs more is refused instead of run for minutes. */
export const MAX_PAGES = 120;

/** The smallest page tried before giving up on a node that refuses everything. */
const MIN_PAGE = 10n;

/** The page size tried when the node does not say its limit. */
const DEFAULT_PAGE = 10_000n;

// No bare "exceed": "rate limit exceeded" and "daily request count exceeded" are a node that is busy, not a range it
// refuses, and paging around them sent about 11 more requests to a node that had just said it was overloaded.
const RANGE_WORDS =
  /block range|range (?:is )?too|range\b.{0,30}exceed|exceed.{0,30}\brange|too (?:large|wide)|too many (?:results|logs|blocks)|more than \d+ results|limit(?:ed)? (?:of|to)|response size|result set|query returned/i;

/**
 * A node saying it is asked too often (a passing failure: ask again later, not in smaller pieces). Only the plain words
 * for it and the providers' own phrases: Infura's "project ID request rate exceeded" and "daily request count exceeded,
 * request rate limited", Alchemy's "exceeded its compute units per second capacity". Looser words ("capacity", "quota",
 * "credits") also appear in range refusals, which must be paged, not given up on.
 */
const RATE_WORDS =
  /\b429\b|\brate.?limit|too many requests|request rate exceeded|daily request count exceeded|compute units per second capacity/i;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Whether a node's error says it is asked too often ("rate limit exceeded", "429 Too Many Requests"). */
export function isRateLimitError(error: unknown): boolean {
  return RATE_WORDS.test(messageOf(error));
}

/**
 * Whether a node's error says the request covered too much (as opposed to a node that is down, busy, or a bad request).
 * A rate limit is never a range limit, whatever else its words say.
 */
export function isRangeLimitError(error: unknown): boolean {
  const message = messageOf(error);
  return !RATE_WORDS.test(message) && RANGE_WORDS.test(message);
}

/**
 * The block-range limit a node names in its error ("maximum block range: 50000", "up to a 10000 block range",
 * "up to a 2K block range"), or null. A count of logs or results ("a cap of 10K logs") is not a block range.
 */
export function rangeLimitFrom(error: unknown): bigint | null {
  const message = messageOf(error);
  const named =
    /(\d[\d,]*)\s*(k)?\s*-?\s*blocks?\s+range/i.exec(message) ??
    /(?:block range|range)\D{0,25}?(\d[\d,]*)\s*(k)?(?!\s*(?:k\s*)?(?:logs|results))\b/i.exec(
      message,
    ) ??
    /(\d[\d,]*)\s*(k)?\s*blocks?\b/i.exec(message);
  if (!named?.[1]) return null;
  const base = BigInt(named[1].replace(/,/g, ""));
  const value = named[2] ? base * 1000n : base;
  return value >= MIN_PAGE ? value : null;
}

/**
 * The history was asked for in more pages than a read may make. Its message is for the person on the page (it says what
 * to do); `detail` is for whoever runs the site (the error report): the range and what to change.
 */
export class HistoryTooWideError extends Error {
  readonly detail: string;

  constructor(from: bigint, to: bigint) {
    super(
      "The chain node this site uses cannot read this much history. Tell the site's organiser; trying again will not help.",
    );
    this.name = "HistoryTooWideError";
    this.detail = `reading blocks ${from} to ${to} would take more than ${MAX_PAGES} requests at this node's limit: name the block the launch kit was deployed at (VITE_HISTORY_FROM_BLOCKS), or use a node that allows a wider eth_getLogs range`;
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
 * error is the caller's to see: a node that is down or busy is not a range problem (the request itself already asked
 * again after a pause, `chain.ts` `rpc`), and smaller pages would only ask a busy node more often.
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
