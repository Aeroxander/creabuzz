import assert from "node:assert/strict";
import test from "node:test";

import {
  isSignedRecordList,
  isServerTimeout,
  retryAfterMs,
  retryAfterOf,
  retryPause,
  SERVER_DID_NOT_ANSWER,
  ServerTimeoutError,
  timedFetch,
  timedFetchBody,
  timedFetchStreamed,
  withDeadline,
} from "./timed-fetch.ts";
import { relayFailureOutcome } from "./relay-failure.ts";

/** A fetch that is accepted and then never answers, like a black-holed connection. Records the signal it got. */
function blackHole() {
  const seen = { signal: null, calls: 0 };
  const fetchImpl = (_url, init) => {
    seen.calls += 1;
    seen.signal = init.signal;
    return new Promise(() => {});
  };
  return { seen, fetchImpl };
}

test("a server that never answers ends by the deadline as 'did not answer'", async () => {
  const { seen, fetchImpl } = blackHole();
  const started = Date.now();
  await assert.rejects(
    timedFetch("http://server.test/query", { fetchImpl, timeoutMs: 20 }),
    (error) => {
      assert.ok(isServerTimeout(error));
      assert.equal(error.message, SERVER_DID_NOT_ANSWER);
      // The failure table reads it as nobody answering, not as a refusal or sign-in.
      assert.equal(relayFailureOutcome(error), "unanswered");
      return true;
    },
  );
  assert.ok(Date.now() - started < 1000);
  // The request itself is cancelled too, not left running.
  assert.equal(seen.signal.aborted, true);
});

test("a body that never finishes also ends by the deadline", async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    text: () => new Promise(() => {}),
  });
  await assert.rejects(
    timedFetchBody("http://server.test/query", { fetchImpl, timeoutMs: 20 }),
    ServerTimeoutError,
  );
});

test("the caller giving up stops the request with the caller's reason, never 'did not answer'", async () => {
  const { seen, fetchImpl } = blackHole();
  const caller = new AbortController();
  const pending = timedFetch("http://server.test/query", {
    fetchImpl,
    signal: caller.signal,
    timeoutMs: 10_000,
  });
  const reason = new DOMException("newer search", "AbortError");
  caller.abort(reason);
  await assert.rejects(pending, (error) => {
    assert.equal(error, reason);
    assert.equal(isServerTimeout(error), false);
    return true;
  });
  assert.equal(seen.signal.aborted, true);
});

test("an already-cancelled caller never sends the request", async () => {
  const { seen, fetchImpl } = blackHole();
  const caller = new AbortController();
  caller.abort();
  await assert.rejects(
    timedFetch("http://server.test/x", { fetchImpl, signal: caller.signal }),
    (error) => error.name === "AbortError",
  );
  assert.equal(seen.calls, 0);
});

test("an answer in time passes through with the request's own options", async () => {
  let got;
  const fetchImpl = async (url, init) => {
    got = { url, init };
    return { ok: true, status: 200, text: async () => '[{"a":1}]' };
  };
  const reply = await timedFetchBody("http://server.test/q", {
    fetchImpl,
    method: "POST",
    body: "[]",
    timeoutMs: 1000,
  });
  assert.deepEqual(reply.json, [{ a: 1 }]);
  assert.equal(got.url, "http://server.test/q");
  assert.equal(got.init.method, "POST");
  assert.equal(got.init.body, "[]");
  // The deadline options are not leaked into the fetch call.
  assert.equal("timeoutMs" in got.init, false);
  assert.equal("fetchImpl" in got.init, false);
  assert.ok(got.init.signal instanceof AbortSignal);
});

test("a body that is not JSON is kept as text, not thrown", async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    text: async () => "<html>proxy</html>",
  });
  const reply = await timedFetchBody("http://server.test/q", { fetchImpl });
  assert.equal(reply.json, undefined);
  assert.equal(reply.text, "<html>proxy</html>");
});

test("the timer and the caller listener are removed once settled", async () => {
  const caller = new AbortController();
  let removed = 0;
  const original = caller.signal.removeEventListener.bind(caller.signal);
  caller.signal.removeEventListener = (...args) => {
    removed += 1;
    return original(...args);
  };
  assert.equal(
    await withDeadline(async () => 7, { signal: caller.signal, timeoutMs: 50 }),
    7,
  );
  assert.equal(removed, 1);
});

test("Retry-After in seconds and as a date", () => {
  assert.equal(retryAfterMs("5"), 5000);
  assert.equal(retryAfterMs(" 0 "), 0);
  const now = Date.parse("Sun, 01 Nov 2026 12:00:00 GMT");
  assert.equal(retryAfterMs("Sun, 01 Nov 2026 12:00:03 GMT", now), 3000);
  // A date already past means "now", never a negative wait.
  assert.equal(retryAfterMs("Sun, 01 Nov 2026 11:00:00 GMT", now), 0);
  assert.equal(retryAfterMs(null), null);
  assert.equal(retryAfterMs(""), null);
  assert.equal(retryAfterMs("-3"), null);
  assert.equal(retryAfterMs("soon"), null);
  assert.equal(retryAfterMs("1.5"), null);
});

test("Retry-After is read only on 429 and 503, and from replies without headers", () => {
  const headers = new Headers({ "Retry-After": "2" });
  assert.equal(retryAfterOf({ status: 429, headers }), 2000);
  assert.equal(retryAfterOf({ status: 503, headers }), 2000);
  assert.equal(retryAfterOf({ status: 500, headers }), null);
  assert.equal(retryAfterOf({ status: 429 }), null);
});

test("a retry never comes sooner than the server asked, and a long ask ends the loop", () => {
  assert.equal(retryPause(300, null), 300);
  assert.equal(retryPause(300, 100), 300);
  assert.equal(retryPause(300, 2000), 2000);
  assert.equal(retryPause(300, 10_000), 10_000);
  assert.equal(retryPause(300, 10_001), null);
  assert.equal(retryPause(300, 5000, 1000), null);
});

const RECORD = {
  id: "a".repeat(64),
  pubkey: "b".repeat(64),
  created_at: 1_700_000_000,
  kind: 1,
  tags: [["h", "room"]],
  content: "hi",
  sig: "c".repeat(128),
};

test("a /query body must be a list of signed records", () => {
  assert.equal(isSignedRecordList([]), true);
  assert.equal(isSignedRecordList([RECORD]), true);
  assert.equal(isSignedRecordList({ error: "nope" }), false);
  assert.equal(isSignedRecordList(undefined), false);
  assert.equal(isSignedRecordList("[]"), false);
  assert.equal(isSignedRecordList([RECORD, { ...RECORD, kind: "1" }]), false);
  assert.equal(isSignedRecordList([{ ...RECORD, tags: [[1]] }]), false);
  assert.equal(isSignedRecordList([{ ...RECORD, sig: undefined }]), false);
  assert.equal(isSignedRecordList([null]), false);
});

/** A reply whose headers arrive at once and whose body sends `first` and then stalls (it ignores its signal). */
function stallingBody(first = "part") {
  const seen = { signal: null };
  const fetchImpl = async (_url, init) => {
    seen.signal = init.signal;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(first));
      },
      pull: () => new Promise(() => {}),
    });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "image/png" },
    });
  };
  return { seen, fetchImpl };
}

test("a streamed reply whose body stalls fails its read by the deadline", async () => {
  const { seen, fetchImpl } = stallingBody();
  const response = await timedFetchStreamed("http://server.test/media/a", {
    fetchImpl,
    timeoutMs: 30,
  });
  // The headers come through untouched; the body is still unread.
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  const started = Date.now();
  await assert.rejects(response.blob(), (error) => {
    assert.ok(isServerTimeout(error));
    assert.equal(relayFailureOutcome(error), "unanswered");
    return true;
  });
  assert.ok(Date.now() - started < 1000);
  assert.equal(seen.signal.aborted, true);
});

test("headers-only timedFetch leaves a stalled body unbounded (why pictures use the streamed one)", async () => {
  const { fetchImpl } = stallingBody();
  const response = await timedFetch("http://server.test/media/a", {
    fetchImpl,
    timeoutMs: 20,
  });
  const outcome = await Promise.race([
    response.blob().then(() => "read"),
    new Promise((resolve) => setTimeout(() => resolve("still waiting"), 80)),
  ]);
  assert.equal(outcome, "still waiting");
});

test("a caller giving up mid-body stops the streamed read with the caller's reason", async () => {
  const { seen, fetchImpl } = stallingBody();
  const caller = new AbortController();
  const response = await timedFetchStreamed("http://server.test/media/a", {
    fetchImpl,
    signal: caller.signal,
    timeoutMs: 5_000,
  });
  const reading = response.blob();
  const reason = new Error("page closed");
  caller.abort(reason);
  await assert.rejects(reading, (error) => {
    assert.equal(error, reason);
    assert.ok(!isServerTimeout(error));
    return true;
  });
  assert.equal(seen.signal.aborted, true);
});

test("a streamed reply read in time keeps its bytes and is not cut off later", async () => {
  let signal = null;
  const fetchImpl = async (_url, init) => {
    signal = init.signal;
    return new Response("whole picture", { status: 200 });
  };
  const response = await timedFetchStreamed("http://server.test/media/a", {
    fetchImpl,
    timeoutMs: 30,
  });
  assert.equal(await response.text(), "whole picture");
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(signal.aborted, false, "timer cleared once the body was read");
});

test("a streamed request with no headers in time, or a cancelled caller, never resolves", async () => {
  const { fetchImpl } = blackHole();
  await assert.rejects(
    timedFetchStreamed("http://server.test/media/a", {
      fetchImpl,
      timeoutMs: 20,
    }),
    ServerTimeoutError,
  );
  const caller = new AbortController();
  caller.abort(new Error("gone"));
  let calls = 0;
  await assert.rejects(
    timedFetchStreamed("http://server.test/media/a", {
      fetchImpl: () => {
        calls += 1;
        return new Promise(() => {});
      },
      signal: caller.signal,
    }),
    /gone/,
  );
  assert.equal(calls, 0);
});

test("a streamed reply without a body passes through", async () => {
  const fetchImpl = async () => new Response(null, { status: 204 });
  const response = await timedFetchStreamed("http://server.test/x", {
    fetchImpl,
    timeoutMs: 20,
  });
  assert.equal(response.status, 204);
});
