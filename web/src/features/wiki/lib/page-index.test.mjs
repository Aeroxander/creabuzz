import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDeleteMarker,
  buildPages,
  buildTombstonedPages,
  canDeletePage,
  pageCoordinate,
  parsePageCoordinate,
} from "./page-index.ts";
import { restorePayload } from "./wiki-history.ts";

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

test("a delete marker from any page author removes the whole page", () => {
  // Not just the newest author's: ALICE's marker must remove the page even
  // though MALLORY's revision is now the newest one.
  const pages = buildPages([
    page("home", ALICE, 100),
    page("home", MALLORY, 200, "newest"),
    tombstone(pageCoordinate(ALICE, "home"), ALICE, 300),
  ]);
  assert.deepEqual(pages, []);
});

test("a restorable delete is restored by any newer accepted revision", () => {
  // The relay's restore path is an authorized editor's accepted revision (it
  // checks the editor's authority); the fold mirrors that contract.
  const pages = buildPages([
    page("home", ALICE, 100),
    tombstone(pageCoordinate(ALICE, "home"), ALICE, 150),
    page("home", MALLORY, 200, "restored"),
  ]);
  assert.deepEqual(
    pages.map((p) => p.content),
    ["restored"],
  );
});

test("a purge marker is permanent — no revision ever brings the page back", () => {
  const purge = {
    id: "purge-1",
    pubkey: ALICE,
    created_at: 150,
    kind: 5,
    tags: [
      ["a", pageCoordinate(ALICE, "home")],
      ["purge", "1"],
    ],
    content: "",
  };
  const pages = buildPages([
    page("home", ALICE, 100),
    purge,
    page("home", ALICE, 200, "after purge"),
    page("home", MALLORY, 300, "also after purge"),
  ]);
  assert.deepEqual(pages, []);
  // …and a purged page is gone, not merely deleted: never in Recently deleted.
  assert.deepEqual(
    buildTombstonedPages([
      page("home", ALICE, 100),
      purge,
      page("home", ALICE, 200, "after purge"),
    ]),
    [],
  );
});

test("a marker for one's own coordinate of an unauthored page is ignored", () => {
  // Deletion authority is the page's authors: MALLORY never published "home",
  // so a marker naming MALLORY's coordinate deletes nothing.
  const pages = buildPages([
    page("home", ALICE, 100),
    tombstone(pageCoordinate(MALLORY, "home"), MALLORY, 150),
  ]);
  assert.equal(pages.length, 1);
  assert.equal(pages[0].slug, "home");
});

test("only a newer revision restores a deleted page", () => {
  const deleted = [tombstone(pageCoordinate(ALICE, "home"), ALICE, 150)];
  assert.deepEqual(
    buildPages([...deleted, page("home", ALICE, 200, "rebuilt")]).map(
      (p) => p.content,
    ),
    ["rebuilt"],
  );
  // A revision predating the tombstone does not undo the delete.
  assert.deepEqual(
    buildPages([...deleted, page("home", ALICE, 100, "old")]),
    [],
  );
});

test("the winning snapshot carries its event id", () => {
  const pages = buildPages([page("home", ALICE, 100)]);
  assert.equal(pages[0].id, "home-100");
});

test("delete is offered to drafts and the newest revision's author only", () => {
  assert.equal(canDeletePage({ draft: true }, ALICE), true);
  assert.equal(canDeletePage({ authorPubkey: ALICE }, ALICE), true);
  assert.equal(canDeletePage({ authorPubkey: ALICE }, MALLORY), false);
  assert.equal(canDeletePage({ authorPubkey: ALICE }, null), false);
  assert.equal(canDeletePage(null, ALICE), false);
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

// ── delete markers: purge vs restorable ───────────────────────────────────

test("a restorable delete marker carries no purge tag", () => {
  const marker = buildDeleteMarker({
    coordinate: pageCoordinate(ALICE, "home"),
    purge: false,
    viewerIsAdmin: true,
    now: 150,
  });
  assert.equal(marker.kind, 5);
  assert.deepEqual(marker.tags, [["a", pageCoordinate(ALICE, "home")]]);
});

test("an admin's purge marker carries the purge tag", () => {
  const marker = buildDeleteMarker({
    coordinate: pageCoordinate(ALICE, "home"),
    purge: true,
    viewerIsAdmin: true,
    now: 150,
  });
  assert.deepEqual(marker.tags, [
    ["a", pageCoordinate(ALICE, "home")],
    ["purge", "1"],
  ]);
});

test("a non-admin can never purge — the builder refuses", () => {
  // An author asking for a purge must not silently get a restorable delete.
  assert.throws(
    () =>
      buildDeleteMarker({
        coordinate: pageCoordinate(ALICE, "home"),
        purge: true,
        viewerIsAdmin: false,
        now: 150,
      }),
    /admin/,
  );
});

// ── Recently deleted: listing + restore flow ──────────────────────────────

test("buildTombstonedPages lists restorable deletes, newest first, with the restore payload", () => {
  const events = [
    page("home", ALICE, 100, "home body"),
    tombstone(pageCoordinate(ALICE, "home"), ALICE, 150),
    {
      ...page("guide", ALICE, 100, "guide body"),
      tags: [
        ["d", "guide"],
        ["t", "team:design"],
      ],
    },
    tombstone(pageCoordinate(ALICE, "guide"), ALICE, 120),
  ];
  const deleted = buildTombstonedPages(events);
  assert.deepEqual(
    deleted.map((entry) => [entry.slug, entry.deletedAt]),
    [
      ["home", 150],
      ["guide", 120],
    ],
  );
  // The entry carries what a restore republishes: content + sticky scope.
  const guide = deleted.find((entry) => entry.slug === "guide");
  assert.equal(guide.content, "guide body");
  assert.equal(guide.scope, "design");
  assert.equal(guide.deletedBy, ALICE);

  // Restore flow: the entry becomes a NEW revision (fresh timestamp) under
  // the same slug, scope carried over — the existing restore-payload builder.
  const restored = restorePayload(
    {
      id: "ignored",
      authorPubkey: guide.authorPubkey,
      createdAt: 100,
      excerpt: "guide body",
      content: guide.content,
      scope: guide.scope,
    },
    { now: 900, slug: guide.slug },
  );
  assert.deepEqual(restored, {
    kind: 44001,
    tags: [
      ["d", "guide"],
      ["t", "team:design"],
    ],
    content: "guide body",
    created_at: 900,
  });
  // …and that revision restores the page in the live set.
  const live = buildPages([
    ...events,
    {
      ...page("guide", ALICE, 900, "guide body"),
      tags: [
        ["d", "guide"],
        ["t", "team:design"],
      ],
    },
  ]);
  assert.deepEqual(
    live.map((p) => p.slug),
    ["guide"],
  );
});
