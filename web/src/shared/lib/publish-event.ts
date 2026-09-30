/**
 * One-shot event publishing over the relay WebSocket.
 *
 * Connects, completes the NIP-42 AUTH round-trip (signed by the same identity
 * that signed the event, or the caller-provided signer), sends EVENT, and
 * resolves on the relay's OK for this event id.
 */

import { makeAuthEvent } from "nostr-tools/nip42";

import { signForRelay } from "@/shared/lib/relay-auth";
import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";

const PUBLISH_TIMEOUT_MS = 12_000;

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
  // Authenticate as the identity the app presents (see `relay-auth`): the relay
  // authorizes p-gated writes and per-identity rate limits against it.
  const signAuth = options.signAuth ?? signForRelay;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let settled = false;
    let sent = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        ws.close();
        reject(new Error("Relay publish timed out"));
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
      // fall back to an unauthenticated EVENT if it never arrives.
      setTimeout(send, 400);
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
        const template = makeAuthEvent(wsUrl, String(data[1]));
        void signAuth(template).then((signed) => {
          if (settled) return;
          ws.send(JSON.stringify(["AUTH", signed]));
        });
      } else if (type === "OK") {
        if (data[1] === event.id) {
          finish({
            accepted: data[2] === true,
            message: typeof data[3] === "string" ? data[3] : undefined,
          });
        } else if (data[2] === true && !sent) {
          // AUTH accepted for the auth-event id — now send EVENT.
          send();
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
  });
}
