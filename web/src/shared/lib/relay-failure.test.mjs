import assert from "node:assert/strict";
import test from "node:test";

import {
  finalizeRelayQuery,
  isAuthRequiredMessage,
  isErrorNotice,
  relayAnswered,
  relayFailureGuidance,
  relayFailureOutcome,
  relayMessageOf,
} from "./relay-failure.ts";
import {
  SigningBlockedError,
  SIGNING_BLOCKED_MESSAGE,
} from "./nostr-signer.ts";

/**
 * The four-outcome table, driven by the shapes the socket and the HTTP bridge
 * actually produce. Each row is a real observed answer, not a synthesised one:
 * EOSE with nothing, a timeout, an error NOTICE, a `missing Nostr auth` body,
 * a `CLOSED` refusal, and the local locked-passkey failure.
 */

test("eose with zero events is success, never a failure", () => {
  const outcome = finalizeRelayQuery({ events: [], notices: [] });
  assert.deepEqual(outcome, { state: "ok", events: [] });
  // The empty state the page renders is derived from this, so it must stay
  // reachable only here — see the answered-never-empty regression below.
  assert.equal(outcome.state, "ok");
});

test("an answered refusal keeps the relay's wording verbatim", () => {
  const relayMessage = "restricted: unknown event kind";
  const outcome = finalizeRelayQuery({
    events: [],
    failure: relayAnswered(relayMessage),
  });
  assert.deepEqual(outcome, { state: "answered", message: relayMessage });
  assert.equal(relayMessageOf(relayAnswered(relayMessage)), relayMessage);
});

test("a timeout with no answer stays unanswered", () => {
  const outcome = finalizeRelayQuery({
    events: [],
    failure: new Error("Relay query timed out after 10000ms"),
  });
  assert.deepEqual(outcome, { state: "unanswered" });
});

test("an error NOTICE is an answer even when the socket later dies", () => {
  const outcome = finalizeRelayQuery({
    events: [],
    notices: ["restricted: unknown event kind"],
    failure: new Error("WebSocket connection failed"),
  });
  assert.deepEqual(outcome, {
    state: "answered",
    message: "restricted: unknown event kind",
  });
});

test("an answered error never renders as an empty result (regression)", () => {
  // The shipped defect: an ANSWERED error was folded into "no events", so the
  // page showed its empty state — "no projects yet" — for a relay that had
  // just said "restricted". Removing the notice/refusal branch must fail here.
  for (const failure of [
    relayAnswered("restricted: unknown event kind"),
    relayAnswered("missing Nostr auth"),
    new Error("Relay query timed out after 10000ms"),
  ]) {
    const outcome = finalizeRelayQuery({
      events: [],
      notices: ["restricted: unknown event kind"],
      failure,
    });
    assert.notEqual(
      outcome.state,
      "ok",
      `empty-success must not be derivable from ${String(failure)}`,
    );
  }
});

test("auth-required outranks a transport failure and an answered refusal", () => {
  // The user's chain: passkey locked -> cannot sign NIP-42 AUTH -> every
  // query dies -> the app said "did not answer". Detection must win.
  const blocked = new SigningBlockedError(SIGNING_BLOCKED_MESSAGE);
  assert.equal(relayFailureOutcome(blocked), "auth-required");
  assert.equal(
    relayFailureOutcome(relayAnswered("missing Nostr auth")),
    "auth-required",
  );
  assert.equal(
    relayFailureOutcome(relayAnswered("auth-required: not authenticated")),
    "auth-required",
  );

  const localBlocked = finalizeRelayQuery({ events: [], failure: blocked });
  assert.equal(localBlocked.state, "auth-required");
  assert.equal(localBlocked.message, SIGNING_BLOCKED_MESSAGE);

  const httpBody = finalizeRelayQuery({
    events: [],
    failure: relayAnswered("missing Nostr auth"),
  });
  assert.deepEqual(httpBody, {
    state: "auth-required",
    message: "missing Nostr auth",
  });

  // A NOTICE that demands auth classifies the same way.
  const notice = finalizeRelayQuery({
    events: [],
    notices: ["auth-required: authenticate before subscribing"],
    failure: new Error("Relay query timed out after 10000ms"),
  });
  assert.equal(notice.state, "auth-required");
});

test("an answered refusal that signing will not fix stays answered", () => {
  // `restricted: … #p …` means the *filter* is wrong for this identity, not
  // that a sign-in tap fixes it — offering sign-in here would be a lie.
  assert.equal(
    relayFailureOutcome(
      relayAnswered(
        "restricted: p-gated events require #p matching your pubkey",
      ),
    ),
    "answered",
  );
  assert.equal(
    relayFailureOutcome(new Error("WebSocket connection failed")),
    "unanswered",
  );
});

test("auth-required wording and error notices are matched narrowly", () => {
  assert.equal(isAuthRequiredMessage("missing Nostr auth"), true);
  assert.equal(isAuthRequiredMessage("auth-required: not authenticated"), true);
  assert.equal(isAuthRequiredMessage("relay responded 500"), false);
  assert.equal(
    isAuthRequiredMessage(
      "restricted: p-gated events require #p matching your pubkey",
    ),
    false,
  );

  assert.equal(isErrorNotice("restricted: unknown event kind"), true);
  assert.equal(isErrorNotice("auth-required: not authenticated"), true);
  // Informational notices must not be promoted to terminal answers.
  assert.equal(isErrorNotice("rate limited, retry in 4s"), false);
  assert.equal(isErrorNotice("welcome to the relay"), false);
});

test("unknown-kind guidance names the kinds and the relay-side fix", () => {
  const guided = relayFailureGuidance(
    "restricted: unknown event kind",
    [37015, 37016],
  );
  assert.equal(
    guided,
    "This relay is running an older build that doesn't know these records (kind 37015, 37016) — restart it from the current build, or point the app at a newer relay.",
  );
  // Without caller-supplied kinds it falls back to whatever the relay named.
  assert.match(
    relayFailureGuidance("restricted: unknown event kind 30180"),
    /\(kind 30180\)/,
  );
  assert.match(
    relayFailureGuidance("restricted: unknown event kind"),
    /older build that doesn't know these records/,
  );

  // Any other refusal gets the honest generic line, not the upgrade advice.
  const generic = relayFailureGuidance(
    "restricted: not a channel member",
    [37015],
  );
  assert.match(generic, /refused this request/);
  assert.doesNotMatch(generic, /older build/);
});
