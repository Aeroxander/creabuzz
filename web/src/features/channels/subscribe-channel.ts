/**
 * Persistent WebSocket subscription for one channel.
 *
 * One relay connection per subscription, AUTH once, then live EVENTs until
 * unsubscribe. History is fetched separately via the one-shot client; this
 * pump only delivers events that arrive after the subscription opens.
 */

import { makeAuthEvent } from "nostr-tools/nip42";

import {
  signNostrEvent,
  type SignedNostrEvent,
} from "@/shared/lib/nostr-signer";
import type { NostrFilter } from "@/shared/lib/nostr-client";

export interface ChannelSubscriptionCallbacks {
  onEvent: (event: SignedNostrEvent) => void;
}

export function subscribeChannel(
  wsUrl: string,
  filter: NostrFilter,
  callbacks: ChannelSubscriptionCallbacks,
): () => void {
  let closed = false;
  let socket: WebSocket | null = null;
  let authAccepted = false;
  const subId = `live-${Math.random().toString(36).slice(2)}`;
  const pendingAuthReq: (() => void)[] = [];

  const cleanup = () => {
    closed = true;
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
    socket = new WebSocket(wsUrl);
    socket.addEventListener("open", () => {
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
    });
    socket.addEventListener("close", () => {
      // Auto-reconnect with a short backoff (subscription stays live).
      if (!closed) setTimeout(open, 1000);
    });
    socket.addEventListener("error", () => {
      socket?.close();
    });
  };

  open();
  return cleanup;
}
