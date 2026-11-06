/**
 * One-shot event publishing over the relay WebSocket.
 *
 * Connects, completes the NIP-42 AUTH round-trip (signed by the same identity
 * that signed the event, or the caller-provided signer), sends EVENT, and
 * resolves on the relay's OK for this event id.
 */

import { makeAuthEvent } from "nostr-tools/nip42";

import { assertMayAct } from "./action-guard.ts";
import { signForRelay } from "./relay-auth.ts";
import type { SignedNostrEvent } from "./nostr-signer.ts";

const PUBLISH_TIMEOUT_MS = 12_000;

/**
 * True when the server refused a record only because the login had not gone through yet (`auth-required: not
 * authenticated`): the record itself was not judged, so it can be sent again once the login has.
 */
function refusedBeforeLogin(message: string | undefined): boolean {
  return (
    typeof message === "string" &&
    message.startsWith("auth-required: not authenticated")
  );
}

export interface PublishResult {
  accepted: boolean;
  message?: string;
}

export interface PublishOptions {
  /** AUTH signer; defaults to the page-lifetime key like the read clients. */
  signAuth?: (template: {
    kind: number;
    created_at?: number;
    tags: string[][];
    content: string;
  }) => Promise<SignedNostrEvent>;
}

export function publishEvent(
  wsUrl: string,
  event: SignedNostrEvent,
  options: PublishOptions = {},
): Promise<PublishResult> {
  // Changed terms not yet agreed to: nothing goes out as the person (`action-guard.ts`).
  try {
    assertMayAct();
  } catch (error) {
    return Promise.reject(error);
  }
  // Authenticate as the identity the app presents (see `relay-auth`): the relay
  // authorizes p-gated writes and per-identity rate limits against it.
  const signAuth = options.signAuth ?? signForRelay;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let settled = false;
    let sent = false;
    // The login: whether the server asked for one, its id once sent, whether it went through.
    let challenged = false;
    let authId: string | null = null;
    let authAccepted = false;
    // A record sent before a late login went through is sent once more after it (never more).
    let resent = false;
    let fallback: ReturnType<typeof setTimeout> | null = null;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        ws.close();
        reject(new Error("Server publish timed out"));
      }
    }, PUBLISH_TIMEOUT_MS);

    const send = () => {
      if (settled || sent) return;
      sent = true;
      ws.send(JSON.stringify(["EVENT", event]));
    };

    const finish = (result: PublishResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // ignore
      }
      resolve(result);
    };

    ws.addEventListener("open", () => {
      // Wait for the relay's AUTH challenge (Buzz relays always send one);
      // fall back to an unauthenticated EVENT only if none arrives. Once one has,
      // the EVENT waits for the login to go through: a slow signer or a slow
      // network must not send it ahead of the login, where it would be refused.
      fallback = setTimeout(() => {
        if (!challenged) send();
      }, 400);
    });

    ws.addEventListener("message", (msg) => {
      let data: unknown;
      try {
        data = JSON.parse(String(msg.data));
      } catch {
        return;
      }
      if (!Array.isArray(data)) return;
      const [type] = data;
      if (type === "AUTH" && typeof data[1] === "string") {
        challenged = true;
        if (fallback !== null) clearTimeout(fallback);
        const template = makeAuthEvent(wsUrl, String(data[1]));
        void signAuth(template).then(
          (signed) => {
            if (settled) return;
            authId = signed.id;
            ws.send(JSON.stringify(["AUTH", signed]));
          },
          (error: unknown) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            ws.close();
            reject(error instanceof Error ? error : new Error(String(error)));
          },
        );
      } else if (type === "OK") {
        const message = typeof data[3] === "string" ? data[3] : undefined;
        if (data[1] === event.id) {
          if (
            data[2] !== true &&
            challenged &&
            !resent &&
            refusedBeforeLogin(message)
          ) {
            // It went out ahead of the login (a challenge that came late): send it again once the login is in.
            resent = true;
            sent = false;
            if (authAccepted) send();
            return;
          }
          finish({ accepted: data[2] === true, message });
        } else if (data[1] === authId && data[2] === true) {
          // AUTH accepted for the auth-event id — now send EVENT.
          authAccepted = true;
          send();
        } else if (data[2] === false) {
          // The server refused the login (a ban, a community the reader is not in) or is ending the session with its
          // reason (a ban arriving now). Either way that is its answer; the hang-up that follows is not.
          finish({
            accepted: false,
            message:
              typeof data[3] === "string"
                ? data[3]
                : "The server refused to sign you in.",
          });
        }
      } else if (type === "CLOSED") {
        finish({ accepted: false, message: String(data[2] ?? "closed") });
      }
    });

    ws.addEventListener("error", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error("WebSocket connection failed"));
      }
    });

    // A server that hangs up without answering is a failure now, not after the
    // timeout: the caller can say so (or move to the next relay) at once.
    ws.addEventListener("close", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error("The connection closed before the server answered"));
      }
    });
  });
}

/** A connection kept open to send several records, logging in once. */
export interface PublishSession {
  /** Send one signed record and wait for the server's answer to it. */
  publish: (event: SignedNostrEvent) => Promise<PublishResult>;
  /** Hang up. Safe to call twice. */
  close: () => void;
}

/**
 * A connection for sending many records one after another.
 *
 * {@link publishEvent} opens a connection, logs in and hangs up for every
 * record, which is the right shape for one post and slow for thirty. A session
 * logs in once and then sends each record and waits for its answer, in order.
 * It never reconnects by itself: if the server hangs up, the record in flight
 * and every later `publish` fail at once, so a caller that stops on the first
 * failure (and can pick up again from the server's own state) loses nothing.
 */
export function openPublishSession(
  wsUrl: string,
  options: PublishOptions = {},
): PublishSession {
  const signAuth = options.signAuth ?? signForRelay;
  const ws = new WebSocket(wsUrl);
  let closedWith: Error | null = null;
  const waiting = new Map<
    string,
    {
      event: SignedNostrEvent;
      resolve: (result: PublishResult) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      resent: boolean;
    }
  >();
  // Whether the server asked for a login, and once it went through: a record sent ahead of a late login is sent again.
  let challenged = false;
  let markLoggedIn: () => void = () => {};
  const loggedIn = new Promise<void>((resolve) => {
    markLoggedIn = resolve;
  });

  // Ready once the server's login challenge has been answered, or once it has
  // had a moment to send one and did not (a server without a login step).
  let markReady: () => void = () => {};
  let markFailed: (error: Error) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    markReady = resolve;
    markFailed = reject;
  });
  // A session that is never used must not report an unhandled rejection.
  ready.catch(() => {});
  let authId: string | null = null;
  let readyTimer: ReturnType<typeof setTimeout> | null = null;
  /** The server's reason when it refused the login or ended the session: every record's answer from then on. */
  let refusal: string | null = null;

  const refuseAll = (reason: string) => {
    if (refusal === null) refusal = reason;
    markReady();
    for (const [id, entry] of waiting) {
      clearTimeout(entry.timer);
      waiting.delete(id);
      entry.resolve({ accepted: false, message: reason });
    }
  };

  const failAll = (error: Error) => {
    if (closedWith === null) closedWith = error;
    markFailed(error);
    for (const [id, entry] of waiting) {
      clearTimeout(entry.timer);
      waiting.delete(id);
      entry.reject(error);
    }
  };

  ws.addEventListener("open", () => {
    readyTimer = setTimeout(markReady, 400);
  });
  ws.addEventListener("message", (message) => {
    let data: unknown;
    try {
      data = JSON.parse(String(message.data));
    } catch {
      return;
    }
    if (!Array.isArray(data)) return;
    const [type] = data;
    if (type === "AUTH" && typeof data[1] === "string") {
      challenged = true;
      if (readyTimer !== null) clearTimeout(readyTimer);
      const template = makeAuthEvent(wsUrl, String(data[1]));
      void signAuth(template).then(
        (signed) => {
          authId = signed.id;
          ws.send(JSON.stringify(["AUTH", signed]));
        },
        (error: unknown) =>
          failAll(error instanceof Error ? error : new Error(String(error))),
      );
    } else if (type === "OK") {
      const reason =
        typeof data[3] === "string"
          ? data[3]
          : "The server refused to sign you in.";
      if (data[1] === authId) {
        if (data[2] === true) {
          markLoggedIn();
          markReady();
        } else refuseAll(reason);
        return;
      }
      const entry = waiting.get(String(data[1]));
      if (!entry) {
        // Not an answer to a record: the server ending the session with its reason (a ban arriving now).
        if (data[2] === false) refuseAll(reason);
        return;
      }
      if (
        data[2] !== true &&
        challenged &&
        !entry.resent &&
        refusedBeforeLogin(typeof data[3] === "string" ? data[3] : undefined)
      ) {
        // It went out ahead of a login that came late: send it again once the login is in (its timer still runs).
        entry.resent = true;
        void loggedIn.then(() => {
          if (waiting.get(entry.event.id) === entry) {
            ws.send(JSON.stringify(["EVENT", entry.event]));
          }
        });
        return;
      }
      clearTimeout(entry.timer);
      waiting.delete(String(data[1]));
      entry.resolve({
        accepted: data[2] === true,
        message: typeof data[3] === "string" ? data[3] : undefined,
      });
    } else if (type === "CLOSED") {
      // A subscription-style refusal names no record; fail the one in flight.
      const [first] = waiting.keys();
      if (first !== undefined) {
        const entry = waiting.get(first);
        if (entry) {
          clearTimeout(entry.timer);
          waiting.delete(first);
          entry.resolve({
            accepted: false,
            message: String(data[2] ?? "closed"),
          });
        }
      }
    }
  });
  ws.addEventListener("error", () =>
    failAll(new Error("WebSocket connection failed")),
  );
  ws.addEventListener("close", () => {
    if (refusal !== null) refuseAll(refusal);
    else failAll(new Error("The connection closed before the server answered"));
  });

  return {
    publish: async (event) => {
      assertMayAct();
      await ready;
      if (refusal !== null) return { accepted: false, message: refusal };
      if (closedWith !== null) throw closedWith;
      return new Promise<PublishResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(event.id);
          reject(new Error("Server publish timed out"));
        }, PUBLISH_TIMEOUT_MS);
        waiting.set(event.id, { event, resolve, reject, timer, resent: false });
        try {
          ws.send(JSON.stringify(["EVENT", event]));
        } catch (error) {
          clearTimeout(timer);
          waiting.delete(event.id);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    close: () => {
      if (readyTimer !== null) clearTimeout(readyTimer);
      if (closedWith === null)
        closedWith = new Error("The connection was closed");
      try {
        ws.close();
      } catch {
        // already closed
      }
    },
  };
}
