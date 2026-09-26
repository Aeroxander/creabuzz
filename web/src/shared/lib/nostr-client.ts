/**
 * Minimal Nostr client with NIP-01 queries and NIP-42 AUTH.
 *
 * Uses NIP-07 when a browser extension is available, with an ephemeral
 * page-lifetime identity as the fallback for read-only queries on open relays.
 */

import { makeAuthEvent } from "nostr-tools/nip42";
import { signForRelay } from "./relay-auth.ts";
import {
  finalizeRelayQuery,
  isAuthRequiredMessage,
  relayAnswered,
} from "./relay-failure.ts";
import {
  isSigningBlockedError,
  type SignedNostrEvent,
} from "./nostr-signer.ts";

export interface NostrFilter {
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  since?: number;
  until?: number;
  limit?: number;
  /** NIP-50 full-text search term (routed to search by the relay). */
  search?: string;
  [tag: `#${string}`]: string[] | undefined;
}

export type NostrEvent = SignedNostrEvent;

const QUERY_TIMEOUT_MS = 10_000;

export interface QueryOptions {
  /**
   * Bounded wait for the relay's EOSE. Defaults to the 10s the app ships;
   * overridable so tests can prove the wait is bounded without waiting it out.
   */
  timeoutMs?: number;
}

/**
 * Open a WebSocket to `wsUrl`, authenticate via NIP-42 if challenged,
 * send a REQ with the given filter, collect EVENTs until EOSE, then
 * close and return them.
 *
 * Failures are four-way (`lib/relay-failure.ts`): an answered refusal rejects
 * with the relay's verbatim wording, an auth-required refusal (private relay,
 * or a locked passkey that cannot sign the challenge) rejects with wording
 * that classifies as such, an unanswered transport failure rejects with the
 * transport reason, and everything else propagates untouched.
 */
export function queryEvents(
  wsUrl: string,
  filter: NostrFilter,
  options: QueryOptions = {},
): Promise<NostrEvent[]> {
  const timeoutMs = options.timeoutMs ?? QUERY_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const events: NostrEvent[] = [];
    /** Everything the relay said without being asked — see `finalizeRelayQuery`. */
    const notices: string[] = [];
    const subId = `q-${Date.now().toString(36)}`;
    let settled = false;
    let reqSent = false;
    let authEventId: string | null = null;
    let authAccepted = false;
    let authChallengeSeen = false;
    /** Auth refusal the relay *stated* (CLOSED/NOTICE), wording kept. */
    let authRefusalText: string | null = null;
    /** One retry is allowed after authentication; a second refusal is real. */
    let authRetryUsed = false;
    let retryAfterAuth = false;
    let unauthenticatedReqTimer: ReturnType<typeof setTimeout> | null = null;

    const ws = new WebSocket(wsUrl);

    /**
     * Terminal failure: classify first so a refusal the relay *stated* never
     * degrades into "the relay did not answer" (and a stated refusal keeps its
     * verbatim wording), then reject exactly once.
     */
    const settleFailure = (failure: unknown) => {
      const outcome = finalizeRelayQuery({ events, notices, failure });
      switch (outcome.state) {
        case "unanswered":
          reject(failure);
          return;
        case "auth-required":
          // A local signing block keeps its own error type — it IS the
          // precondition the sign-in action relieves — and a stated refusal
          // keeps wording the page can render verbatim.
          reject(
            isSigningBlockedError(failure)
              ? failure
              : relayAnswered(
                  outcome.message ?? String((failure as Error)?.message ?? ""),
                ),
          );
          return;
        case "ok":
          // Only reachable when `failure` was falsy — nothing stated anything.
          reject(failure);
          return;
        default:
          reject(relayAnswered(outcome.message));
      }
    };

    /**
     * EOSE: the relay answered. An empty list is only "nothing here" when the
     * relay did not simultaneously state a refusal.
     */
    const settleSuccess = () => {
      const outcome = finalizeRelayQuery({ events, notices });
      switch (outcome.state) {
        case "ok":
          resolve(outcome.events);
          return;
        case "unanswered":
          // Unreachable without a `failure`; stated so a future edit that
          // makes it reachable fails loudly instead of resolving `[]`.
          reject(new Error("Relay query ended without an answer."));
          return;
        default:
          // Both refusal shapes reject with wording `relayMessageOf` can read,
          // so the page renders them as what they are and not as a timeout.
          reject(relayAnswered(outcome.message ?? "auth-required"));
      }
    };

    /**
     * The relay challenged us for NIP-42 AUTH and dropped the socket before
     * accepting it. That is an auth refusal wearing a network failure's
     * clothes: the reader's next step is signing in, not checking their wifi.
     */
    const authOutcome = () => {
      if (authRefusalText !== null) return relayAnswered(authRefusalText);
      return authChallengeSeen && !authAccepted
        ? relayAnswered(
            "auth-required: the relay closed the connection before it accepted this browser's authentication.",
          )
        : null;
    };

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        ws.close();
        settleFailure(
          authRefusalText !== null
            ? relayAnswered(authRefusalText)
            : new Error(`Relay query timed out after ${timeoutMs}ms`),
        );
      }
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      if (unauthenticatedReqTimer) {
        clearTimeout(unauthenticatedReqTimer);
      }
      try {
        ws.close();
      } catch {
        // ignore
      }
    };

    const sendReq = (force = false) => {
      if (force) reqSent = false;
      if (!reqSent) {
        reqSent = true;
        ws.send(JSON.stringify(["REQ", subId, filter]));
      }
    };

    /**
     * A relay can reject a subscription that arrived before our NIP-42
     * handshake finished — Buzz's relay does, with "restricted: p-gated events
     * require #p matching your pubkey", because it compares the filter against
     * the authenticated identity. That is not a refusal of the query: retry it
     * once after authenticating, and treat a second refusal as final.
     */
    const isAuthRefusal = (reason: string) => /auth|restricted/i.test(reason);

    ws.addEventListener("open", () => {
      // Wait briefly for an AUTH challenge before sending REQ.
      // Buzz relays always send AUTH, but other relays may not.
      unauthenticatedReqTimer = setTimeout(() => sendReq(), 100);
    });

    ws.addEventListener("message", async (msg) => {
      let data: unknown;
      try {
        data = JSON.parse(String(msg.data));
      } catch {
        return;
      }
      if (!Array.isArray(data)) return;

      const [type] = data;

      if (type === "AUTH" && typeof data[1] === "string") {
        // NIP-42: relay sent an AUTH challenge — sign and respond.
        authChallengeSeen = true;
        if (unauthenticatedReqTimer) {
          clearTimeout(unauthenticatedReqTimer);
          unauthenticatedReqTimer = null;
        }
        const challenge = data[1];
        const template = makeAuthEvent(wsUrl, challenge);
        try {
          const signed = await signForRelay(template);
          if (settled) return;
          authEventId = signed.id;
          ws.send(JSON.stringify(["AUTH", signed]));
        } catch (error) {
          if (!settled) {
            settled = true;
            cleanup();
            // A locked passkey lands here: classify it as auth-required so the
            // page offers the sign-in action instead of a bare refusal.
            settleFailure(
              error instanceof Error
                ? error
                : new Error("Failed to sign relay authentication."),
            );
          }
        }
        return;
      }

      if (type === "OK" && data[1] === authEventId) {
        if (data[2] === true) {
          authAccepted = true;
          const owed = retryAfterAuth;
          retryAfterAuth = false;
          sendReq(owed);
        } else if (!settled) {
          settled = true;
          cleanup();
          // The relay answered and said no — keep its wording verbatim.
          settleFailure(
            relayAnswered(
              typeof data[3] === "string"
                ? data[3]
                : "Relay authentication failed.",
            ),
          );
        }
        return;
      }

      if (type === "EVENT" && data[1] === subId && data[2]) {
        events.push(data[2] as NostrEvent);
      } else if (type === "EOSE" && data[1] === subId) {
        if (!settled) {
          settled = true;
          cleanup();
          settleSuccess();
        }
      } else if (type === "CLOSED" && data[1] === subId) {
        // Subscription was rejected.
        if (!settled) {
          const reason =
            typeof data[2] === "string"
              ? data[2]
              : "subscription closed by relay";
          if (isAuthRequiredMessage(reason)) authRefusalText = reason;
          if (isAuthRefusal(reason) && !authRetryUsed) {
            // Sent before the handshake finished: re-issue it once we can.
            authRetryUsed = true;
            if (authAccepted) sendReq(true);
            else retryAfterAuth = true;
            return;
          }
          settled = true;
          cleanup();
          settleFailure(relayAnswered(reason));
        }
      } else if (type === "NOTICE" && typeof data[1] === "string") {
        // The relay spoke without being asked. Recorded, not swallowed: an
        // error notice is an answer, and `finalizeRelayQuery` gives it the
        // last word when the query then times out or comes back empty.
        if (isAuthRequiredMessage(data[1])) authRefusalText = data[1];
        notices.push(data[1]);
      }
    });

    ws.addEventListener("error", () => {
      if (!settled) {
        settled = true;
        cleanup();
        settleFailure(
          authOutcome() ?? new Error("WebSocket connection failed"),
        );
      }
    });

    ws.addEventListener("close", () => {
      // Without EOSE the relay never finished answering. Resolving here would
      // hand the caller a partial list as an authoritative result — a dropped
      // socket would read as "this channel is empty" — so a close is a failure.
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        settleFailure(
          authOutcome() ??
            new Error(
              "Relay closed the connection before finishing the query.",
            ),
        );
      }
    });
  });
}
