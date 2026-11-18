import assert from "node:assert/strict";
import { test } from "node:test";

import { buildWikiPages } from "./pageIndex.ts";
import {
  CORRECTION_SLUG_PREFIX,
  groupWikiPages,
  WIKI_GROUP_LABELS,
  wikiPageGroup,
} from "./wikiGroups.ts";

const human = (key) => ({ kind: "human", key });
const agent = (key) => ({ kind: "agent", key });

/** One raw wiki event (kind:44001 human page or kind:44003 correction). */
function wikiEvent(kind, d, id) {
  return {
    id,
    pubkey: "aa",
    created_at: 100,
    kind,
    tags: [["d", d]],
    content: "",
  };
}

test("correction-for-* pages classify as Corrections, never team pages", () => {
  assert.equal(
    wikiPageGroup(human("correction-for-team-charter")),
    "corrections",
  );
  assert.equal(wikiPageGroup(human("team-charter")), "team");
  assert.equal(wikiPageGroup(agent("eng/standup")), "agent");
});

test("the classification is the pinned correction d-tag prefix", () => {
  assert.equal(CORRECTION_SLUG_PREFIX, "correction-for-");
});

test("kind:44003 corrections and legacy kind:44001 corrections both group as Corrections", () => {
  const pages = buildWikiPages([
    wikiEvent(44001, "team-charter", "evt-team"),
    wikiEvent(44001, "correction-for-team-charter", "evt-legacy-correction"),
    wikiEvent(44003, "correction-for-roles", "evt-new-correction"),
    {
      id: "evt-agent",
      pubkey: "aa",
      created_at: 100,
      kind: 44002,
      tags: [["d", "eng/standup"]],
      content: "",
    },
  ]);
  const groups = groupWikiPages(pages);
  assert.deepEqual(
    groups.corrections.map((page) => page.key),
    // buildWikiPages sorts human pages by slug.
    ["correction-for-roles", "correction-for-team-charter"],
  );
  assert.deepEqual(
    groups.team.map((page) => page.key),
    ["team-charter"],
  );
  assert.deepEqual(
    groups.agent.map((page) => page.key),
    ["eng/standup"],
  );
});

test("group headings use the product terms", () => {
  assert.deepEqual(WIKI_GROUP_LABELS, {
    team: "Wiki pages",
    corrections: "Corrections",
    agent: "Agent standups",
  });
});
