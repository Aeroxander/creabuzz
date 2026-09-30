/**
 * Who may co-edit live: the community's members, as the relay lists them.
 *
 * The relay publishes its member list as a NIP-43 kind:13534 event (one
 * `member` or `p` tag per pubkey, the same shape the desktop reads in
 * `relayMembers.ts`). A relay that does not require membership publishes none;
 * without a list nobody can be told from a stranger, so live co-editing is
 * off rather than open (fail closed — see `createMemberDirectory`).
 *
 * The community relay is the trust root for membership exactly as it is for
 * every other record the client reads; the list event's own signature is not
 * checked against a pinned relay key here.
 *
 * Deliberately free of `@/` imports so `node --test` can exercise it.
 */

/** NIP-43 relay membership list. */
export const KIND_NIP43_MEMBERSHIP_LIST = 13534;

const HEX_PUBKEY = /^[0-9a-f]{64}$/;

/** Member pubkeys (lowercase hex) named by a kind:13534 event. */
export function membersFromEvent(event: {
  tags: readonly (readonly string[])[];
}): Set<string> {
  const members = new Set<string>();
  for (const tag of event.tags) {
    if (tag[0] !== "member" && tag[0] !== "p") continue;
    const pubkey = (tag[1] ?? "").trim().toLowerCase();
    if (HEX_PUBKEY.test(pubkey)) members.add(pubkey);
  }
  return members;
}

/**
 * Newest kind:13534 event of a query result, as a member set; null when the
 * relay returned none (it publishes no member list).
 */
export function newestMemberSet(
  events: readonly {
    kind: number;
    created_at: number;
    tags: readonly (readonly string[])[];
  }[],
): Set<string> | null {
  let newest: (typeof events)[number] | null = null;
  for (const event of events) {
    if (event.kind !== KIND_NIP43_MEMBERSHIP_LIST) continue;
    if (!newest || event.created_at > newest.created_at) newest = event;
  }
  return newest ? membersFromEvent(newest) : null;
}

export type MemberVerdict = "member" | "not-member" | "unknown";

/** Outcome of loading the member list. */
export type MemberListState = "loaded" | "no-list" | "error";

export interface MemberDirectory {
  /**
   * Is `pubkey` a community member? Uses the cached list; on a miss it
   * refreshes once (at most once per `missRefreshMinMs`, so a stream of
   * unknown signers cannot make this hit the relay per message) and asks again.
   * "unknown" means no usable list exists — callers must treat it as a "no".
   */
  check(pubkey: string): Promise<MemberVerdict>;
  /** Load (or reload, when stale) the list; reports what happened. */
  load(): Promise<MemberListState>;
}

export function createMemberDirectory(options: {
  /** Resolves the member set, null when the relay publishes none; rejects on failure. */
  fetchMembers: () => Promise<ReadonlySet<string> | null>;
  nowMs?: () => number;
  /** How long a loaded list is trusted before it is reloaded. */
  ttlMs?: number;
  /** Minimum gap between refreshes triggered by a miss. */
  missRefreshMinMs?: number;
  /** A list older than this is discarded when it cannot be refreshed. */
  maxStaleMs?: number;
}): MemberDirectory {
  const now = options.nowMs ?? (() => Date.now());
  const ttlMs = options.ttlMs ?? 60_000;
  const missRefreshMinMs = options.missRefreshMinMs ?? 10_000;
  const maxStaleMs = options.maxStaleMs ?? ttlMs * 10;

  let members: ReadonlySet<string> | null = null;
  let loadedAt = 0;
  let lastAttemptAt = Number.NEGATIVE_INFINITY;
  let lastState: MemberListState = "error";
  let inflight: Promise<MemberListState> | null = null;

  const refresh = (): Promise<MemberListState> => {
    // Concurrent callers share one fetch.
    if (inflight) return inflight;
    lastAttemptAt = now();
    inflight = options
      .fetchMembers()
      .then((fetched): MemberListState => {
        if (fetched === null) {
          members = null;
          lastState = "no-list";
        } else {
          members = fetched;
          loadedAt = now();
          lastState = "loaded";
        }
        return lastState;
      })
      .catch((): MemberListState => {
        // A failed refresh keeps the previous list, but only while it is not
        // too old: trusting a stale list forever is how a removed member keeps
        // editing.
        if (members && now() - loadedAt > maxStaleMs) members = null;
        lastState = members ? "loaded" : "error";
        return lastState;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };

  const fresh = () => members !== null && now() - loadedAt <= ttlMs;
  // Bound how often messages can make this hit the relay, whether the list is
  // stale, missing, or just does not name the sender.
  const mayRefresh = () => now() - lastAttemptAt >= missRefreshMinMs;

  /** Wait for a fetch already under way; otherwise start one if `allowed`. */
  const settle = async (allowed: boolean): Promise<void> => {
    if (inflight) {
      await inflight;
    } else if (allowed) {
      await refresh();
    }
  };

  return {
    async load() {
      if (fresh()) return "loaded";
      return refresh();
    },
    async check(pubkey) {
      const key = pubkey.trim().toLowerCase();
      if (!fresh()) await settle(mayRefresh());
      if (!members) return "unknown";
      if (members.has(key)) return "member";
      // A miss may just be a member added since the last load.
      await settle(mayRefresh());
      if (!members) return "unknown";
      return members.has(key) ? "member" : "not-member";
    },
  };
}

/** Waits before each retry of a failed member-list load, then gives up. */
export const MEMBER_LIST_RETRY_DELAYS_MS: readonly number[] = [2_000, 8_000];

/**
 * Load the member list, retrying a failed load on a short bounded schedule.
 * "no-list" is an answer, not a failure, and is never retried. The terminal
 * outcome ("error") is reported so the editor can say live editing is off.
 */
export async function loadMemberListWithRetry(
  directory: Pick<MemberDirectory, "load">,
  options: {
    delaysMs?: readonly number[];
    sleep?: (ms: number) => Promise<void>;
    isCancelled?: () => boolean;
  } = {},
): Promise<MemberListState> {
  const delaysMs = options.delaysMs ?? MEMBER_LIST_RETRY_DELAYS_MS;
  const sleep =
    options.sleep ??
    ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const cancelled = options.isCancelled ?? (() => false);
  let state = await directory.load();
  for (const delay of delaysMs) {
    if (state !== "error" || cancelled()) return state;
    await sleep(delay);
    if (cancelled()) return state;
    state = await directory.load();
  }
  return state;
}
