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

import {
  signNostrEvent,
  type SignedNostrEvent,
} from "@/shared/lib/nostr-signer";
import type { NostrFilter } from "@/shared/lib/nostr-client";

import { reconnectDelay, type SubscriptionStatus } from "./lib/reconnect";

export { reconnectDelay };
export type { SubscriptionStatus };

export interface ChannelSubscriptionCallbacks {
  onEvent: (event: SignedNostrEvent) => void;
  /** Called on every state change, including the first connect attempt. */
  onStatus?: (status: SubscriptionStatus) => void;
}

export function subscribeChannel(
  wsUrl: string,
  filter: NostrFilter,
  callbacks: ChannelSubscriptionCallbacks,
): () => void {
  let closed = false;
  let socket: WebSocket | null = null;
  let authAccepted = false;
  /** Failed attempts since the last healthy open; drives the backoff. */
  let attempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  const subId = `live-${Math.random().toString(36).slice(2)}`;
  const pendingAuthReq: (() => void)[] = [];

  const cleanup = () => {
    closed = true;
    if (retryTimer != null) clearTimeout(retryTimer);
    try {
      socket?.close();
    } catch {
      // ignore
    }
  };

  const sendReq = () => {
    if (closed || !socket) return;
    socket.send(JSON.stringify(["REQ", subId, filter]));
  };

  const open = () => {
    if (closed) return;
    callbacks.onStatus?.(attempt === 0 ? "connecting" : "reconnecting");
    socket = new WebSocket(wsUrl);
    socket.addEventListener("open", () => {
      authAccepted = false;
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
          void signNostrEvent(template).then((signed) => {
            if (closed) return;
            socket?.send(JSON.stringify(["AUTH", signed]));
          });
        } else if (type === "OK" && data[1] && data[2] === true) {
          authAccepted = true;
          for (const req of pendingAuthReq) req();
          pendingAuthReq.length = 0;
          sendReq();
        } else if (type === "EVENT" && data[1] === subId && data[2]) {
          callbacks.onEvent(data[2] as SignedNostrEvent);
        } else if (type === "CLOSED" && data[1] === subId) {
          cleanup();
        }
      });
      // Healthy again: a later drop retries from the short delay.
      attempt = 0;
      callbacks.onStatus?.("open");
    });
    socket.addEventListener("close", () => {
      if (closed) return;
      attempt += 1;
      callbacks.onStatus?.("reconnecting");
      retryTimer = setTimeout(open, reconnectDelay(attempt));
    });
    socket.addEventListener("error", () => {
      socket?.close();
    });
  };

  open();
  return cleanup;
}
