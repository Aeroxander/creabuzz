import type { Page } from "@playwright/test";

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

/** NIP-01 filter match, limited to what the client actually sends. */
export function matches(filter: Filter, event: StoredEvent): boolean {
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  for (const [key, value] of Object.entries(filter)) {
    if (!key.startsWith("#")) continue;
    const tagName = key.slice(1);
    const wanted = Array.isArray(value) ? (value as string[]) : [];
    if (wanted.length === 0) continue;
    const present = tagValue(event, tagName);
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
}

export function createMockRelay({
  refuse,
  closeImmediately = false,
}: MockRelayOptions = {}) {
  const events: StoredEvent[] = [];
  const sockets = new Set<Socket>();
  let connectionsOpened = 0;
  const openedAt: number[] = [];
  /** Flipped on by a test that wants to watch the reconnect policy. */
  let closingSockets = closeImmediately;
  /** When each live-subscription socket asked for its subscription. */
  const liveSubscriptionReqs: number[] = [];
  const subscriptions = new WeakMap<Socket, Map<string, Filter>>();

  const deliver = (event: StoredEvent) => {
    // A delivered event is an accepted one: store it before fanning out, or a
    // one-shot query issued afterwards would never see it.
    if (!events.some((stored) => stored.id === event.id)) events.push(event);
    for (const socket of sockets) {
      const subs = subscriptions.get(socket);
      if (!subs) continue;
      for (const [subId, filter] of subs) {
        if (matches(filter, event)) {
          socket.send(JSON.stringify(["EVENT", subId, event]));
        }
      }
    }
  };

  const install = async (page: Page) => {
    await page.route("**/communities", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ communities: [] }),
      });
    });
    await page.routeWebSocket(/127\.0\.0\.1:4173/, (ws) => {
      connectionsOpened += 1;
      openedAt.push(Date.now());
      const socket: Socket = {
        send: (payload) => ws.send(payload),
        close: () => ws.close(),
      };

      sockets.add(socket);
      subscriptions.set(socket, new Map());
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
        if (closingSockets && parsed[0] === "REQ") {
          // Accept, let the client use the connection, then hang up: the client
          // must back off, not reconnect at the first step forever.
          ws.close();
          return;
        }
        const [type] = parsed;
        if (type === "EVENT" || type === "AUTH") {
          const event = parsed[1] as StoredEvent;
          if (type === "EVENT") {
            const reason = refuse?.(event);
            if (reason) {
              // Rejected writes are not stored and not fanned out: a client
              // that ignores the OK must not look like it succeeded.
              ws.send(JSON.stringify(["OK", event.id, false, reason]));
              return;
            }
            events.push(event);
            // Fan out after acknowledging, as a relay would.
            ws.send(JSON.stringify(["OK", event.id, true, ""]));
            deliver(event);
            return;
          }
          ws.send(JSON.stringify(["OK", event.id, true, ""]));
          return;
        }
        if (type === "REQ") {
          const [, subId, filter] = parsed as [string, string, Filter];
          subscriptions.get(socket)?.set(subId, filter);
          for (const event of events) {
            if (matches(filter, event)) {
              ws.send(JSON.stringify(["EVENT", subId, event]));
            }
          }
          ws.send(JSON.stringify(["EOSE", subId]));
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

  return {
    install,
    deliver,
    seed,
    dropConnections,
    events,
    /** Sockets the page has opened, across reconnects. */
    connectionsOpened: () => connectionsOpened,
    /** When live-subscription sockets issued their REQ (the reconnect rhythm). */
    liveSubscriptionReqs: () => [...liveSubscriptionReqs],
    /** Start hanging up on every socket that speaks. */
    setClosingSockets: (value: boolean) => {
      closingSockets = value;
    },
    /** Timestamps of those opens, to read the reconnect rhythm. */
    openedAt: () => [...openedAt],
  };
}
