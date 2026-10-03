import assert from "node:assert/strict";
import test from "node:test";

import {
  gateProgress,
  ideaId,
  ideaIssue,
  ideaToInput,
  isIdea,
  SUPPORTER_GATE,
} from "./idea.ts";

const bare = {
  stage: "draft",
  auction: null,
  token: null,
  requiredRaised: null,
  floorPrice: null,
};

test("a draft with no sale terms is an idea", () => {
  assert.equal(isIdea(bare), true);
});

test("any sale term, or a later stage, makes it more than an idea", () => {
  assert.equal(isIdea({ ...bare, requiredRaised: "1" }), false);
  assert.equal(isIdea({ ...bare, floorPrice: "1" }), false);
  assert.equal(isIdea({ ...bare, auction: "0xabc" }), false);
  assert.equal(isIdea({ ...bare, token: "0xabc" }), false);
  assert.equal(isIdea({ ...bare, stage: "funding" }), false);
});

test("ideaIssue asks for a name and a sentence", () => {
  assert.match(ideaIssue({ name: "", pitch: "x".repeat(20) }), /name/);
  assert.match(ideaIssue({ name: "---", pitch: "x".repeat(20) }), /letter/);
  assert.match(ideaIssue({ name: "Nebula", pitch: "short" }), /sentence/);
  assert.match(
    ideaIssue({ name: "Nebula", pitch: "x".repeat(141) }),
    /under 140/,
  );
  assert.equal(
    ideaIssue({ name: "Nebula", pitch: "A tool that maps nebulae." }),
    null,
  );
});

test("ideaId uses the slug, and never reuses an id the founder has", () => {
  assert.equal(ideaId("Nebula DAO!", []), "nebula-dao");
  const taken = ["nebula-dao"];
  const next = ideaId("Nebula DAO", taken, () => 0.5);
  assert.notEqual(next, "nebula-dao");
  assert.match(next, /^nebula-dao-[0-9a-z]{4}$/);
  assert.equal(ideaId("???", []), "idea");
});

test("an idea publishes no money, no chain and no token", () => {
  const input = ideaToInput({
    id: "nebula",
    name: " Nebula ",
    pitch: " A tool. ",
    image: "  ",
    category: "Software",
    chat: { team: "t", supporters: "s", backers: null },
  });
  assert.equal(input.name, "Nebula");
  assert.equal(input.pitch, "A tool.");
  assert.equal(input.image, undefined);
  assert.equal(input.category, "Software");
  assert.equal(input.stage, "draft");
  for (const field of [
    "chainId",
    "floorPrice",
    "requiredRaised",
    "auction",
    "token",
  ]) {
    assert.equal(input[field], "");
  }
  assert.equal(input.allocation, undefined);
  assert.equal(input.tokenPlan, undefined);
  assert.equal(
    isIdea({
      ...bare,
      ...{ requiredRaised: input.requiredRaised, floorPrice: input.floorPrice },
    }),
    true,
  );
});

test("gateProgress counts toward the nudge and clamps", () => {
  assert.deepEqual(gateProgress(3), {
    count: 3,
    needed: SUPPORTER_GATE,
    open: false,
    percent: 30,
  });
  assert.equal(gateProgress(SUPPORTER_GATE).open, true);
  assert.equal(gateProgress(500).percent, 100);
  assert.equal(gateProgress(-4).count, 0);
});
