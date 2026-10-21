import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { contributorTerms } from "./contributor-project.ts";
import { draftFromPitch } from "./from-pitch.ts";

const REVIEWER = `0x${"ab".repeat(20)}`;
const role = (slug, pct, holder = null) => ({
  slug,
  label: slug[0].toUpperCase() + slug.slice(1),
  pct,
  holder,
});

describe("draftFromPitch", () => {
  it("turns each role into a project worth its stake, and the founder's stake into starting Shares", () => {
    const { draft, roomWhole, leftOut } = draftFromPitch({
      name: "Night Bus",
      summary: "A short film about the last bus home.",
      founderPct: 30,
      roles: [role("design", 20, "Ann"), role("dev", 40)],
    });
    assert.equal(draft.founderShares, "300000");
    assert.deepEqual(
      draft.projects.map((p) => [p.name, p.shares]),
      [
        ["Dev", "400000"],
        ["Design", "200000"],
      ],
    );
    assert.match(draft.projects[1].check, /delivered by Ann/);
    // The founder may start with at most a third of the budget (D79): 900,000, of which 300,000 is room to grow.
    assert.equal(draft.budgetShares, "900000");
    assert.equal(roomWhole, 300_000n);
    assert.equal(draft.projectCap, "400000");
    assert.deepEqual(leftOut, []);
    // And the result is a draft the Start page accepts.
    const terms = contributorTerms({ ...draft, reviewers: REVIEWER });
    assert.equal(terms.projects.length, 2);
  });

  it("keeps the unassigned part of the board as room in the budget", () => {
    const { draft, roomWhole } = draftFromPitch({
      name: "Docs",
      summary: "Docs for everyone, written together.",
      founderPct: 10,
      roles: [role("writer", 50)],
    });
    assert.equal(draft.budgetShares, "900000");
    assert.equal(roomWhole, 400_000n);
  });

  it("starts a founder who declared no stake with 1%, and leaves out roles past eight", () => {
    const roles = Array.from({ length: 10 }, (_, i) => role(`r${i}`, 5 + i));
    const start = draftFromPitch({
      name: "Big team",
      summary: "Lots of people making one thing.",
      founderPct: 0,
      roles,
    });
    assert.equal(start.founderDefaulted, true);
    assert.equal(start.draft.founderShares, "10000");
    assert.equal(start.draft.projects.length, 8);
    assert.deepEqual(start.leftOut, ["R1", "R0"]);
    contributorTerms({ ...start.draft, reviewers: REVIEWER });
  });

  it("leaves one empty project to fill in when the board has no other roles", () => {
    const { draft } = draftFromPitch({
      name: "Solo",
      summary: "Just me, for now, building it.",
      founderPct: 25,
      roles: [],
    });
    assert.equal(draft.projects.length, 1);
    assert.equal(draft.projects[0].name, "");
  });
});
