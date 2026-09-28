// Unit tests for the wiki page index: kind:44001 snapshot + tombstone
// semantics, kind:44002 read-side LWW, and the page-link extractor.
// Run with: node --import ./test-loader.mjs --experimental-strip-types --test src/features/wiki/lib/pageIndex.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildWikiPages,
  extractLinks,
  humanPageCoordinate,
  parseHumanPageCoordinate,
} from "./pageIndex.ts";

const ALICE = "a".repeat(64);
const MALLORY = "b".repeat(64);

function humanEvent({ id, slug, createdAt, pubkey = ALICE, content = "body" }) {
  return {
    id,
    pubkey,
    created_at: createdAt,
    kind: 44001,
    tags: [["d", slug]],
    content,
  };
}

function agentEvent({
  id,
  d,
  createdAt,
  pubkey = ALICE,
  content = "body",
  tags = [],
}) {
  return {
    id,
    pubkey,
    created_at: createdAt,
    kind: 44002,
    tags: [["d", d], ...tags],
    content,
  };
}

function tombstone(coordinate, pubkey, createdAt) {
  return {
    id: `del-${createdAt}`,
    pubkey,
    created_at: createdAt,
    kind: 5,
    tags: [["a", coordinate]],
    content: "",
  };
}

describe("human pages (kind:44001)", () => {
  it("the newest snapshot wins per slug", () => {
    const pages = buildWikiPages([
      humanEvent({ id: "h1", slug: "home", createdAt: 100, content: "old" }),
      humanEvent({ id: "h2", slug: "home", createdAt: 200, content: "new" }),
      humanEvent({ id: "h3", slug: "guide", createdAt: 150 }),
    ]);
    assert.deepEqual(
      pages.map((page) => [page.kind, page.slug, page.content]),
      [
        ["human", "guide", "body"],
        ["human", "home", "new"],
      ],
    );
  });

  it("a page disappears once a tombstone arrives", () => {
    const pages = buildWikiPages([
      humanEvent({ id: "h1", slug: "home", createdAt: 100 }),
      humanEvent({ id: "h2", slug: "guide", createdAt: 100 }),
      tombstone(humanPageCoordinate(ALICE, "home"), ALICE, 150),
    ]);
    assert.deepEqual(
      pages.map((page) => page.slug),
      ["guide"],
    );
  });

  it("someone else's tombstone cannot delete a page", () => {
    const pages = buildWikiPages([
      humanEvent({ id: "h1", slug: "home", createdAt: 100 }),
      tombstone(humanPageCoordinate(ALICE, "home"), MALLORY, 150),
    ]);
    assert.equal(pages.length, 1);
    assert.equal(pages[0].slug, "home");
  });

  it("a page republished after its delete comes back", () => {
    const pages = buildWikiPages([
      humanEvent({ id: "h1", slug: "home", createdAt: 100 }),
      tombstone(humanPageCoordinate(ALICE, "home"), ALICE, 150),
      humanEvent({
        id: "h2",
        slug: "home",
        createdAt: 200,
        content: "rebuilt",
      }),
    ]);
    assert.deepEqual(
      pages.map((page) => [page.slug, page.content]),
      [["home", "rebuilt"]],
    );
  });

  it("a stale tombstone predating the page does not hide it", () => {
    const pages = buildWikiPages([
      tombstone(humanPageCoordinate(ALICE, "home"), ALICE, 50),
      humanEvent({ id: "h1", slug: "home", createdAt: 100 }),
    ]);
    assert.equal(pages.length, 1);
  });

  it("unrelated kind-5 events are ignored", () => {
    const pages = buildWikiPages([
      humanEvent({ id: "h1", slug: "home", createdAt: 100 }),
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
});

describe("agent pages (kind:44002)", () => {
  it("the newest revision per (pubkey, d) wins read-side LWW", () => {
    const pages = buildWikiPages([
      agentEvent({
        id: "a1",
        d: "default/standup",
        createdAt: 100,
        content: "old standup",
      }),
      agentEvent({
        id: "a2",
        d: "default/standup",
        createdAt: 200,
        content: "new standup",
      }),
    ]);
    assert.equal(pages.length, 1);
    assert.equal(pages[0].content, "new standup");
  });

  it("the newest head across authors wins the page", () => {
    const pages = buildWikiPages([
      agentEvent({
        id: "a1",
        d: "default/standup",
        createdAt: 100,
        pubkey: ALICE,
      }),
      agentEvent({
        id: "a2",
        d: "default/standup",
        createdAt: 200,
        pubkey: MALLORY,
      }),
    ]);
    assert.equal(pages.length, 1);
    assert.equal(pages[0].authorPubkey, MALLORY);
    assert.equal(pages[0].updatedAt, 200);
  });

  it("a timestamp tie falls to the greater event id", () => {
    const pages = buildWikiPages([
      agentEvent({ id: "aaa", d: "default/standup", createdAt: 100 }),
      agentEvent({ id: "zzz", d: "default/standup", createdAt: 100 }),
    ]);
    assert.equal(pages.length, 1);
    assert.equal(pages[0].eventId, "zzz");
  });

  it("pages in different spaces and slugs stay separate", () => {
    const pages = buildWikiPages([
      agentEvent({ id: "a1", d: "default/standup", createdAt: 100 }),
      agentEvent({ id: "a2", d: "research/standup", createdAt: 100 }),
      agentEvent({
        id: "a3",
        d: "default/projects/research/index",
        createdAt: 100,
      }),
    ]);
    assert.deepEqual(
      pages.map((page) => [page.space, page.slug]),
      [
        ["default", "projects/research/index"],
        ["default", "standup"],
        ["research", "standup"],
      ],
    );
  });

  it("skips a d tag without a <space>/<slug> shape", () => {
    const pages = buildWikiPages([
      agentEvent({ id: "a1", d: "standup", createdAt: 100 }),
      agentEvent({ id: "a2", d: "default/", createdAt: 100 }),
      agentEvent({ id: "a3", d: "Bad/standup", createdAt: 100 }),
    ]);
    assert.equal(pages.length, 0);
  });

  it("strips the standup front-matter and extracts provenance", () => {
    const content = [
      "---",
      "slug: default/standup",
      "agwiki-cursor: 1750000000",
      "model: glm-5.3-flash",
      "generated-at: 1750000000",
      "---",
      "",
      "Current truth.",
    ].join("\n");
    const pages = buildWikiPages([
      agentEvent({
        id: "a1",
        d: "default/standup",
        createdAt: 100,
        content,
        tags: [
          ["model", "glm-5.3-flash"],
          ["cost_tokens", "4321"],
          ["sources", `${ALICE},${MALLORY}`],
        ],
      }),
    ]);
    assert.equal(pages.length, 1);
    const page = pages[0];
    assert.equal(page.content, "Current truth.");
    assert.equal(page.frontMatter.cursor, 1750000000);
    assert.deepEqual(page.provenance, {
      model: "glm-5.3-flash",
      costTokens: 4321,
      sources: [ALICE, MALLORY],
    });
  });
});

describe("buildWikiPages ordering", () => {
  it("lists human pages by slug, then agent pages by d", () => {
    const pages = buildWikiPages([
      humanEvent({ id: "h1", slug: "zzz", createdAt: 100 }),
      humanEvent({ id: "h2", slug: "aaa", createdAt: 100 }),
      agentEvent({ id: "a1", d: "default/standup", createdAt: 100 }),
    ]);
    assert.deepEqual(
      pages.map((page) => page.key),
      ["aaa", "zzz", "default/standup"],
    );
    assert.deepEqual(
      pages.map((page) => page.kind),
      ["human", "human", "agent"],
    );
  });
});

describe("page coordinates", () => {
  it("round-trips a human page coordinate", () => {
    assert.deepEqual(parseHumanPageCoordinate(`44001:${ALICE}:home`), {
      pubkey: ALICE,
      slug: "home",
    });
    assert.equal(humanPageCoordinate(ALICE, "home"), `44001:${ALICE}:home`);
  });

  it("coordinate parsing rejects anything that is not a wiki page", () => {
    assert.equal(parseHumanPageCoordinate("44001:only-two"), null);
    assert.equal(parseHumanPageCoordinate(`44001::home`), null);
    assert.equal(parseHumanPageCoordinate(`44001:${ALICE}:`), null);
    assert.equal(parseHumanPageCoordinate(`5:${ALICE}:home`), null);
    assert.equal(parseHumanPageCoordinate(""), null);
    assert.deepEqual(parseHumanPageCoordinate(`44001:${ALICE}:a:b`), {
      pubkey: ALICE,
      slug: "a:b",
    });
  });
});

describe("extractLinks", () => {
  it("normalises wikilinks to page slugs and collects tags", () => {
    assert.deepEqual(
      extractLinks("See [[Release Notes!]] and [[Home|the alias]] #Design"),
      ["release-notes", "home", "tag:design"],
    );
  });

  it("deduplicates repeated links", () => {
    assert.deepEqual(extractLinks("[[Home]] [[home]] #roadmap #roadmap"), [
      "home",
      "tag:roadmap",
    ]);
  });
});
