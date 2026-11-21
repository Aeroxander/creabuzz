import assert from "node:assert/strict";
import test from "node:test";

import { buildComposedPost, postParts } from "./post-compose.ts";

const author = "a".repeat(64);
const quoted = { id: "b".repeat(64), pubkey: "c".repeat(64) };
const url = (c) => `https://host.test/media/${c.repeat(64)}.jpg`;
const keep = (u) => u.startsWith("https://host.test/media/");
const launch = { pubkey: author, id: "lamp" };

test("words, pictures, a project and a quote make one post that can be taken apart again", () => {
  const pictures = [
    { url: url("1"), alt: "A lamp" },
    { url: url("2"), alt: "" },
  ];
  const made = buildComposedPost({
    text: "Lit! #lamps",
    pictures,
    launch,
    quote: quoted,
  });
  assert.deepEqual(
    made.tags.filter((t) => t[0] === "t"),
    [["t", "lamps"]],
  );
  assert.ok(made.tags.some((t) => t[0] === "a"));
  assert.deepEqual(
    made.tags.find((t) => t[0] === "q"),
    ["q", quoted.id, "", quoted.pubkey],
  );
  assert.equal(made.tags.filter((t) => t[0] === "imeta").length, 2);
  const parts = postParts({ content: made.content, tags: made.tags }, keep);
  assert.equal(parts.text, "Lit! #lamps");
  assert.deepEqual(parts.pictures, [
    { url: url("1"), alt: "A lamp" },
    { url: url("2"), alt: "" },
  ]);
  assert.deepEqual(parts.quote, quoted);
  assert.deepEqual(parts.launch, launch);
  // Building from the parts again (an edit with the words changed) keeps every other part.
  const again = buildComposedPost({ ...parts, text: "Lit tonight #lamps" });
  assert.equal(again.tags.filter((t) => t[0] === "imeta").length, 2);
  assert.deepEqual(
    again.tags.find((t) => t[0] === "q"),
    made.tags.find((t) => t[0] === "q"),
  );
  assert.ok(again.tags.some((t) => t[0] === "a"));
  assert.match(again.content, /Lit tonight #lamps/);
});

test("a post may be only pictures; a quote and an empty post may not be only nothing", () => {
  const made = buildComposedPost({
    text: "  ",
    pictures: [{ url: url("1"), alt: "" }],
  });
  assert.equal(made.content, url("1"));
  assert.throws(() => buildComposedPost({ text: "" }), /Write something first/);
  assert.throws(
    () => buildComposedPost({ text: " ", quote: quoted }),
    /Write something first/,
  );
});

test("the length counts the pictures' addresses and the references", () => {
  assert.throws(
    () =>
      buildComposedPost({
        text: "x".repeat(1900),
        pictures: [
          { url: url("1"), alt: "" },
          { url: url("2"), alt: "" },
        ],
      }),
    /Keep it under 2000/,
  );
  assert.throws(
    () => buildComposedPost({ text: "x".repeat(2001) }),
    /Keep it under 2000/,
  );
  assert.throws(
    () => buildComposedPost({ text: "x".repeat(1950), quote: quoted }),
    /Keep it under 2000/,
  );
});

test("a quote of a post it names is not shown in the words, a reference to anything else is", () => {
  const made = buildComposedPost({ text: "Agreed", quote: quoted });
  assert.equal(postParts(made, keep).text, "Agreed");
  const other = buildComposedPost({
    text: "See",
    quote: { id: "d".repeat(64), pubkey: "e".repeat(64) },
  });
  const tags = made.tags;
  const mixed = postParts({ content: other.content, tags }, keep);
  assert.match(mixed.text, /nostr:nevent/);
});
