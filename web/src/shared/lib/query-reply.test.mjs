import assert from "node:assert/strict";
import test from "node:test";

import { queryReplyEvents, UNREADABLE_QUERY_REPLY } from "./query-reply.ts";
import { relayFailureOutcome, relayMessageOf } from "./relay-failure.ts";

const RECORD = {
  id: "a".repeat(64),
  pubkey: "b".repeat(64),
  created_at: 1_700_000_000,
  kind: 1,
  tags: [],
  content: "hi",
  sig: "c".repeat(128),
};

const ok = { ok: true, status: 200 };

test("a list of records is returned as it came", () => {
  assert.deepEqual(queryReplyEvents({ response: ok, json: [RECORD] }), [
    RECORD,
  ]);
  assert.deepEqual(queryReplyEvents({ response: ok, json: [] }), []);
});

test("a 200 that is not a list of records is refused, never rendered as records or as empty", () => {
  for (const json of [{ error: "x" }, undefined, [{ id: 1 }], "[]"]) {
    assert.throws(
      () => queryReplyEvents({ response: ok, json }),
      (error) =>
        relayMessageOf(error) === UNREADABLE_QUERY_REPLY &&
        relayFailureOutcome(error) === "answered",
    );
  }
});

test("an error status keeps the server's words, and missing auth reads as sign-in", () => {
  assert.throws(
    () =>
      queryReplyEvents({
        response: { ok: false, status: 401 },
        json: { error: "missing Nostr auth" },
      }),
    (error) => relayFailureOutcome(error) === "auth-required",
  );
  assert.throws(
    () =>
      queryReplyEvents({
        response: { ok: false, status: 502 },
        json: undefined,
      }),
    (error) =>
      relayMessageOf(error) === "server responded 502" &&
      relayFailureOutcome(error) === "answered",
  );
});
