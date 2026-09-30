/**
 * Desktop `quorumWatch.ts` under `node --test` — A5 watch states (web
 * parity): the visible gates, the TTL clock, and the honest scope note.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decodeTallies, quorumWatch } from "./quorumWatch.ts";

const T0 = 1_000_000n;
const DAY = 86_400n;

describe("quorumWatch", () => {
  it("leading when FOR beats AGAINST and clears minYes", () => {
    const w = quorumWatch({
      tallies: { forVotes: 12n, againstVotes: 5n, abstainVotes: 1n },
      minYes: 10n,
      ttlEndsAt: T0 + 20n * DAY,
      createdAt: T0,
      now: T0 + DAY,
    });
    assert.equal(w.status, "leading");
  });

  it("takes the larger shortfall of the two visible gates", () => {
    const w = quorumWatch({
      tallies: { forVotes: 6n, againstVotes: 8n, abstainVotes: 0n },
      minYes: 10n,
      ttlEndsAt: T0 + 20n * DAY,
      createdAt: T0,
      now: T0 + DAY,
    });
    assert.equal(w.votesNeeded, 4n);
    assert.equal(w.status, "needs-votes");
  });

  it("at-risk = short AND in the TTL's last quarter", () => {
    const w = quorumWatch({
      tallies: { forVotes: 1n, againstVotes: 0n, abstainVotes: 0n },
      minYes: 10n,
      ttlEndsAt: T0 + 10n * DAY,
      createdAt: T0 - 10n * DAY,
      now: T0 + 8n * DAY,
    });
    assert.equal(w.status, "at-risk");
  });

  it("expired short = defeated unless extended; expired met = executable", () => {
    const short = quorumWatch({
      tallies: { forVotes: 1n, againstVotes: 5n, abstainVotes: 0n },
      minYes: 10n,
      ttlEndsAt: T0,
      createdAt: T0 - DAY,
      now: T0 + 1n,
    });
    assert.equal(short.status, "expired");
    assert.match(short.detail, /defeated unless extended/);
    const met = quorumWatch({
      tallies: { forVotes: 12n, againstVotes: 1n, abstainVotes: 0n },
      minYes: 10n,
      ttlEndsAt: T0,
      createdAt: T0 - DAY,
      now: T0 + 1n,
    });
    assert.match(met.detail, /executable window/);
  });
});

describe("tallies decode", () => {
  it("reads the three words and rejects short data", () => {
    const word = (v) => v.padStart(64, "0");
    const tallies = decodeTallies(`0x${word("a")}${word("5")}${word("0")}`);
    assert.equal(tallies?.forVotes, BigInt("0xa"));
    assert.equal(tallies?.againstVotes, 5n);
    assert.equal(decodeTallies("0x1234"), null);
  });
});
