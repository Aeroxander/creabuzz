import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPages,
  pageCoordinate,
  parsePageCoordinate,
} from "./page-index.ts";

const ALICE = "a".repeat(64);
const MALLORY = "b".repeat(64);

function page(slug, pubkey, createdAt, content = "body") {
  return {
    id: `${slug}-${createdAt}`,
    pubkey,
    created_at: createdAt,
    kind: 44001,
    tags: [["d", slug]],
    content,
  };
}

function tombstone(coordinate, pubkey, createdAt) {
  return {
    id: `del-${coordinate}-${createdAt}`,
    pubkey,
    created_at: createdAt,
    kind: 5,
    tags: [["a", coordinate]],
    content: "",
  };
}

test("the newest snapshot wins per slug", () => {
  const pages = buildPages([
    page("home", ALICE, 100, "old"),
    page("home", ALICE, 200, "new"),
    page("guide", ALICE, 150, "guide body"),
  ]);
  assert.deepEqual(
    pages.map((p) => [p.slug, p.content]),
    [
      ["guide", "guide body"],
      ["home", "new"],
    ],
  );
});

test("a page disappears once a tombstone arrives", () => {
  const coordinate = pageCoordinate(ALICE, "home");
  const pages = buildPages([
    page("home", ALICE, 100),
    page("guide", ALICE, 100),
    tombstone(coordinate, ALICE, 150),
  ]);
  assert.deepEqual(
    pages.map((p) => p.slug),
    ["guide"],
  );
});

test("someone else's tombstone cannot delete a page", () => {
  const coordinate = pageCoordinate(ALICE, "home");
  const pages = buildPages([
    page("home", ALICE, 100),
    tombstone(coordinate, MALLORY, 150),
  ]);
  assert.equal(pages.length, 1);
  assert.equal(pages[0].slug, "home");
});

test("a page republished after its delete comes back", () => {
  const coordinate = pageCoordinate(ALICE, "home");
  const pages = buildPages([
    page("home", ALICE, 100),
    tombstone(coordinate, ALICE, 150),
    page("home", ALICE, 200, "rebuilt"),
  ]);
  assert.deepEqual(
    pages.map((p) => [p.slug, p.content]),
    [["home", "rebuilt"]],
  );
});

test("a stale tombstone predating the page does not hide it", () => {
  const coordinate = pageCoordinate(ALICE, "home");
  const pages = buildPages([
    tombstone(coordinate, ALICE, 50),
    page("home", ALICE, 100),
  ]);
  assert.equal(pages.length, 1);
});

test("unrelated kind-5 events are ignored", () => {
  const pages = buildPages([
    page("home", ALICE, 100),
    {
      id: "d",
      pubkey: ALICE,
      created_at: 150,
      kind: 5,
      tags: [["e", "some-event-id"]],
      content: "",
    },
    tombstone(`37001:${ALICE}:launch`, ALICE, 150),
  ]);
  assert.equal(pages.length, 1);
});

test("coordinate parsing rejects anything that is not a wiki page", () => {
  assert.deepEqual(parsePageCoordinate(`44001:${ALICE}:home`), {
    pubkey: ALICE,
    slug: "home",
  });
  assert.equal(parsePageCoordinate("44001:only-two"), null);
  assert.equal(parsePageCoordinate(`44001::home`), null);
  assert.equal(parsePageCoordinate(`44001:${ALICE}:`), null);
  assert.equal(parsePageCoordinate(`5:${ALICE}:home`), null);
  assert.equal(parsePageCoordinate(""), null);
  assert.deepEqual(parsePageCoordinate(`44001:${ALICE}:a:b`), {
    pubkey: ALICE,
    slug: "a:b",
  });
});
