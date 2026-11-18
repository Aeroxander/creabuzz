import assert from "node:assert/strict";
import test from "node:test";

import {
  createMediaTokenSource,
  createServerMediaCache,
} from "./server-media.ts";
import { timedFetchStreamed } from "./timed-fetch.ts";

/**
 * The picture cache wired the way `server-media-loader.ts` wires it (its `fetch` is `timedFetchStreamed` with a
 * deadline), with only the network faked. A picture whose bytes stall part way ends as a failed picture by the
 * deadline instead of loading forever. With the old headers-only `timedFetch`, this case never settles.
 */

const URL_A = `https://creaton.test/media/${"ab".repeat(32)}.png`;

test("a picture whose bytes stall ends as failed by the deadline", async () => {
  const cache = createServerMediaCache({
    tokens: createMediaTokenSource({
      sign: async (template) => ({
        ...template,
        id: "id",
        pubkey: "pk",
        sig: "sig",
      }),
      signerState: () => ({ key: "alice" }),
    }),
    fetch: (url, init) =>
      timedFetchStreamed(url, {
        ...init,
        timeoutMs: 40,
        fetchImpl: async (_url, request) => {
          assert.ok(
            request.signal,
            "the request carries the deadline's signal",
          );
          const body = new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([1, 2, 3]));
            },
            pull: () => new Promise(() => {}),
          });
          return new Response(body, {
            status: 200,
            headers: { "content-type": "image/png" },
          });
        },
      }),
    createObjectURL: () => "blob:x",
    revokeObjectURL: () => {},
  });
  const seen = [];
  cache.watch(URL_A, (result) => seen.push(result));
  const settled = await new Promise((resolve) => {
    const started = Date.now();
    const poll = setInterval(() => {
      if (seen.length > 0 || Date.now() - started > 1000) {
        clearInterval(poll);
        resolve(seen.length > 0);
      }
    }, 10);
  });
  assert.ok(settled, "the picture settled instead of loading forever");
  assert.equal(seen[0].status, "failed");
});
