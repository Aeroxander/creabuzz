// Liveness derivation for org seats (kinds:44010 + 44200).
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  AGENT_LIVE_MAX_SECONDS,
  AGENT_WAITING_MAX_SECONDS,
  livenessStatus,
  newestSeenPerSeat,
  bestSeatStatus,
  collectAgentSeats,
} from "./nodeLiveness.ts";

const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);

function event(kind, pubkey, createdAt, tags = []) {
  return { kind, pubkey, created_at: createdAt, tags };
}

describe("livenessStatus (Paperclip semantics)", () => {
  it("labels a seat live under 5 minutes", () => {
    assert.equal(
      livenessStatus(1000, 1000 + AGENT_LIVE_MAX_SECONDS - 1),
      "live",
    );
  });

  it("boundary at exactly 5 minutes is waiting, not live", () => {
    assert.equal(
      livenessStatus(1000, 1000 + AGENT_LIVE_MAX_SECONDS),
      "waiting",
    );
  });

  it("labels a seat waiting between 5 and 60 minutes", () => {
    assert.equal(
      livenessStatus(1000, 1000 + AGENT_WAITING_MAX_SECONDS - 1),
      "waiting",
    );
  });

  it("boundary at exactly 60 minutes is gone", () => {
    assert.equal(
      livenessStatus(1000, 1000 + AGENT_WAITING_MAX_SECONDS),
      "gone",
    );
  });

  it("never-seen seats are gone", () => {
    assert.equal(livenessStatus(null, 999999), "gone");
  });

  it("future signals count as live (clock skew is not failure)", () => {
    assert.equal(livenessStatus(100_000, 90_000), "live");
  });
});

describe("newestSeenPerSeat", () => {
  const seats = [ALICE, BOB];

  it("reads 44010 signals from the event author (agent identity)", () => {
    const events = [event(44010, ALICE, 1000), event(44010, BOB, 1500)];
    const result = newestSeenPerSeat(events, seats, 1299);
    assert.equal(result.get(ALICE).status, "live");
    assert.equal(result.get(ALICE).lastSeenAt, 1000);
    assert.equal(result.get(BOB).lastSeenAt, 1500);
  });

  it("picks the newest signal per seat across both kinds", () => {
    const events = [
      event(44010, ALICE, 1000), // stale capability
      event(44200, BOB, 1200, [["p", ALICE]]), // fresher turn metric for ALICE
      event(44200, BOB, 1200, [["p", BOB]]),
    ];
    const result = newestSeenPerSeat(events, seats, 1300);
    assert.equal(result.get(ALICE).lastSeenAt, 1200);
    assert.equal(result.get(ALICE).status, "live");
    assert.equal(result.get(BOB).lastSeenAt, 1200);
  });

  it("yields gone for a seat with only old signals", () => {
    const events = [event(44010, ALICE, 100_000)];
    const result = newestSeenPerSeat(events, seats, 200_000);
    assert.equal(result.get(ALICE).status, "gone");
    assert.equal(result.get(BOB).status, "gone");
    assert.equal(result.get(ALICE).lastSeenAt, 100_000);
    assert.equal(result.get(BOB).lastSeenAt, null);
  });

  it("ignores malformed rows instead of crashing", () => {
    const events = [
      event("not-an-event", null, "nope", null),
      event(44010, undefined, undefined),
      event(44200, BOB, 1200, [["p"]]), // p tag without value
      event(44200, BOB, 1200, [["x", ALICE]]), // wrong tag name
    ];
    const result = newestSeenPerSeat(events, seats, 1300);
    assert.equal(result.get(ALICE).lastSeenAt, null);
    assert.equal(result.get(BOB).lastSeenAt, null);
  });

  it("matches seats case-insensitively", () => {
    const upper = ALICE.toUpperCase();
    const result = newestSeenPerSeat(
      [event(44010, upper, 1100)],
      [ALICE],
      1200,
    );
    assert.equal(result.get(ALICE).lastSeenAt, 1100);
  });
});

describe("bestSeatStatus", () => {
  it("returns null for an empty set (human-only node)", () => {
    assert.equal(bestSeatStatus([]), null);
  });

  it("live beats waiting beats gone", () => {
    assert.equal(bestSeatStatus(["gone", "waiting", "live"]), "live");
    assert.equal(bestSeatStatus(["gone", "waiting"]), "waiting");
    assert.equal(bestSeatStatus(["gone", undefined]), "gone");
  });
});

describe("collectAgentSeats", () => {
  it("collects unique lowercased seats across nodes", () => {
    const nodes = [
      { agentSeats: [ALICE, BOB] },
      { agentSeats: [ALICE.toUpperCase()] },
      { agentSeats: [] },
    ];
    assert.deepEqual(collectAgentSeats(nodes), [ALICE, BOB]);
  });
});
