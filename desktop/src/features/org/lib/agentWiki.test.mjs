// Unit tests for Agent Wiki (kind:44002) read-side LWW grouping.
// Run with: node --import ./test-loader.mjs --experimental-strip-types --test src/features/org/lib/agentWiki.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  AGENT_WIKI_FETCH_LIMIT,
  AGENT_WIKI_STANDUP_D,
  eventToAgentWikiPage,
  newestAgentWikiPages,
  parseAgentWikiD,
  stripFrontMatter,
} from "./agentWiki.ts";

const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);

function wikiEvent({
  id,
  d,
  created_at,
  pubkey = ALICE,
  content = "hello",
  tags = [],
}) {
  return {
    id,
    pubkey,
    created_at,
    kind: 44002,
    tags: [["d", d], ...tags],
    content,
    sig: "sig",
  };
}

describe("parseAgentWikiD", () => {
  it("splits space from a nested slug", () => {
    assert.deepEqual(parseAgentWikiD("default/projects/research/index"), {
      space: "default",
      slug: "projects/research/index",
    });
  });

  it("rejects d tags without a <space>/<slug> shape", () => {
    assert.equal(parseAgentWikiD("standup"), null);
    assert.equal(parseAgentWikiD(""), null);
    assert.equal(parseAgentWikiD("default/"), null);
    assert.equal(parseAgentWikiD("/standup"), null);
  });
});

describe("stripFrontMatter", () => {
  it("strips the CLI front-matter block", () => {
    const content = [
      "---",
      "slug: default/standup",
      "agwiki-cursor: 1750000000",
      "model: glm-5.3-flash",
      "---",
      "",
      "# Standup",
      "",
      "Shipped the thing.",
    ].join("\n");
    assert.equal(stripFrontMatter(content), "# Standup\n\nShipped the thing.");
  });

  it("returns content without front matter unchanged", () => {
    assert.equal(stripFrontMatter("# Just markdown"), "# Just markdown");
  });

  it("returns content unchanged when the front matter never closes", () => {
    const content = "---\nslug: default/standup\nno close";
    assert.equal(stripFrontMatter(content), content);
  });
});

describe("eventToAgentWikiPage", () => {
  it("extracts space, slug, body, and provenance tags", () => {
    const page = eventToAgentWikiPage(
      wikiEvent({
        id: "e1",
        d: "default/standup",
        created_at: 100,
        content: "---\nmodel: glm-5.3-flash\n---\n\nBody.",
        tags: [
          ["model", "glm-5.3-flash"],
          ["cost_tokens", "4200"],
          ["sources", `${"c".repeat(64)},${"d".repeat(64)}`],
        ],
      }),
    );
    assert.ok(page);
    assert.equal(page.space, "default");
    assert.equal(page.slug, "standup");
    assert.equal(page.content, "Body.");
    assert.equal(page.model, "glm-5.3-flash");
    assert.equal(page.costTokens, 4200);
    assert.equal(page.sources.length, 2);
  });

  it("tolerates missing or malformed provenance", () => {
    const page = eventToAgentWikiPage(
      wikiEvent({ id: "e1", d: "default/standup", created_at: 100 }),
    );
    assert.ok(page);
    assert.equal(page.model, null);
    assert.equal(page.costTokens, null);
    assert.deepEqual(page.sources, []);
    const malformed = eventToAgentWikiPage(
      wikiEvent({
        id: "e2",
        d: "default/standup",
        created_at: 100,
        tags: [["cost_tokens", "lots"]],
      }),
    );
    assert.ok(malformed);
    assert.equal(malformed.costTokens, null);
  });

  it("skips non-44002 events and malformed d tags", () => {
    const wrongKind = eventToAgentWikiPage({
      id: "x",
      kind: 37010,
      pubkey: ALICE,
      created_at: 1,
      tags: [["d", "default/standup"]],
      content: "",
      sig: "sig",
    });
    assert.equal(wrongKind, null);
    const badD = eventToAgentWikiPage(
      wikiEvent({ id: "x", d: "no-slash", created_at: 1 }),
    );
    assert.equal(badD, null);
  });
});

describe("newestAgentWikiPages", () => {
  it("folds revisions to the newest event per d (read-side LWW)", () => {
    const pages = newestAgentWikiPages([
      wikiEvent({
        id: "v1",
        d: "default/standup",
        created_at: 100,
        content: "old",
      }),
      wikiEvent({
        id: "v3",
        d: "default/standup",
        created_at: 300,
        content: "newest",
      }),
      wikiEvent({
        id: "v2",
        d: "default/standup",
        created_at: 200,
        content: "middle",
      }),
    ]);
    assert.equal(pages.length, 1);
    assert.equal(pages[0].content, "newest");
    assert.equal(pages[0].updatedAt, 300);
  });

  it("keeps one head per (pubkey, d), then one winner per d across authors", () => {
    const pages = newestAgentWikiPages([
      // Alice revised twice; her head is t=300.
      wikiEvent({ id: "a1", d: "default/standup", created_at: 100 }),
      wikiEvent({ id: "a2", d: "default/standup", created_at: 300 }),
      // Bob's older page must lose to Alice's newer head for the same d.
      wikiEvent({
        id: "b1",
        d: "default/standup",
        created_at: 200,
        pubkey: BOB,
      }),
      // A different page stays independent.
      wikiEvent({ id: "c1", d: "default/projects/x/index", created_at: 400 }),
    ]);
    assert.equal(pages.length, 2);
    assert.deepEqual(
      pages.map((page) => page.d),
      ["default/projects/x/index", "default/standup"],
    );
    const standup = pages.find((page) => page.d === "default/standup");
    assert.equal(standup.authorPubkey, ALICE);
    assert.equal(standup.updatedAt, 300);
  });

  it("breaks same-timestamp ties deterministically by event id", () => {
    const pages = newestAgentWikiPages([
      wikiEvent({ id: "zzz", d: "default/standup", created_at: 500 }),
      wikiEvent({ id: "aaa", d: "default/standup", created_at: 500 }),
    ]);
    assert.equal(pages.length, 1);
    assert.equal(pages[0].eventId, "zzz");
  });

  it("ignores non-44002 events entirely", () => {
    const pages = newestAgentWikiPages([
      {
        id: "org",
        kind: 37010,
        pubkey: ALICE,
        created_at: 900,
        tags: [["d", "default/standup"]],
        content: "{}",
        sig: "sig",
      },
    ]);
    assert.deepEqual(pages, []);
  });
});

describe("constants", () => {
  it("bounds the fetch and pins the standup page", () => {
    assert.equal(AGENT_WIKI_FETCH_LIMIT, 100);
    assert.equal(AGENT_WIKI_STANDUP_D, "default/standup");
  });
});
