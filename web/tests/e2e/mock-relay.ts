import type { Page } from "@playwright/test";

/** The preview's port (`playwright.config.ts`): E2E_PORT lets the mocked specs run beside a journey that holds :4173. */
export const PREVIEW_PORT = process.env.E2E_PORT ?? "4173";

/**
 * The community the app is connected to in the mocked specs: the build has no saved or baked-in server, so it talks to
 * the preview's own address (`relayWsUrl()`), and `/c/<this>` is the community whose rooms the mock serves. Any other
 * host under `/c/` is a different community, shown by its public card.
 */
export const COMMUNITY_HOST = `127.0.0.1:${PREVIEW_PORT}`;

/** The preview the specs run against (`playwright.config.ts`): its sockets are this mock. */
export const PREVIEW_ORIGIN = new RegExp(`127\\.0\\.0\\.1:${PREVIEW_PORT}`);

/**
 * A small in-memory relay for browser tests.
 *
 * The other suites answer each page's queries in isolation, which cannot show
 * whether live delivery works: one user's publish has to reach another user's
 * subscription. This mock stores published events, replays them to matching
 * REQs, and fans a new event out to every open subscription that matches — the
 * minimum needed to exercise the app's realtime path.
 */

interface StoredEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

interface Filter {
  kinds?: number[];
  limit?: number;
  [tag: string]: unknown;
}

interface Socket {
  send: (payload: string) => void;
  close: () => void;
}

function tagValue(event: StoredEvent, name: string): string[] {
  return event.tags.filter((tag) => tag[0] === name).map((tag) => tag[1]);
}

/**
 * The room or board a record is kept under, as the real server keeps it: its `h` tag, or for the server's own NIP-29
 * group records and board state (which name their board in `d`) that board. Null for a record kept under none.
 */
function keptUnder(event: StoredEvent): string | null {
  const h = tagValue(event, "h")[0];
  if (h) return h;
  if ((event.kind >= 39000 && event.kind <= 39003) || event.kind === 39008)
    return tagValue(event, "d")[0] ?? null;
  return null;
}

/**
 * Whether a live subscription hears a record, by the real server's rule (`buzz-relay/src/subscription.rs`): one tied
 * to rooms or boards (every filter names them with `#h`) hears only records kept under them; an untied one hears only
 * records kept under none. A subscription on the wrong side never fires, however well its filter matches.
 */
export function liveScopeAllows(filter: Filter, event: StoredEvent): boolean {
  const tied = Array.isArray(filter["#h"]);
  return tied === (keptUnder(event) !== null);
}

/** The relay's p-gated kinds: reading them needs `#p` equal to your pubkey. */
const P_GATED_KINDS = [44100, 44101, 1059, 44200];

/**
 * Whether the relay would refuse this filter: it names a p-gated kind, and its
 * `#p` values are not exactly the authenticated pubkey.
 */
function pGateRefuses(filter: Filter, authedPubkey: string | null): boolean {
  const kinds = filter.kinds ?? [];
  const canMatchPGated =
    kinds.length === 0 || kinds.some((kind) => P_GATED_KINDS.includes(kind));
  if (!canMatchPGated) return false;
  const p = filter["#p"];
  const wanted = Array.isArray(p) ? (p as string[]) : [];
  if (wanted.length === 0) return true;
  return !(
    authedPubkey !== null && wanted.every((value) => value === authedPubkey)
  );
}

/** NIP-01 filter match, limited to what the client actually sends. */
export function matches(filter: Filter, event: StoredEvent): boolean {
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  // Ids: a lookup by id must not be answered with some other event.
  if (Array.isArray(filter.ids)) {
    const wanted = filter.ids as string[];
    if (wanted.length > 0 && !wanted.includes(event.id)) return false;
  }
  // Authors: profile reads ask for kind-0 events by author. Ignoring the field
  // lets a one-author query be answered from another author's event — or, since
  // `replay` slices to `limit`, from nothing at all — so a username test would
  // pass or fail for reasons that have nothing to do with the app.
  if (Array.isArray(filter.authors)) {
    const wanted = filter.authors as string[];
    if (wanted.length > 0 && !wanted.includes(event.pubkey)) return false;
  }
  // Time bounds matter for pagination: a history page asks for everything up to
  // the oldest message it already has.
  if (typeof filter.since === "number" && event.created_at < filter.since) {
    return false;
  }
  if (typeof filter.until === "number" && event.created_at > filter.until) {
    return false;
  }
  for (const [key, value] of Object.entries(filter)) {
    if (!key.startsWith("#")) continue;
    const tagName = key.slice(1);
    const wanted = Array.isArray(value) ? (value as string[]) : [];
    if (wanted.length === 0) continue;
    let present = tagValue(event, tagName);
    // As the real server does (`buzz-core/src/filter.rs`): a record with no `h` tag matches `#h` by the board it is
    // stored under. For the server's NIP-29 group records (39000–39003) that is the board their `d` names.
    if (
      tagName === "h" &&
      present.length === 0 &&
      event.kind >= 39000 &&
      event.kind <= 39003
    ) {
      present = tagValue(event, "d");
    }
    if (!present.some((v) => wanted.includes(v))) return false;
  }
  return true;
}

export interface MockRelayOptions {
  /**
   * Refuse a write the way a relay does — return a reason to reject the event,
   * or `null` to accept it. Lets a test cover the path where the relay refuses
   * a client's writes instead of only the happy path.
   */
  refuse?: (event: StoredEvent) => string | null;
  /**
   * Close every socket as soon as it opens, the way a rate-limiting or
   * misconfigured relay does. Lets a test observe the client's reconnect
   * policy instead of only its happy path.
   */
  closeImmediately?: boolean;
  /**
   * Require NIP-42 authentication and refuse any subscription that arrives
   * first, the way Buzz's relay does (it compares p-gated filters against the
   * authenticated identity).
   */
  requireAuth?: boolean;
  /**
   * With `requireAuth`, send the challenge this many milliseconds after the
   * socket opens instead of on the first REQ. A value past the client's own
   * "send the REQ anyway" window models the slow-relay case; the default (0)
   * challenges on demand, which loses the race deterministically.
   */
  challengeDelayMs?: number;
  /**
   * Enforce the relay's p-gate: a filter naming a p-gated kind must have every
   * `#p` value equal the authenticated pubkey. Buzz's relay does this, which is
   * how a client that authenticates as one identity and filters by another
   * silently loses every mention.
   */
  enforcePGate?: boolean;
  /**
   * Do what Buzz's relay does with a channel-create (kind 9007): derive the
   * channel's metadata record (kind 39000, `d` = the channel id) from it, so the
   * channel appears in the list. Off by default: most specs seed channels.
   */
  deriveChannels?: boolean;
  /**
   * Stop serving what its author deletes (kind 5 naming an event the same
   * author wrote), as the real server does: the deletion is still delivered
   * live, but a later read no longer returns the deleted record. Off by default
   * because the chat specs read the deleted message back.
   */
  applyDeletions?: boolean;
}

export function createMockRelay({
  refuse,
  closeImmediately = false,
  requireAuth = false,
  challengeDelayMs = 0,
  enforcePGate = false,
  deriveChannels = false,
  applyDeletions = false,
}: MockRelayOptions = {}) {
  const events: StoredEvent[] = [];
  const sockets = new Set<Socket>();
  let connectionsOpened = 0;
  const openedAt: number[] = [];
  /**
   * Flipped on by a test that wants to watch the reconnect policy. A predicate
   * narrows it to the subscriptions under test, so the rest of the page keeps
   * loading.
   */
  let closingSockets: boolean | ((filter: Filter | undefined) => boolean) =
    closeImmediately;
  /** When each live-subscription socket asked for its subscription. */
  const liveSubscriptionReqs: number[] = [];
  /** Every kind the page has asked for, once per request, so a test can wait until a read has been served. */
  const requestedKinds: number[] = [];
  /** The filters of every REQ the page sent, in order: how many reads, and how many filters each carried. */
  const reqsReceived: Filter[][] = [];
  /**
   * Subscriptions refused before the handshake and then re-issued on the same
   * socket once it authenticated — the client recovering from the race, which
   * nothing else produces. Counted separately for the live pumps and for
   * one-shot queries, because they are different code paths and either can
   * mask the other.
   */
  const authRetries = { live: 0, query: 0 };
  const subscriptions = new WeakMap<Socket, Map<string, Filter>>();
  /** Set by `holdReads`: reads whose filter matches are kept unanswered, in `heldReads`, until `releaseReads`. */
  let heldFilter: ((filter: Filter) => boolean) | null = null;
  const heldReads: Array<() => void> = [];
  /** Set by `ban`: the reason every login is refused with from then on, as the real server refuses a banned key. */
  let bannedReason: string | null = null;
  /** Rooms and boards the reader was removed from (`revoke`): subscriptions to them are refused. */
  const revokedChannels = new Set<string>();

  const deliver = (event: StoredEvent) => {
    // A delivered event is an accepted one: store it before fanning out, or a
    // one-shot query issued afterwards would never see it.
    if (!events.some((stored) => stored.id === event.id)) events.push(event);
    for (const socket of sockets) {
      const subs = subscriptions.get(socket);
      if (!subs) continue;
      for (const [subId, filter] of subs) {
        if (matches(filter, event) && liveScopeAllows(filter, event)) {
          socket.send(JSON.stringify(["EVENT", subId, event]));
        }
      }
    }
  };

  const install = async (page: Page) => {
    // The server's public information document, which a real server always serves. It says nothing about who may
    // join, as a server that predates the setting would; a spec that cares answers it itself.
    await page.route("**/info", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/nostr+json",
        body: JSON.stringify({ name: "Mock server" }),
      });
    });
    await page.route("**/communities", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ communities: [] }),
      });
    });
    await page.routeWebSocket(PREVIEW_ORIGIN, (ws) => {
      connectionsOpened += 1;
      openedAt.push(Date.now());
      const socket: Socket = {
        send: (payload) => ws.send(payload),
        close: () => ws.close(),
      };

      sockets.add(socket);
      subscriptions.set(socket, new Map());
      let authenticated = false;
      let authedPubkey: string | null = null;
      let challenged = false;
      let refusedWhileUnauthenticated = false;
      const sendChallenge = () => {
        if (challenged) return;
        challenged = true;
        ws.send(JSON.stringify(["AUTH", "mock-challenge"]));
      };
      if (requireAuth && challengeDelayMs > 0) {
        setTimeout(sendChallenge, challengeDelayMs);
      }
      // A banned reader is challenged at once, and their login refused (below), as the real server does.
      if (bannedReason !== null) sendChallenge();
      ws.onClose(() => sockets.delete(socket));
      ws.onMessage((message) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(message));
        } catch {
          return;
        }
        if (!Array.isArray(parsed)) return;
        if (
          parsed[0] === "REQ" &&
          typeof parsed[1] === "string" &&
          parsed[1].startsWith("live-")
        ) {
          // A `subscribeChannel` pump asking for its subscription: identify the
          // socket so a test can count the reconnects that policy drives.
          liveSubscriptionReqs.push(Date.now());
        }
        const dropRequest =
          typeof closingSockets === "function"
            ? closingSockets(parsed[2] as Filter | undefined)
            : closingSockets;
        if (dropRequest && parsed[0] === "REQ") {
          // Accept, let the client use the connection, then hang up: the client
          // must back off, not reconnect at the first step forever.
          ws.close();
          return;
        }
        const [type] = parsed;
        if (type === "EVENT" || type === "AUTH") {
          const event = parsed[1] as StoredEvent;
          if (type === "AUTH" && bannedReason !== null) {
            ws.send(JSON.stringify(["OK", event.id, false, bannedReason]));
            ws.close();
            return;
          }
          if (type === "AUTH") {
            // NIP-42: this mock accepts any signed auth event, but remembers
            // who signed it, because that is what the gate compares against.
            authenticated = true;
            authedPubkey =
              typeof (event as { pubkey?: string }).pubkey === "string"
                ? ((event as { pubkey?: string }).pubkey as string)
                : null;
          }
          if (type === "EVENT") {
            const reason = refuse?.(event);
            if (reason) {
              // Rejected writes are not stored and not fanned out: a client
              // that ignores the OK must not look like it succeeded.
              ws.send(JSON.stringify(["OK", event.id, false, reason]));
              return;
            }
            events.push(event);
            if (applyDeletions && event.kind === 5) {
              const doomed = new Set(
                event.tags.filter((t) => t[0] === "e").map((t) => t[1]),
              );
              for (let i = events.length - 1; i >= 0; i--) {
                if (
                  doomed.has(events[i].id) &&
                  events[i].pubkey === event.pubkey
                ) {
                  events.splice(i, 1);
                }
              }
            }
            if (applyDeletions && event.kind === 9005) {
              // A moderator's removal: the real server checks the sender owns or administers the channel before it
              // stores this, so the mock takes the target away whoever sent it and leaves the check to a test's `refuse`.
              const doomed = new Set(
                event.tags.filter((t) => t[0] === "e").map((t) => t[1]),
              );
              for (let i = events.length - 1; i >= 0; i--) {
                if (doomed.has(events[i].id)) events.splice(i, 1);
              }
            }
            // Fan out after acknowledging, as a relay would.
            ws.send(JSON.stringify(["OK", event.id, true, ""]));
            deliver(event);
            if (deriveChannels && event.kind === 9007) {
              const tag = (name: string) =>
                event.tags.find((t) => t[0] === name)?.[1] ?? "";
              deliver({
                id: `meta-${event.id}`,
                pubkey: event.pubkey,
                created_at: event.created_at,
                kind: 39000,
                tags: [
                  ["d", tag("h")],
                  ["name", tag("name")],
                  ...(tag("about") ? [["about", tag("about")]] : []),
                  // As the server writes them: visibility and the channel type.
                  [tag("visibility") === "private" ? "private" : "public"],
                  ["t", tag("channel_type") || "stream"],
                ],
                content: "",
                sig: "sig",
              });
            }
            return;
          }
          ws.send(JSON.stringify(["OK", event.id, true, ""]));
          return;
        }
        if (type === "REQ") {
          const [, subId] = parsed as [string, string, Filter];
          // NIP-01: a REQ may carry several filters (one socket for a page's independent reads). The gates below judge
          // the first and the `some` checks cover the rest; the replay is the union, each event once.
          const filters = (parsed.slice(2) as Filter[]).filter(
            (f) => f && typeof f === "object",
          );
          const filter = filters[0] ?? {};
          for (const f of filters) requestedKinds.push(...(f.kinds ?? []));
          reqsReceived.push(filters);
          /** Newest first, capped, the way a relay replays a filter. */
          const replay = (candidate: Filter) =>
            events
              .filter((event) => matches(candidate, event))
              .sort((a, b) => b.created_at - a.created_at)
              .slice(0, candidate.limit ?? events.length);
          if (authenticated && refusedWhileUnauthenticated) {
            refusedWhileUnauthenticated = false;
            if (subId.startsWith("live-")) authRetries.live += 1;
            else authRetries.query += 1;
          }
          if (requireAuth && !authenticated) {
            // Challenge on demand: this socket has not proven who it is, so the
            // subscription is refused and the handshake starts now. A client
            // that treats the refusal as final loses the query.
            refusedWhileUnauthenticated = true;
            sendChallenge();
            ws.send(
              JSON.stringify([
                "CLOSED",
                subId,
                "restricted: p-gated events require #p matching your pubkey",
              ]),
            );
            return;
          }
          const asksRevoked = filters.some((f) =>
            (f["#h"] as string[] | undefined)?.some((id) =>
              revokedChannels.has(id),
            ),
          );
          if (asksRevoked) {
            ws.send(
              JSON.stringify([
                "CLOSED",
                subId,
                "restricted: not a channel member",
              ]),
            );
            return;
          }
          if (
            enforcePGate &&
            filters.some((f) => pGateRefuses(f, authedPubkey))
          ) {
            ws.send(
              JSON.stringify([
                "CLOSED",
                subId,
                "restricted: p-gated events require #p matching your pubkey",
              ]),
            );
            return;
          }
          const answer = () => {
            subscriptions.get(socket)?.set(subId, filter);
            const sentIds = new Set<string>();
            for (const f of filters) {
              for (const event of replay(f)) {
                if (sentIds.has(event.id)) continue;
                sentIds.add(event.id);
                ws.send(JSON.stringify(["EVENT", subId, event]));
              }
            }
            ws.send(JSON.stringify(["EOSE", subId]));
          };
          if (heldFilter !== null && filters.some(heldFilter)) {
            // A server that has the request and is slow to answer it: nothing comes back until `releaseReads`.
            heldReads.push(answer);
            return;
          }
          answer();
        }
      });
    });
  };

  /** Drop every open socket, as a relay restart or a network blip would. */
  const dropConnections = () => {
    for (const socket of [...sockets]) {
      try {
        socket.close();
      } catch {
        // already gone
      }
    }
  };

  /** Put an event in the store without notifying anyone (history seeding). */
  const seed = (event: StoredEvent) => {
    events.push(event);
  };

  /**
   * Ban the reader, as the real server does: every open socket gets the reason as an `OK false` frame and is closed,
   * and every later login is refused with the same reason.
   */
  const ban = (reason: string) => {
    bannedReason = reason;
    for (const socket of [...sockets]) {
      socket.send(JSON.stringify(["OK", "ban-command", false, reason]));
      socket.close();
    }
  };

  /**
   * Remove the reader from a room or board, as the real server does: each live subscription tied to it is closed with
   * `restricted: channel access revoked`, and every later subscription to it is refused.
   */
  const revoke = (channelId: string) => {
    revokedChannels.add(channelId);
    for (const socket of sockets) {
      const subs = subscriptions.get(socket);
      if (!subs) continue;
      for (const [subId, filter] of [...subs]) {
        if (!(filter["#h"] as string[] | undefined)?.includes(channelId))
          continue;
        subs.delete(subId);
        socket.send(
          JSON.stringify([
            "CLOSED",
            subId,
            "restricted: channel access revoked",
          ]),
        );
      }
    }
  };

  return {
    install,
    deliver,
    seed,
    ban,
    revoke,
    dropConnections,
    events,
    /** Sockets the page has opened, across reconnects. */
    connectionsOpened: () => connectionsOpened,
    reqsReceived: () => reqsReceived.map((filters) => [...filters]),
    /** Live-pump subscriptions re-issued after their socket authenticated. */
    liveAuthRetries: () => authRetries.live,
    /** One-shot query subscriptions re-issued after their socket authenticated. */
    queryAuthRetries: () => authRetries.query,
    /** When live-subscription sockets issued their REQ (the reconnect rhythm). */
    liveSubscriptionReqs: () => [...liveSubscriptionReqs],
    /** How many times the page has asked for records of this kind. */
    requestsFor: (kind: number) =>
      requestedKinds.filter((asked) => asked === kind).length,
    /** Every live subscription the page currently holds, to wait for one before delivering to it. */
    subscriptionFilters: () =>
      [...sockets].flatMap((socket) => [
        ...(subscriptions.get(socket)?.values() ?? []),
      ]),
    /** Start hanging up on every socket that speaks (or on matching REQs). */
    setClosingSockets: (
      value: boolean | ((filter: Filter | undefined) => boolean),
    ) => {
      closingSockets = value;
    },
    /**
     * Leave matching reads unanswered, as a server that is slow to answer does (the socket stays open and nothing
     * comes back): what a page shows while one of its reads has stalled.
     */
    holdReads: (matching: (filter: Filter) => boolean) => {
      heldFilter = matching;
    },
    /** Stop holding reads, and answer the held ones from what the server has now. */
    releaseReads: () => {
      heldFilter = null;
      for (const answer of heldReads.splice(0)) {
        try {
          answer();
        } catch {
          // The page gave up on that read and closed its socket.
        }
      }
    },
    /** Timestamps of those opens, to read the reconnect rhythm. */
    openedAt: () => [...openedAt],
  };
}
