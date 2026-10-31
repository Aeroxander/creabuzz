/**
 * Persistent WebSocket subscription for one channel.
 *
 * One relay connection per subscription, AUTH once, then live EVENTs until
 * unsubscribe. History is fetched separately via the one-shot client; this
 * pump only delivers events that arrive after the subscription opens.
 *
 * Two things changed once the shell started caring about the connection:
 * reconnects back off (previously every open tab retried a dead relay once a
 * second forever, with nothing telling the reader live updates had stopped),
 * and the state is reported so the UI can say so.
 */

import { makeAuthEvent } from "nostr-tools/nip42";

import { signForRelay } from "@/shared/lib/relay-auth";
import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";
import type { NostrFilter } from "@/shared/lib/nostr-client";

import {
  isFinalRefusal,
  RATE_LIMIT_RETRIES,
  rateLimitRetryDelay,
  ReconnectBackoff,
  type SubscriptionStatus,
} from "./lib/reconnect";

export type { SubscriptionStatus };

export interface ChannelSubscriptionCallbacks {
  onEvent: (event: SignedNostrEvent) => void;
  /**
   * Called on every state change, including the first connect attempt. With `refused`, `reason` is the relay's own
   * words; the subscription has stopped for good.
   */
  onStatus?: (status: SubscriptionStatus, reason?: string) => void;
}

export function subscribeChannel(
  wsUrl: string,
  filter: NostrFilter,
  callbacks: ChannelSubscriptionCallbacks,
): () => void {
  let closed = false;
  let socket: WebSocket | null = null;
  let authAccepted = false;
  /** One retry is allowed after authentication; a second refusal is final. */
  let authRetryUsed = false;
  let retryAfterAuth = false;
  /**
   * Reconnect policy. It only resets once the relay answers this subscription,
   * not when the socket merely opens: an accept-then-close relay would
   * otherwise re-open at the first step forever (see `ReconnectBackoff`).
   */
  const backoff = new ReconnectBackoff();
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Waiting out the server's request limit before asking again, and how many times in a row. */
  let limitTimer: ReturnType<typeof setTimeout> | null = null;
  let limitAttempts = 0;
  const subId = `live-${Math.random().toString(36).slice(2)}`;
  const pendingAuthReq: (() => void)[] = [];

  /** Whether this socket has issued its REQ already. */
  let subSent = false;

  const cleanup = () => {
    closed = true;
    if (retryTimer != null) clearTimeout(retryTimer);
    if (limitTimer != null) clearTimeout(limitTimer);
    try {
      socket?.close();
    } catch {
      // ignore
    }
  };

  const sendReq = () => {
    if (closed || !socket || subSent) return;
    subSent = true;
    socket.send(JSON.stringify(["REQ", subId, filter]));
  };

  const open = () => {
    if (closed) return;
    callbacks.onStatus?.(backoff.attempt === 0 ? "connecting" : "reconnecting");
    if (limitTimer != null) clearTimeout(limitTimer);
    limitTimer = null;
    socket = new WebSocket(wsUrl);
    socket.addEventListener("open", () => {
      authAccepted = false;
      subSent = false;
      // A fresh socket gets a fresh retry: the race is per connection.
      authRetryUsed = false;
      retryAfterAuth = false;
      // Sky relay may challenge us after connect with AUTH; require the
      // challenge round-trip before issuing REQ like the one-shot client.
      const unauthTimer = setTimeout(() => {
        if (!authAccepted) sendReq();
      }, 150);
      (socket as WebSocket).addEventListener("message", (msg) => {
        let data: unknown;
        try {
          data = JSON.parse(String(msg.data));
        } catch {
          return;
        }
        if (!Array.isArray(data)) return;
        const [type] = data;
        if (type === "AUTH" && typeof data[1] === "string") {
          clearTimeout(unauthTimer);
          const template = makeAuthEvent(wsUrl, String(data[1]));
          void signForRelay(template).then((signed) => {
            if (closed) return;
            socket?.send(JSON.stringify(["AUTH", signed]));
          });
        } else if (type === "OK" && data[1] && data[2] === true) {
          authAccepted = true;
          for (const req of pendingAuthReq) req();
          pendingAuthReq.length = 0;
          const owed = retryAfterAuth;
          retryAfterAuth = false;
          if (owed) {
            // The relay closed the subscription we sent before the handshake;
            // it is worth resending now that it can authorize us.
            subSent = false;
          }
          sendReq();
        } else if (type === "OK" && data[2] === false) {
          // The relay refused our login or is ending the session, with its reason (a ban arriving now, or a community
          // the reader is not in). When that is final, stop and say so; reconnecting would be refused the same way.
          const reason = typeof data[3] === "string" ? data[3] : "";
          if (isFinalRefusal(reason)) {
            cleanup();
            callbacks.onStatus?.("refused", reason);
          }
        } else if (type === "EVENT" && data[1] === subId && data[2]) {
          backoff.onHealthy();
          limitAttempts = 0;
          callbacks.onEvent(data[2] as SignedNostrEvent);
        } else if (type === "EOSE" && data[1] === subId) {
          // The relay finished replaying for this subscription: it works.
          backoff.onHealthy();
          limitAttempts = 0;
        } else if (type === "CLOSED" && data[1] === subId) {
          // A relay rejects a subscription sent before our NIP-42 handshake
          // finished (Buzz's relay compares the filter against the
          // authenticated identity). That is not a reason to give up on the
          // channel — re-issue it once we are authenticated, and only treat a
          // second refusal as final.
          const reason = typeof data[2] === "string" ? data[2] : "";
          if (!authRetryUsed && /auth|restricted/i.test(reason)) {
            authRetryUsed = true;
            if (authAccepted) {
              subSent = false;
              sendReq();
            } else {
              retryAfterAuth = true;
            }
            return;
          }
          // Over the person's request limit: wait what the server says (longer each time in a row) and ask again on the
          // same socket. Only a limit that never clears ends the subscription.
          const wait =
            limitAttempts < RATE_LIMIT_RETRIES
              ? rateLimitRetryDelay(reason, limitAttempts + 1)
              : null;
          if (wait !== null) {
            limitAttempts += 1;
            callbacks.onStatus?.("reconnecting");
            limitTimer = setTimeout(() => {
              limitTimer = null;
              if (closed) return;
              subSent = false;
              sendReq();
              callbacks.onStatus?.("open");
            }, wait);
            return;
          }
          // Refused for good (removed from the room or board, or the server will not serve this filter): stop, and
          // say so, instead of looking live while nothing will ever arrive.
          cleanup();
          callbacks.onStatus?.("refused", reason);
        }
      });
      callbacks.onStatus?.("open");
    });
    socket.addEventListener("close", () => {
      if (closed) return;
      callbacks.onStatus?.("reconnecting");
      retryTimer = setTimeout(open, backoff.onClose());
    });
    socket.addEventListener("error", () => {
      socket?.close();
    });
  };

  open();
  return cleanup;
}
