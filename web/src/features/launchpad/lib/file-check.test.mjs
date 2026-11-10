import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import test from "node:test";

import { checkFile, fileCheckLine, linkHost } from "./file-check.ts";

const digest = (bytes) => webcrypto.subtle.digest("SHA-256", bytes);
const sha = (text) => createHash("sha256").update(text).digest("hex");
/** A response whose body arrives in pieces. */
const streamed = (pieces, headers = {}) => ({
  ok: true,
  headers: { get: (name) => headers[name] ?? null },
  body: {
    getReader() {
      let i = 0;
      return {
        read: async () =>
          i < pieces.length
            ? { done: false, value: new TextEncoder().encode(pieces[i++]) }
            : { done: true },
        cancel: async () => {},
      };
    },
  },
  arrayBuffer: async () => new ArrayBuffer(0),
});

test("a file that is what its fingerprint says matches; any other file does not", async () => {
  const fetch = async () => streamed(["hello ", "world"]);
  assert.deepEqual(
    await checkFile("https://x/f", sha("hello world"), { fetch, digest }),
    { result: "match" },
  );
  assert.deepEqual(
    await checkFile("https://x/f", sha("hello world").toUpperCase(), {
      fetch,
      digest,
    }),
    { result: "match" },
  );
  const other = await checkFile("https://x/f", sha("something else"), {
    fetch,
    digest,
  });
  assert.equal(other.result, "differs");
  assert.equal(other.found, sha("hello world"));
  assert.match(fileCheckLine(other), /does NOT match/);
});

test("the download is bounded by the bytes that arrive, whatever length the server states", async () => {
  // It states 3 bytes and sends far more.
  const lying = async () =>
    streamed(["aaaa", "bbbb", "cccc"], { "content-length": "3" });
  assert.deepEqual(
    await checkFile("https://x/f", sha("aaaabbbbcccc"), {
      fetch: lying,
      digest,
      max: 8,
    }),
    { result: "too-big" },
  );
  const honest = async () => streamed(["a"], { "content-length": "999" });
  assert.deepEqual(
    await checkFile("https://x/f", sha("a"), { fetch: honest, digest, max: 8 }),
    { result: "too-big" },
  );
  // Without a stream the whole body is measured.
  const whole = async () => ({
    ok: true,
    headers: { get: () => null },
    body: null,
    arrayBuffer: async () => new TextEncoder().encode("123456789").buffer,
  });
  assert.deepEqual(
    await checkFile("https://x/f", sha("123456789"), {
      fetch: whole,
      digest,
      max: 8,
    }),
    { result: "too-big" },
  );
  assert.deepEqual(
    await checkFile("https://x/f", sha("123456789"), { fetch: whole, digest }),
    { result: "match" },
  );
});

test("a download that fails is said as that, never as a match or a mismatch", async () => {
  const gone = async () => ({
    ok: false,
    headers: { get: () => null },
    body: null,
    arrayBuffer: async () => new ArrayBuffer(0),
  });
  assert.deepEqual(
    await checkFile("https://x/f", sha("a"), { fetch: gone, digest }),
    { result: "failed" },
  );
  const blocked = async () => {
    throw new TypeError("Failed to fetch");
  };
  assert.deepEqual(
    await checkFile("https://x/f", sha("a"), { fetch: blocked, digest }),
    { result: "failed" },
  );
  assert.match(fileCheckLine({ result: "failed" }), /could not be downloaded/);
});

test("a link's site is shown from the link itself", () => {
  assert.equal(linkHost("https://example.org/a/b?c"), "example.org");
  assert.equal(linkHost("https://good.example@evil.example/x"), "evil.example");
  assert.equal(linkHost("javascript:alert(1)"), null);
  assert.equal(linkHost("nope"), null);
});
