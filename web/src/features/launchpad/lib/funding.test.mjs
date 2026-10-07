import assert from "node:assert/strict";
import test from "node:test";

import {
  FUNDING_PATHS,
  FUNDING_SEEKING,
  FUNDING_STANCES,
  PLANNING_NUDGE_AFTER_SECONDS,
  chainRaise,
  effectiveFunding,
  effectiveStance,
  fundingContent,
  fundingCounts,
  fundingSummary,
  matchesFunding,
  parseFunding,
  planningIsStale,
  raisingFirst,
} from "./funding.ts";

const DAY = 24 * 60 * 60;

function launch(overrides = {}) {
  return {
    record: {
      stage: "draft",
      endBlock: null,
      funding: null,
      createdAt: 1_700_000_000,
      ...(overrides.record ?? {}),
    },
    receipts: overrides.receipts ?? [],
  };
}

function status(overrides = {}) {
  return {
    stance: "planning",
    seeking: [],
    path: null,
    opensAt: null,
    note: null,
    ...overrides,
  };
}

// ---- parse ----

test("parseFunding reads a full declaration", () => {
  const parsed = parseFunding({
    stance: "planning",
    seeking: ["backers", "contributors"],
    path: "proposals",
    opensAt: "2026-11-01",
    note: "  Aiming for late autumn.  ",
  });
  assert.deepEqual(parsed, {
    stance: "planning",
    seeking: ["backers", "contributors"],
    path: "proposals",
    opensAt: "2026-11-01",
    note: "Aiming for late autumn.",
  });
});

test("parseFunding refuses a malformed block instead of guessing", () => {
  assert.equal(parseFunding(undefined), null);
  assert.equal(parseFunding(null), null);
  assert.equal(parseFunding("planning"), null);
  assert.equal(parseFunding([]), null);
  assert.equal(parseFunding({}), null);
  assert.equal(parseFunding({ stance: "maybe" }), null);
  assert.equal(parseFunding({ stance: 3 }), null);
});

test("parseFunding keeps only known seeking words, once each", () => {
  const parsed = parseFunding({
    stance: "not-raising",
    seeking: ["backers", "whales", "backers", "advisors"],
  });
  assert.deepEqual(parsed?.seeking, ["backers", "advisors"]);
  assert.deepEqual(
    parseFunding({ stance: "closed", seeking: "backers" })?.seeking,
    [],
  );
});

test("parseFunding drops a date that is not a date and an empty note", () => {
  const parsed = parseFunding({
    stance: "planning",
    opensAt: "november",
    note: "   ",
  });
  assert.equal(parsed?.opensAt, null);
  assert.equal(parsed?.note, null);
});

test("a declaration round-trips through fundingContent", () => {
  const parsed = parseFunding(
    fundingContent(
      status({
        stance: "rolling",
        seeking: ["advisors"],
        path: "open-sale",
        opensAt: "2026-01-01",
        note: "Always open.",
      }),
    ),
  );
  assert.deepEqual(parsed, {
    stance: "rolling",
    seeking: ["advisors"],
    path: "open-sale",
    opensAt: "2026-01-01",
    note: "Always open.",
  });
});

test("every funding path is accepted and an invented one is dropped", () => {
  for (const path of FUNDING_PATHS) {
    assert.equal(parseFunding({ stance: "planning", path })?.path, path, path);
  }
  assert.equal(
    parseFunding({ stance: "planning", path: "vibes" })?.path,
    null,
    "an invented path must never reach the record",
  );
  assert.equal(parseFunding({ stance: "planning" })?.path, null);
});

test("fundingContent omits the optional fields rather than writing nulls", () => {
  assert.deepEqual(fundingContent(status({ stance: "not-raising" })), {
    stance: "not-raising",
  });
});

// ---- chain truth ----

test("a recorded outcome is done, whatever the record says", () => {
  for (const table of ["summon", "graduate", "failed", "refund-open"]) {
    assert.equal(
      chainRaise(
        launch({ record: { stage: "live" }, receipts: [{ table }] }),
        10,
      ),
      "done",
      table,
    );
  }
});

test("a stage that already says so is done even without a receipt", () => {
  assert.equal(
    chainRaise(launch({ record: { stage: "graduated" } }), 10),
    "done",
  );
  assert.equal(chainRaise(launch({ record: { stage: "failed" } }), 10), "done");
});

test("an open sale window is open; past it the raise is settling", () => {
  const live = launch({ record: { stage: "funding", endBlock: 100 } });
  assert.equal(chainRaise(live, 100), "open");
  assert.equal(chainRaise(live, 99), "open");
  assert.equal(chainRaise(live, 101), "settling");
});

test("an unreadable chain head never ends a raise", () => {
  assert.equal(
    chainRaise(launch({ record: { stage: "live", endBlock: 100 } }), null),
    "open",
  );
});

test("no sale on file is none", () => {
  assert.equal(chainRaise(launch(), 10), "none");
  assert.equal(chainRaise(launch({ record: { stage: "review" } }), 10), "none");
  assert.equal(
    chainRaise(launch({ record: { stage: "draft", endBlock: 5 } }), 10),
    "none",
  );
});

// ---- the contradiction rule ----

test("a live sale overrides a declaration that cannot hold", () => {
  for (const declared of ["not-raising", "planning", "closed"]) {
    assert.equal(
      effectiveStance(status({ stance: declared }), "open"),
      "raising",
      declared,
    );
  }
});

test("a live sale does not contradict the words that already cover it", () => {
  for (const declared of ["raising", "closing", "rolling"]) {
    assert.equal(
      effectiveStance(status({ stance: declared }), "open"),
      declared,
    );
  }
});

test("a finished sale moves a raise on to closing, then closed", () => {
  assert.equal(
    effectiveStance(status({ stance: "raising" }), "settling"),
    "closing",
  );
  assert.equal(
    effectiveStance(status({ stance: "raising" }), "done"),
    "closed",
  );
  assert.equal(
    effectiveStance(status({ stance: "not-raising" }), "done"),
    "closed",
  );
});

test("an open-ended round is never closed by one sale settling", () => {
  assert.equal(
    effectiveStance(status({ stance: "rolling" }), "settling"),
    "rolling",
  );
  assert.equal(
    effectiveStance(status({ stance: "rolling" }), "done"),
    "rolling",
  );
  assert.equal(
    effectiveStance(status({ stance: "rolling" }), "open"),
    "rolling",
  );
});

test("without chain truth the declaration stands, including pure intent", () => {
  assert.equal(
    effectiveStance(status({ stance: "planning" }), "none"),
    "planning",
  );
  assert.equal(
    effectiveStance(status({ stance: "not-raising" }), "none"),
    "not-raising",
  );
  assert.equal(
    effectiveStance(status({ stance: "closing" }), "none"),
    "closing",
  );
});

test("nothing declared and no sale reads as not raising", () => {
  assert.equal(effectiveStance(null, "none"), "not-raising");
  // ...but a sale overrides even that silence.
  assert.equal(effectiveStance(null, "open"), "raising");
});

test("every stance and every chain reading resolves without falling over", () => {
  for (const stance of FUNDING_STANCES) {
    for (const raise of ["none", "open", "settling", "done"]) {
      const out = effectiveStance(status({ stance }), raise);
      assert.ok(FUNDING_STANCES.includes(out), `${stance}/${raise} -> ${out}`);
    }
  }
});

test("effectiveFunding carries the declaration and flags a live sale", () => {
  const resolved = effectiveFunding(
    launch({
      record: {
        stage: "funding",
        funding: status({
          stance: "not-raising",
          seeking: ["backers"],
          note: "hello",
        }),
      },
    }),
    1,
  );
  assert.equal(resolved.stance, "raising");
  assert.deepEqual([...resolved.seeking], ["backers"]);
  assert.equal(resolved.note, "hello");
  assert.equal(resolved.raisingNow, true);
});

// ---- the stale-plan nudge ----

test("a plan left standing for 30 days gets a nudge", () => {
  const at = 1_700_000_000;
  assert.equal(
    planningIsStale(status(), at, at + PLANNING_NUDGE_AFTER_SECONDS - 1),
    false,
  );
  assert.equal(
    planningIsStale(status(), at, at + PLANNING_NUDGE_AFTER_SECONDS),
    true,
  );
});

test("only a standing plan gets nudged", () => {
  const at = 1_700_000_000;
  const later = at + 100 * DAY;
  assert.equal(
    planningIsStale(status({ stance: "not-raising" }), at, later),
    false,
  );
  assert.equal(
    planningIsStale(status({ stance: "raising" }), at, later),
    false,
  );
  assert.equal(planningIsStale(null, at, later), false);
});

// ---- discovery ----

function resolved(overrides = {}) {
  return {
    stance: "not-raising",
    seeking: [],
    path: null,
    note: null,
    opensAt: null,
    raisingNow: false,
    ...overrides,
  };
}

test("chips count every launch once per stance, and per wanted role", () => {
  const counts = fundingCounts([
    resolved({ stance: "raising", seeking: ["backers", "advisors"] }),
    resolved({ stance: "raising", seeking: ["backers"] }),
    resolved({ stance: "planning", seeking: ["contributors"] }),
  ]);
  assert.equal(counts.stance.raising, 2);
  assert.equal(counts.stance.planning, 1);
  assert.equal(counts.stance.closed, 0);
  assert.equal(counts.seeking.backers, 2);
  assert.equal(counts.seeking.advisors, 1);
  assert.equal(counts.seeking.contributors, 1);
});

test("every stance is counted even at zero, so the chips always render", () => {
  const counts = fundingCounts([]);
  assert.deepEqual(
    Object.keys(counts.stance).sort(),
    [...FUNDING_STANCES].sort(),
  );
  assert.deepEqual(
    Object.keys(counts.seeking).sort(),
    [...FUNDING_SEEKING].sort(),
  );
  assert.ok(Object.values(counts.stance).every((n) => n === 0));
});

test("filtering by stance and by wanted role", () => {
  const backers = resolved({ stance: "planning", seeking: ["backers"] });
  const builders = resolved({ stance: "planning", seeking: ["contributors"] });
  assert.deepEqual(
    [backers, builders].filter((r) =>
      matchesFunding(r, { stance: "planning" }),
    ),
    [backers, builders],
  );
  assert.deepEqual(
    [backers, builders].filter((r) =>
      matchesFunding(r, { seeking: "backers" }),
    ),
    [backers],
  );
  assert.deepEqual(
    [backers, builders].filter((r) => matchesFunding(r, { stance: "raising" })),
    [],
  );
  assert.deepEqual(
    [backers, builders].filter((r) => matchesFunding(r, {})),
    [backers, builders],
  );
});

test("raising now leads, and the caller's ranking holds inside both groups", () => {
  const items = [
    { id: "old-idea", f: resolved({ stance: "not-raising" }) },
    { id: "live-1", f: resolved({ stance: "raising" }) },
    { id: "new-idea", f: resolved({ stance: "not-raising" }) },
    { id: "live-2", f: resolved({ stance: "raising" }) },
    { id: "planned", f: resolved({ stance: "planning" }) },
  ];
  assert.deepEqual(
    raisingFirst(items, (i) => i.f).map((i) => i.id),
    ["live-1", "live-2", "old-idea", "new-idea", "planned"],
  );
});

test("raising first is a no-op once nothing is raising", () => {
  const items = [{ id: "a" }, { id: "b" }];
  assert.deepEqual(
    raisingFirst(items, () => resolved()),
    items,
  );
});

// ---- copy ----

test("the summary reads as one plain sentence", () => {
  assert.equal(fundingSummary(resolved({ stance: "raising" })), "Raising now");
  assert.equal(
    fundingSummary(
      resolved({ stance: "not-raising", seeking: ["contributors"] }),
    ),
    "Not raising · looking for contributors",
  );
  assert.equal(
    fundingSummary(
      resolved({ stance: "planning", seeking: ["backers", "advisors"] }),
    ),
    "Planning a raise · looking for backers, advisors",
  );
});
