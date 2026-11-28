import assert from "node:assert/strict";
import test from "node:test";

import { buildComposedPost } from "./post-compose.ts";

const author = "a".repeat(64);
const launch = { pubkey: author, id: "lamp" };

test("words and a project make one post that carries its topics and the project", () => {
  const made = buildComposedPost({ text: "Lit! #lamps", launch });
  assert.equal(made.kind, 1);
  assert.deepEqual(
    made.tags.filter((t) => t[0] === "t"),
    [["t", "lamps"]],
  );
  assert.ok(made.tags.some((t) => t[0] === "a"));
  assert.match(made.content, /^Lit! #lamps\n\nnostr:naddr1/);
});

test("an empty post, or one over the limit, is turned away in words", () => {
  assert.throws(
    () => buildComposedPost({ text: " " }),
    /Write something first/,
  );
  assert.throws(
    () => buildComposedPost({ text: "a".repeat(2001) }),
    /Keep it under 2000 characters/,
  );
});

test("the project's reference counts toward the limit", () => {
  assert.throws(
    () => buildComposedPost({ text: "a".repeat(1990), launch }),
    /Keep it under 2000 characters/,
  );
});
