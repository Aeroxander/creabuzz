/**
 * Golden-vector tests for the Phase 4 instrument (OA.md §6) — the SAME
 * corpus and the SAME numbers as `buzz-core::org_diag`'s Rust tests and
 * desktop's twin, so `buzz diag` and the UI cards can never
 * diverge silently.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  classOfKind,
  diagEventFromNostr,
  diagnose,
  driftProbes,
  MIN_EVENTS,
  supervision,
  thrash,
  timeSignal,
  tomasello,
  wefModes,
} from "./orgDiag.ts";

function ev(id, actor, at, cls, coordinate) {
  return {
    id: `e${String(id).padStart(2, "0")}`,
    actor,
    at,
    class: cls,
    ...(coordinate ? { coordinate } : {}),
  };
}

/** The golden corpus (identical to the Rust fixture). */
function corpus() {
  const classes = [
    "message",
    "message",
    "contribution",
    "message",
    "proposal",
    "grant",
    "message",
    "vote",
    "revision",
    "contribution",
    "message",
    "proposal",
    "grant",
    "vote",
    "revision",
    "message",
    "execute",
    "approval",
    "revision",
    "revision",
  ];
  return classes.map((cls, i) =>
    ev(
      i,
      i % 2 === 0 ? "a" : "b",
      1000 + i * 10,
      cls,
      cls === "revision" ? (i === 19 ? "q" : "p") : undefined,
    ),
  );
}

test("golden time signal is integer-exact (cross-language vectors)", () => {
  const ts = timeSignal(corpus());
  assert.equal(ts.burstinessBp, -10000);
  assert.equal(ts.bursty, false);
  assert.equal(ts.handoffRateBp, 9500);
  assert.equal(ts.handoffMedianLagS, 10);
  assert.match(ts.reading, /no timing coordination pattern/);
});

test("golden tomasello shares and institutional reading", () => {
  const t = tomasello(corpus());
  assert.equal(t.communicate.events, 6);
  assert.equal(t.communicate.shareBp, 3000);
  assert.equal(t.buildTrust.events, 4);
  assert.equal(t.buildTrust.shareBp, 2000);
  assert.equal(t.institutionalize.events, 6);
  assert.equal(t.institutionalize.shareBp, 3000);
  assert.match(t.reading, /institutionalization present/);
});

test("golden thrash scoreboard", () => {
  const t = thrash(corpus());
  assert.deepEqual(t, {
    revisions: 4,
    coordinates: 2,
    reworkRateBp: 5000,
    settledRateBp: 5000,
    reading:
      "thrash-shaped: most revisions rework a coordinate — the busywork reading",
  });
});

test("golden supervision and WEF thresholds", () => {
  const s = supervision(corpus());
  assert.deepEqual(s, {
    approvalRequests: 1,
    actions: 20,
    saturationBp: 500,
    topApproverShareBp: 10000,
    status: "watch",
  });
  const modes = wefModes(corpus());
  assert.equal(modes.length, 5);
  const by = (m) => modes.find((w) => w.mode === m);
  assert.equal(by("orchestration-drift").signalEvents, 1);
  assert.equal(by("orchestration-drift").status, "watch");
  assert.equal(by("systemic-complexity").status, "flag");
  assert.equal(by("cascading-effects").signalEvents, 0);
});

test("drift probe is a moved distribution and infers nothing else", () => {
  const events = [];
  for (let i = 0; i < 8; i++) {
    events.push(ev(i, "c", i, "message"));
    events.push(ev(100 + i, "d", 10 + i, "message"));
    events.push(ev(200 + i, "d", 20 + i, "grant"));
  }
  for (let i = 0; i < 8; i++) {
    events.push(ev(300 + i, "c", 3000 + i, "grant"));
    events.push(ev(400 + i, "d", 3010 + i, "message"));
    events.push(ev(500 + i, "d", 3020 + i, "grant"));
  }
  const probes = driftProbes(events);
  assert.equal(probes.length, 2);
  const c = probes.find((p) => p.actor === "c");
  const d = probes.find((p) => p.actor === "d");
  assert.equal(c.driftBp, 20000, "disjoint mixes");
  assert.equal(c.flagged, true);
  assert.equal(d.driftBp, 0, "same mix");
  assert.equal(d.flagged, false);
});

test("insufficient data is omitted, never zero", () => {
  const small = Array.from({ length: 5 }, (_, i) => ev(i, "a", i, "message"));
  const report = diagnose(small);
  assert.equal(report.timeSignal, undefined);
  assert.equal(report.tomasello, undefined);
  assert.equal(report.supervision, undefined);
  assert.equal(report.thrash, undefined);
  assert.deepEqual(report.drift, []);
  const json = JSON.parse(JSON.stringify(report));
  assert.equal("timeSignal" in json, false, "removed, not nulled");
  assert.equal("thrash" in json, false);
});

test("order independence: shuffled input, identical report", () => {
  const shuffled = [...corpus()].reverse();
  shuffled.splice(5, 0, shuffled.splice(0, 1)[0]);
  assert.equal(
    JSON.stringify(diagnose(corpus())),
    JSON.stringify(diagnose(shuffled)),
  );
});

test("class mapping is conservative", () => {
  assert.equal(classOfKind(47004), "proposal");
  assert.equal(classOfKind(47005, "vote"), "vote");
  assert.equal(classOfKind(47005, "execute"), "execute");
  assert.equal(classOfKind(47005, "claim"), "receipt");
  assert.equal(classOfKind(37013), "contribution");
  assert.equal(classOfKind(37011, "revoke"), "revoke");
  assert.equal(classOfKind(46010), "approval");
  assert.equal(classOfKind(5), "tombstone");
  assert.equal(classOfKind(12345), "other", "unknown → other");
});

test("diagEventFromNostr is strict and maps the wiki anchor", () => {
  const good = {
    id: "f".repeat(64),
    pubkey: "a".repeat(64),
    created_at: 1_700_000_000,
    kind: 44002,
    tags: [
      ["d", "default/standup"],
      ["kind", "vote"],
    ],
  };
  const parsed = diagEventFromNostr(good);
  assert.equal(parsed.class, "revision");
  assert.equal(parsed.coordinate, "default/standup");
  assert.equal(
    diagEventFromNostr({ ...good, created_at: "soon" }),
    null,
    "unparseable rows drop, never guess",
  );
  assert.equal(diagEventFromNostr({ ...good, id: undefined }), null);
});

test("insufficient threshold matches the Rust MIN_EVENTS", () => {
  assert.equal(MIN_EVENTS, 20);
});
