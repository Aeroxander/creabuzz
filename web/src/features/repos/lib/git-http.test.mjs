import assert from "node:assert/strict";
import test from "node:test";

import { ServerTimeoutError } from "../../../shared/lib/timed-fetch.ts";
import { gitHttpClient, withGitDeadline } from "./git-http.ts";

/**
 * The client `git-client.ts` hands isomorphic-git for every clone and fetch. Only the network is faked: a server that
 * never answers, or stalls mid-pack, ends the operation by its deadline and aborts the request, instead of the
 * repository page loading forever (isomorphic-git's own client sends no signal at all).
 */

async function readAll(body) {
  const parts = [];
  for await (const part of body) parts.push(...part);
  return parts;
}

test("a server that never answers ends the clone by the deadline and aborts its request", async () => {
  let seen = null;
  const started = Date.now();
  await assert.rejects(
    withGitDeadline(
      (http) => http.request({ url: "https://server.test/git/a/b.git" }),
      {
        stallMs: 40,
        timeoutMs: 2000,
        fetchImpl: (_url, init) => {
          seen = init.signal;
          return new Promise(() => {});
        },
      },
    ),
    (error) => error instanceof ServerTimeoutError,
  );
  assert.ok(Date.now() - started < 1000);
  assert.ok(seen?.aborted, "the request carries the deadline's signal");
});

test("a pack that stalls part way ends by the deadline instead of loading forever", async () => {
  const outcome = withGitDeadline(
    async (http) => {
      const reply = await http.request({
        url: "https://server.test/git/a/b.git/git-upload-pack",
        method: "POST",
      });
      return readAll(reply.body);
    },
    {
      stallMs: 40,
      timeoutMs: 2000,
      fetchImpl: async (_url, init) => {
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2]));
            init.signal.addEventListener("abort", () =>
              controller.error(init.signal.reason),
            );
          },
          pull: () => new Promise(() => {}),
        });
        return new Response(body, { status: 200 });
      },
    },
  );
  const settled = await Promise.race([
    outcome.then(
      () => "resolved",
      (error) => error,
    ),
    new Promise((resolve) => setTimeout(() => resolve("still loading"), 1000)),
  ]);
  assert.ok(settled instanceof ServerTimeoutError, String(settled));
});

/** A pack that delivers one chunk every `everyMs`, `count` chunks in all, then ends. */
function steadyPack(count, everyMs) {
  return async (_url, init) => {
    let sent = 0;
    const body = new ReadableStream({
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, everyMs));
        if (init.signal.aborted) return controller.error(init.signal.reason);
        controller.enqueue(new Uint8Array([sent]));
        sent += 1;
        if (sent === count) controller.close();
      },
    });
    return new Response(body, { status: 200 });
  };
}

test("a pack that keeps arriving slowly is not cut off, however long it takes past the stall window", async () => {
  // 8 chunks 30 ms apart: about 240 ms in all, six times the 40 ms stall window, but never 40 ms without data.
  const bytes = await withGitDeadline(
    async (http) => {
      const reply = await http.request({
        url: "https://server.test/git/a/b.git/git-upload-pack",
        method: "POST",
      });
      return readAll(reply.body);
    },
    { stallMs: 40, fetchImpl: steadyPack(8, 30) },
  );
  assert.deepEqual(bytes, [0, 1, 2, 3, 4, 5, 6, 7]);
});

test("time spent working on what already arrived does not count as the server stalling", async () => {
  const outcome = await withGitDeadline(
    async (http) => {
      const reply = await http.request({ url: "https://server.test/git/a" });
      const bytes = await readAll(reply.body);
      // Indexing the pack locally, with no request open: longer than the stall window.
      await new Promise((resolve) => setTimeout(resolve, 120));
      return bytes;
    },
    {
      stallMs: 40,
      fetchImpl: async () => new Response(new Uint8Array([5]), { status: 200 }),
    },
  );
  assert.deepEqual(outcome, [5]);
});

test("the whole-operation cap still ends a pack that never stops arriving", async () => {
  await assert.rejects(
    withGitDeadline(
      async (http) => {
        const reply = await http.request({ url: "https://server.test/git/a" });
        return readAll(reply.body);
      },
      { stallMs: 1000, timeoutMs: 120, fetchImpl: steadyPack(1000, 10) },
    ),
    (error) => error instanceof ServerTimeoutError && error.timeoutMs === 120,
  );
});

test("a normal exchange sends the body whole and passes the reply through", async () => {
  const controller = new AbortController();
  let sent = null;
  const http = gitHttpClient(controller.signal, async (url, init) => {
    sent = { url, init };
    return new Response(new Uint8Array([7, 8, 9]), {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/x-git-upload-pack-result" },
    });
  });
  async function* request() {
    yield new Uint8Array([1]);
    yield new Uint8Array([2, 3]);
  }
  const reply = await http.request({
    url: "https://server.test/git/a/b.git/git-upload-pack",
    method: "POST",
    headers: { Authorization: "Nostr x" },
    body: request(),
  });
  assert.equal(sent.init.method, "POST");
  assert.equal(sent.init.signal, controller.signal);
  assert.deepEqual([...sent.init.body], [1, 2, 3]);
  assert.equal(sent.init.headers.Authorization, "Nostr x");
  assert.equal(reply.statusCode, 200);
  assert.equal(reply.statusMessage, "OK");
  assert.equal(
    reply.headers["content-type"],
    "application/x-git-upload-pack-result",
  );
  assert.deepEqual(await readAll(reply.body), [7, 8, 9]);
});
