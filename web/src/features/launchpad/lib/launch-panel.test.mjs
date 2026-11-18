import assert from "node:assert/strict";
import test from "node:test";

import {
  EMPTY_PANEL_DRAFT,
  challengeFromDraft,
  challengeWaits,
  loadPanelDraft,
  PANEL_OPEN_SECONDS,
  PANEL_OPEN_YEARS,
  panelFromDraft,
  MAX_TERMS_CHARS,
  MIN_TERMS_CHARS,
  panelSpare,
  reviewerList,
  savePanelDraft,
} from "./launch-panel.ts";

const A = "0x00000000000000000000000000000000000000a1";
const B = "0x00000000000000000000000000000000000000a2";
const C = "0x00000000000000000000000000000000000000a3";
const NOW = 1_700_000_000;
const USDC = { currencyDecimals: 6, other: "loading" };
const TERMS =
  "Each agreed to answer within 7 days. Unpaid, no stake in the project.";
const draft = (over = {}) => ({
  ...EMPTY_PANEL_DRAFT,
  reviewers: `${A}\n${B}\n${C}`,
  agreed: true,
  terms: TERMS,
  ...over,
});

test("the people named are read however they were separated", () => {
  assert.deepEqual(reviewerList(`${A}, ${B}\n${C} ;`), [A, B, C]);
  assert.deepEqual(reviewerList("  \n "), []);
});

test("a panel needs someone on it, and says so in plain words", () => {
  const made = panelFromDraft(draft({ reviewers: "  " }), USDC, NOW);
  assert.match(made.problem, /Name who judges/);
});

test("with nothing else said, a simple majority must agree, there is no bond, and the panel stays open two years", () => {
  const { panel } = panelFromDraft(draft(), USDC, NOW);
  assert.deepEqual(panel.reviewers, [A, B, C]);
  assert.equal(panel.quorum, 2);
  assert.equal(panel.bond, 0n);
  assert.equal(panel.bondToken, "");
  assert.equal(panel.endsAt, NOW + PANEL_OPEN_SECONDS);
  assert.equal(panel.now, NOW);
  assert.equal(
    panelFromDraft(draft({ reviewers: `${A}\n${B}` }), USDC, NOW).panel.quorum,
    2,
  );
  assert.equal(
    panelFromDraft(draft({ reviewers: A }), USDC, NOW).panel.quorum,
    1,
  );
});

test("a bond is in whole units of the sale currency unless another token is named", () => {
  const { panel } = panelFromDraft(
    draft({ bond: "25", quorum: "3" }),
    USDC,
    NOW,
  );
  assert.equal(panel.bond, 25_000_000n);
  assert.equal(panel.bondToken, "");
  assert.equal(panel.quorum, 3);
  const other = panelFromDraft(
    draft({
      bond: "25",
      bondIn: "other",
      bondOther: "0x00000000000000000000000000000000000000d1",
    }),
    { currencyDecimals: 6, other: { decimals: 18 } },
    NOW,
  );
  assert.equal(other.panel.bond, 25n * 10n ** 18n);
  assert.equal(
    other.panel.bondToken,
    "0x00000000000000000000000000000000000000d1",
  );
});

test("another token that is not an address, not yet read, or no token at all is said in plain words", () => {
  const named = (over, facts) =>
    panelFromDraft(draft({ bond: "1", bondIn: "other", ...over }), facts, NOW);
  assert.match(named({ bondOther: "nope" }, USDC).problem, /Paste the address/);
  const addr = "0x00000000000000000000000000000000000000d1";
  assert.match(named({ bondOther: addr }, USDC).problem, /Reading that token/);
  assert.match(
    named({ bondOther: addr }, { currencyDecimals: 6, other: "unreadable" })
      .problem,
    /could not read a token at that address/,
  );
  // The other token only matters when there is a bond to pay in it.
  assert.ok(
    panelFromDraft(draft({ bondIn: "other", bondOther: "nope" }), USDC, NOW)
      .panel,
  );
});

test("a bond with more fractional digits than the token has is refused, not rounded", () => {
  const made = panelFromDraft(draft({ bond: "1.1234567" }), USDC, NOW);
  assert.ok(made.problem);
});

const memory = () => {
  const map = new Map();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => map.set(k, v),
  };
};

test("what the founder typed survives a reload, per launch, and nothing else does", () => {
  const storage = memory();
  const typed = {
    ...EMPTY_PANEL_DRAFT,
    reviewers: `${A}\n${B}`,
    quorum: "2",
    bond: "25",
    terms: TERMS,
    agreed: true,
  };
  savePanelDraft("alice:nebula", typed, storage);
  assert.deepEqual(loadPanelDraft("alice:nebula", storage), typed);
  assert.deepEqual(
    loadPanelDraft("alice:other", storage),
    EMPTY_PANEL_DRAFT,
    "another launch starts empty",
  );
});

test("a draft that is missing, broken or the wrong shape is ignored rather than trusted", () => {
  const storage = memory();
  assert.deepEqual(loadPanelDraft("x", storage), EMPTY_PANEL_DRAFT);
  storage.setItem("buzz.launchpad.panel-draft:x", "{not json");
  assert.deepEqual(loadPanelDraft("x", storage), EMPTY_PANEL_DRAFT);
  storage.setItem("buzz.launchpad.panel-draft:x", JSON.stringify(["a"]));
  assert.deepEqual(loadPanelDraft("x", storage), EMPTY_PANEL_DRAFT);
  storage.setItem(
    "buzz.launchpad.panel-draft:x",
    JSON.stringify({
      reviewers: 5,
      quorum: null,
      bond: "9",
      bondIn: "weird",
      bondOther: {},
    }),
  );
  assert.deepEqual(loadPanelDraft("x", storage), {
    ...EMPTY_PANEL_DRAFT,
    bond: "9",
  });
  // No storage at all (a private window) is the empty draft, and saving into it does not throw.
  assert.deepEqual(loadPanelDraft("x", null), EMPTY_PANEL_DRAFT);
  savePanelDraft("x", EMPTY_PANEL_DRAFT, null);
});

test("the panel says how many reviewers could be unreachable before no milestone can be approved", () => {
  // Three named, a simple majority (two) must agree: one can be missing.
  assert.deepEqual(panelSpare(draft()), { reviewers: 3, needed: 2, spare: 1 });
  // Everyone must agree: nobody can be missing, which is the warning case.
  assert.deepEqual(panelSpare(draft({ quorum: "3" })), {
    reviewers: 3,
    needed: 3,
    spare: 0,
  });
  // One reviewer is a majority of one.
  assert.equal(panelSpare(draft({ reviewers: A })).spare, 0);
  // Asking for more agreement than there are people is negative, never hidden.
  assert.equal(panelSpare(draft({ quorum: "5" })).spare, -2);
  // Nothing to say until someone is named, or while the number is not one.
  assert.equal(panelSpare(draft({ reviewers: "" })), null);
  assert.equal(panelSpare(draft({ quorum: "many" })), null);
  assert.equal(panelSpare(draft({ quorum: "0" })), null);
});

test("the panel's lifetime in the words is the lifetime it is created with", () => {
  assert.equal(PANEL_OPEN_YEARS * 365 * 86_400, PANEL_OPEN_SECONDS);
});

test("the launch is not allowed until the founder says they asked the reviewers and how those reviewers will work", () => {
  const unasked = panelFromDraft(draft({ agreed: false }), USDC, NOW);
  assert.match(unasked.problem, /asked each reviewer/);
  const silent = panelFromDraft(draft({ terms: "   soon   " }), USDC, NOW);
  assert.match(silent.problem, /how your reviewers will work/);
  assert.ok(
    draft({ terms: "x".repeat(MIN_TERMS_CHARS - 1) }).terms.length <
      MIN_TERMS_CHARS,
  );
  assert.match(
    panelFromDraft(draft({ terms: "x".repeat(MIN_TERMS_CHARS - 1) }), USDC, NOW)
      .problem,
    /how your reviewers will work/,
  );
  assert.match(
    panelFromDraft(draft({ terms: "x".repeat(MAX_TERMS_CHARS + 1) }), USDC, NOW)
      .problem,
    /under 1000 characters/,
  );
});

test("the terms the founder wrote come back trimmed, to be kept on the launch record beside the reviewers", () => {
  const made = panelFromDraft(draft({ terms: `  ${TERMS}  ` }), USDC, NOW);
  assert.equal(made.terms, TERMS);
  assert.deepEqual(made.panel.reviewers.length, 3);
});

test("a saved draft keeps the terms and the confirmation, and a stored value of the wrong type is not trusted", () => {
  const storage = memory();
  storage.setItem(
    "buzz.launchpad.panel-draft:x",
    JSON.stringify({ reviewers: "", terms: 5, agreed: "yes" }),
  );
  const loaded = loadPanelDraft("x", storage);
  assert.equal(loaded.terms, "");
  assert.equal(loaded.agreed, false);
});

test("a new launch lets holders judge its milestones, and a draft saved before there was a choice keeps what it was", () => {
  assert.equal(EMPTY_PANEL_DRAFT.review, "challenge");
  const store = (value) => ({ getItem: () => JSON.stringify(value) });
  // Reviewers typed into an old draft: it was a panel launch and stays one.
  assert.equal(
    loadPanelDraft("k", store({ reviewers: `${A}\n${B}`, terms: "x" })).review,
    "panel",
  );
  // An old draft with nothing typed has no reason to be a panel.
  assert.equal(
    loadPanelDraft("k", store({ reviewers: "  " })).review,
    "challenge",
  );
  // A saved choice is kept either way.
  assert.equal(loadPanelDraft("k", store({ review: "panel" })).review, "panel");
  assert.equal(
    loadPanelDraft("k", store({ review: "challenge", reviewers: A })).review,
    "challenge",
  );
});

test("the holders' challenge asks for nothing but a bond, which is the default unless one is typed", () => {
  assert.deepEqual(challengeFromDraft({ challengeBond: "" }, 6), {
    challenge: {},
  });
  assert.deepEqual(challengeFromDraft({ challengeBond: "  " }, 6), {
    challenge: {},
  });
  assert.deepEqual(challengeFromDraft({ challengeBond: "25" }, 6), {
    challenge: { bond: 25_000_000n },
  });
  assert.deepEqual(challengeFromDraft({ challengeBond: "0" }, 6), {
    challenge: { bond: 0n },
  });
  assert.ok("problem" in challengeFromDraft({ challengeBond: "lots" }, 6));
  assert.ok("problem" in challengeFromDraft({ challengeBond: "-1" }, 6));
  // More decimals than the token has are refused, not rounded.
  assert.ok("problem" in challengeFromDraft({ challengeBond: "1.5" }, 0));
});

test("on a test network the waits can be shorter, within the lock's limits; a real network keeps the usual ones", () => {
  const DAY = 86_400;
  const draft = {
    ...EMPTY_PANEL_DRAFT,
    challengeWindow: "1",
    challengeVote: "1",
    challengeLate: "2",
  };
  assert.deepEqual(challengeFromDraft(draft, 6, true), {
    challenge: { window: DAY, votePeriod: DAY, clawback: 2 * DAY },
  });
  // Typed on a real network, they are ignored: the launch uses the usual waits.
  assert.deepEqual(challengeFromDraft(draft, 6, false), { challenge: {} });
  assert.deepEqual(challengeWaits(draft, false), {
    window: 7 * DAY,
    votePeriod: 5 * DAY,
    clawback: 30 * DAY,
  });
  assert.deepEqual(challengeWaits(draft, true), {
    window: DAY,
    votePeriod: DAY,
    clawback: 2 * DAY,
  });
  // Empty is the usual wait; no late objections at all is allowed.
  assert.deepEqual(
    challengeFromDraft({ ...EMPTY_PANEL_DRAFT, challengeLate: "0" }, 6, true),
    { challenge: { clawback: 0 } },
  );
  for (const [field, value, words] of [
    ["challengeWindow", "0", /1 to 30 days/],
    ["challengeWindow", "31", /1 to 30 days/],
    ["challengeVote", "1.5", /1 to 30 days/],
    ["challengeLate", "181", /0 to 180 days/],
    ["challengeLate", "-1", /0 to 180 days/],
  ]) {
    const result = challengeFromDraft(
      { ...EMPTY_PANEL_DRAFT, [field]: value },
      6,
      true,
    );
    assert.match(result.problem, words, `${field} ${value}`);
  }
  // The bond and the waits together.
  assert.deepEqual(
    challengeFromDraft(
      { ...EMPTY_PANEL_DRAFT, challengeBond: "5", challengeWindow: "3" },
      6,
      true,
    ),
    { challenge: { bond: 5_000_000n, window: 3 * DAY } },
  );
});
