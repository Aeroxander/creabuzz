/**
 * Social trust: who a like should count for, and how much the feed should lean
 * on that as the community grows.
 *
 * This is deliberately separate from the launchpad's reputation (org seats and
 * reviewed work, `feed/lib/trust-weight.ts`) and from the TrustGraph score
 * roots that gate bids. It reads only the follow graph (kind 3) and says
 * nothing about money or authority.
 *
 * The shape of the transition matters more than any constant here: in a small
 * community the follow graph has too little signal, so every like counts the
 * same and the feed is essentially chronological. As the community grows, the
 * trust-derived weight takes over smoothly (no switch), and the ranking leans
 * on engagement more.
 *
 * Pure and alias-free: covered by `trust.test.mjs`.
 */

export type FollowGraph = ReadonlyMap<string, ReadonlySet<string>>;

interface ContactListLike {
  pubkey: string;
  created_at: number;
  id: string;
  tags: string[][];
}

/** Each author's newest contact list, as who-follows-whom. Self-follows drop. */
export function buildFollowGraph(
  contactLists: readonly ContactListLike[],
): Map<string, Set<string>> {
  const newest = new Map<string, ContactListLike>();
  for (const event of contactLists) {
    const seen = newest.get(event.pubkey);
    if (
      !seen ||
      event.created_at > seen.created_at ||
      (event.created_at === seen.created_at && event.id > seen.id)
    ) {
      newest.set(event.pubkey, event);
    }
  }
  const graph = new Map<string, Set<string>>();
  for (const [author, event] of newest) {
    const follows = new Set<string>();
    for (const tag of event.tags) {
      if (tag[0] === "p" && /^[0-9a-f]{64}$/.test(tag[1] ?? "")) {
        if (tag[1] !== author) follows.add(tag[1]);
      }
    }
    graph.set(author, follows);
  }
  return graph;
}

/** Every account that appears in the graph, as a follower or a followee. */
export function graphNodes(graph: FollowGraph): string[] {
  const nodes = new Set<string>();
  for (const [author, follows] of graph) {
    nodes.add(author);
    for (const followed of follows) nodes.add(followed);
  }
  return [...nodes];
}

/**
 * Seeded PageRank over "follows" edges: trust flows from the seeds along
 * follows, and a walker that reaches an account with no follows restarts at a
 * seed. Scores sum to 1. With no usable seeds the walk is uniform (global rank).
 */
export function seededPageRank(
  graph: FollowGraph,
  seeds: readonly string[],
  options: { damping?: number; iterations?: number } = {},
): Map<string, number> {
  const damping = options.damping ?? 0.85;
  const iterations = options.iterations ?? 30;
  const nodes = graphNodes(graph);
  if (nodes.length === 0) return new Map();

  const nodeSet = new Set(nodes);
  const seedList = seeds.filter((seed) => nodeSet.has(seed));
  const restart = new Map<string, number>();
  if (seedList.length > 0) {
    for (const seed of seedList) restart.set(seed, 1 / seedList.length);
  } else {
    for (const node of nodes) restart.set(node, 1 / nodes.length);
  }

  let rank = new Map<string, number>(restart);
  for (let i = 0; i < iterations; i++) {
    const next = new Map<string, number>();
    let dangling = 0;
    for (const node of nodes) {
      const mass = rank.get(node) ?? 0;
      const follows = graph.get(node);
      if (!follows || follows.size === 0) {
        dangling += mass;
        continue;
      }
      const share = (mass * damping) / follows.size;
      for (const followed of follows) {
        next.set(followed, (next.get(followed) ?? 0) + share);
      }
    }
    // Restart mass, plus whatever the dead ends could not pass on.
    const back = 1 - damping + damping * dangling;
    for (const [node, weight] of restart) {
      next.set(node, (next.get(node) ?? 0) + back * weight);
    }
    rank = next;
  }
  return rank;
}

/** Rank → 0..1 percentile (ties share the average), so one scale fits any size. */
export function percentiles(
  ranks: ReadonlyMap<string, number>,
): Map<string, number> {
  const entries = [...ranks].sort((a, b) => a[1] - b[1]);
  const out = new Map<string, number>();
  const n = entries.length;
  if (n === 0) return out;
  if (n === 1) {
    out.set(entries[0][0], 1);
    return out;
  }
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && entries[j + 1][1] === entries[i][1]) j++;
    const value = (i + j) / 2 / (n - 1);
    for (let k = i; k <= j; k++) out.set(entries[k][0], value);
    i = j + 1;
  }
  return out;
}

/** Below this many accounts the follow graph says too little to lean on. */
export const SMALL_COMMUNITY = 25;
/** At this many accounts the trust signal is fully in play. */
export const LARGE_COMMUNITY = 1_000;
/** Even a huge community keeps some weight on plain headcount. */
export const MAX_TRUST_SHARE = 0.8;

const smoothstep = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

/**
 * How far from "every like counts the same" (0) to "trust decides" (1) the feed
 * sits for a community of this size. Smooth in log-size, so growing from 25 to
 * 1000 accounts moves it gradually rather than flipping at a threshold.
 */
export function trustBlend(communitySize: number): number {
  if (!Number.isFinite(communitySize) || communitySize <= SMALL_COMMUNITY) {
    return 0;
  }
  const t =
    Math.log(communitySize / SMALL_COMMUNITY) /
    Math.log(LARGE_COMMUNITY / SMALL_COMMUNITY);
  return smoothstep(t) * MAX_TRUST_SHARE;
}

/**
 * How strongly engagement lifts a post over a newer one. A small community
 * stays close to chronological; a large one leans on what people liked.
 */
export function rankingStrength(communitySize: number): number {
  const progress = trustBlend(communitySize) / MAX_TRUST_SHARE;
  return 0.25 + 0.75 * progress;
}

export interface LikerTrust {
  /** 0..1 position of this account in the trust ranking (0 when unknown). */
  percentile: number;
  /** The viewer follows this account. */
  followedByViewer: boolean;
}

/** Floor and ceiling of a fully trust-weighted like. */
const MIN_TRUST = 0.15;
const MAX_TRUST = 2;

/** What one like (or repost) from this account counts for. */
export function likerWeight(trust: LikerTrust, blend: number): number {
  const earned = MIN_TRUST + (MAX_TRUST - MIN_TRUST) * trust.percentile;
  const trusted = Math.min(
    MAX_TRUST,
    earned + (trust.followedByViewer ? 0.5 : 0),
  );
  return (1 - blend) * 1 + blend * trusted;
}

export interface PostSignals {
  /** Weighted sum of likes, reposts and replies on the post. */
  engagement: number;
  /** Unix seconds the post (or its repost) entered the feed. */
  at: number;
}

const HOT_TIME_UNIT = 45_000;

/**
 * A post's ranking score: recency plus a logarithmic lift from engagement.
 * `strength` scales the lift (see {@link rankingStrength}); at 0 the order is
 * purely chronological.
 */
export function rankScore(post: PostSignals, strength: number): number {
  const lift = Math.log10(1 + Math.max(0, post.engagement));
  return post.at / HOT_TIME_UNIT + strength * lift;
}
