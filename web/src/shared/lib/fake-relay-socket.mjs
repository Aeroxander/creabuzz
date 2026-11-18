/**
 * A scripted relay behind a fake `WebSocket`, for tests that count what a page costs the network.
 *
 * It speaks the part of the protocol `queryEvents` uses: a NIP-42 challenge on open, `OK` for the signed answer, and for
 * a REQ the events each filter holds (newest first, cut to its `limit`, an event named by two filters sent twice unless
 * `dedupe`), then EOSE. Every step waits `oneWayMs`, and a socket takes `connectMs` to open, so wall time stands in for
 * round trips. `stats()` reports what a read cost: the sockets opened, the REQs sent, the filters in them, and
 * `serialHops`, the longest chain of sockets where each opened only after the one before it had closed (what a reader
 * far from the server waits for, one handshake after another).
 */

/** The matching a relay does, written out here so a test never leans on the matcher the client ships. */
function holds(filter, event) {
  if (filter.ids && !filter.ids.includes(event.id)) return false;
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.since !== undefined && event.created_at < filter.since) {
    return false;
  }
  if (filter.until !== undefined && event.created_at > filter.until) {
    return false;
  }
  for (const [key, wanted] of Object.entries(filter)) {
    if (!key.startsWith("#")) continue;
    const name = key.slice(1);
    if (!event.tags.some((t) => t[0] === name && wanted.includes(t[1]))) {
      return false;
    }
  }
  return true;
}

const later = (ms, fn) => setTimeout(fn, ms);

/**
 * @param {object} options
 * @param {object[]} options.events What the relay stores.
 * @param {number} [options.oneWayMs] Delay of every message, either way.
 * @param {number} [options.connectMs] Delay before a socket opens.
 * @param {boolean} [options.dedupe] Send an event once even when several filters hold it.
 * @param {(filters: object[]) => string | null} [options.refuse] A reason to answer a REQ with CLOSED.
 */
export function installFakeRelay({
  events,
  oneWayMs = 0,
  connectMs = 0,
  dedupe = false,
  refuse = () => null,
}) {
  const sockets = [];
  let clock = 0;

  class FakeRelaySocket {
    constructor(url) {
      this.url = url;
      this.listeners = new Map();
      this.sent = [];
      this.reqs = [];
      this.closed = false;
      this.opened = clock++;
      // Sockets already finished when this one was made: the ones it waited for.
      this.waitedFor = sockets.filter((s) => s.closed);
      sockets.push(this);
      later(connectMs, () => {
        this.emit("open", {});
        later(oneWayMs, () => this.message(["AUTH", "challenge"]));
      });
    }
    addEventListener(type, fn) {
      const list = this.listeners.get(type) ?? [];
      list.push(fn);
      this.listeners.set(type, list);
    }
    emit(type, event) {
      for (const fn of this.listeners.get(type) ?? []) fn(event);
    }
    message(payload) {
      if (this.closed) return;
      this.emit("message", { data: JSON.stringify(payload) });
    }
    send(raw) {
      const frame = JSON.parse(raw);
      this.sent.push(frame);
      if (frame[0] === "AUTH") {
        later(2 * oneWayMs, () => this.message(["OK", frame[1].id, true, ""]));
      } else if (frame[0] === "REQ") {
        const [, subId, ...filters] = frame;
        this.reqs.push(filters);
        later(2 * oneWayMs, () => this.answer(subId, filters));
      }
    }
    answer(subId, filters) {
      const reason = refuse(filters);
      if (reason !== null) {
        this.message(["CLOSED", subId, reason]);
        return;
      }
      const sent = new Set();
      for (const filter of filters) {
        const hits = events
          .filter((e) => holds(filter, e))
          .sort((a, b) => b.created_at - a.created_at)
          .slice(0, filter.limit ?? events.length);
        for (const event of hits) {
          if (dedupe && sent.has(event.id)) continue;
          sent.add(event.id);
          this.message(["EVENT", subId, event]);
        }
      }
      this.message(["EOSE", subId]);
    }
    close() {
      if (this.closed) return;
      this.closed = true;
      queueMicrotask(() => this.emit("close", {}));
    }
  }

  const depth = (socket) =>
    1 + Math.max(0, ...socket.waitedFor.map((s) => depth(s)));

  return {
    FakeRelaySocket,
    /** Install as the global `WebSocket`. */
    install() {
      globalThis.WebSocket = FakeRelaySocket;
    },
    reset() {
      sockets.length = 0;
      clock = 0;
    },
    stats() {
      return {
        sockets: sockets.length,
        reqs: sockets.reduce((n, s) => n + s.reqs.length, 0),
        filters: sockets.reduce(
          (n, s) => n + s.reqs.reduce((m, f) => m + f.length, 0),
          0,
        ),
        serialHops: Math.max(0, ...sockets.map(depth)),
      };
    },
    /** The filters of every REQ sent, in the order the sockets were made. */
    requests() {
      return sockets.flatMap((s) => s.reqs);
    },
  };
}
