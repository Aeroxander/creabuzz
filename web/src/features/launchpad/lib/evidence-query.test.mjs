import assert from "node:assert/strict";
import test from "node:test";

import {
  EVIDENCE_MAX_PAGES,
  EVIDENCE_QUERY_LIMIT,
  authorUpdatesFilter,
  evidenceQueryFilter,
  readAuthorUpdates,
  readEvidenceEvents,
} from "./evidence-query.ts";
import { KIND_LAUNCH_UPDATE } from "../../../shared/constants/kinds.ts";

test("a launch's evidence is asked for by its own coordinate, with explicit kinds and a bounded size", () => {
  const filter = evidenceQueryFilter("37001:abc:nebula");
  // The server refuses a filter with no kinds, and an unbounded read is a lever for whoever reads.
  assert.deepEqual(filter.kinds, [KIND_LAUNCH_UPDATE]);
  assert.deepEqual(filter["#a"], ["37001:abc:nebula"]);
  assert.equal(filter.limit, EVIDENCE_QUERY_LIMIT);
  assert.ok(EVIDENCE_QUERY_LIMIT > 0 && EVIDENCE_QUERY_LIMIT <= 1000);
});

test("it does not depend on the directory query, so it is not cut by what else the server holds", () => {
  // The directory filter names every launchpad kind with its own limit; this one names only the updates of one launch.
  const filter = evidenceQueryFilter("37001:abc:nebula");
  assert.equal(filter.kinds.length, 1);
  assert.equal(filter.authors, undefined);
});

/** A fake relay holding `count` updates, one second apart, newest first; it honours `until` and `limit` like the real one. */
function relayWith(count, { sameSecond = false } = {}) {
  const all = Array.from({ length: count }, (_, i) => ({
    id: `e${i}`,
    created_at: sameSecond ? 1_000 : 1_000_000 - i,
  }));
  const asked = [];
  return {
    asked,
    fetchPage: async (filter) => {
      asked.push(filter);
      const until = filter.until ?? Infinity;
      return all.filter((e) => e.created_at <= until).slice(0, filter.limit);
    },
  };
}

test("a packet behind more than a page of newer updates from the same launch is still found", async () => {
  // 501 newer updates, then the outstanding claim's evidence: the old single read of 500 never reached it.
  const relay = relayWith(EVIDENCE_QUERY_LIMIT + 1 + 1);
  const { events, complete } = await readEvidenceEvents(
    relay.fetchPage,
    "37001:abc:nebula",
  );
  assert.equal(complete, true);
  assert.equal(events.length, EVIDENCE_QUERY_LIMIT + 2);
  assert.ok(events.some((e) => e.id === `e${EVIDENCE_QUERY_LIMIT + 1}`));
  // Each later page starts where the last stopped.
  assert.equal(relay.asked[0].until, undefined);
  assert.ok(relay.asked[1].until !== undefined);
});

test("a short launch is read in one page and is complete", async () => {
  const relay = relayWith(3);
  const { events, complete } = await readEvidenceEvents(relay.fetchPage, "c");
  assert.equal(complete, true);
  assert.equal(events.length, 3);
  assert.equal(relay.asked.length, 1);
});

test("history beyond the page bound is read up to the bound and reported incomplete, never as finished", async () => {
  const relay = relayWith(EVIDENCE_QUERY_LIMIT * (EVIDENCE_MAX_PAGES + 2));
  const { events, complete } = await readEvidenceEvents(relay.fetchPage, "c");
  assert.equal(complete, false);
  assert.equal(relay.asked.length, EVIDENCE_MAX_PAGES);
  assert.ok(events.length > EVIDENCE_QUERY_LIMIT);
});

test("a page of updates all in one second cannot be walked past and is reported incomplete without looping", async () => {
  const relay = relayWith(EVIDENCE_QUERY_LIMIT + 50, { sameSecond: true });
  const { complete } = await readEvidenceEvents(relay.fetchPage, "c");
  assert.equal(complete, false);
  assert.ok(relay.asked.length <= 2);
});

test("a founder's own records are asked for by author, so nobody else's can crowd them out of a page", async () => {
  const filter = authorUpdatesFilter("f".repeat(64));
  assert.deepEqual(filter, {
    kinds: [KIND_LAUNCH_UPDATE],
    authors: ["f".repeat(64)],
    limit: EVIDENCE_QUERY_LIMIT,
  });
  // No tag filter: the server narrows by author and kind before its limit, and by tags only after it.
  assert.equal(
    Object.keys(filter).some((key) => key.startsWith("#")),
    false,
  );

  // A server where a stranger has posted a full page of newer records: the founder's are all still read, to the end.
  const FOUNDER = "f".repeat(64);
  const events = [
    { id: "goal", pubkey: FOUNDER, created_at: 10 },
    { id: "update", pubkey: FOUNDER, created_at: 20 },
  ];
  for (let i = 0; i < EVIDENCE_QUERY_LIMIT; i += 1)
    events.push({ id: `junk${i}`, pubkey: "e".repeat(64), created_at: 1000 });
  const asked = [];
  const fetchPage = async (f) => {
    asked.push(f);
    return events
      .filter((e) => f.authors.includes(e.pubkey))
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, f.limit);
  };
  const read = await readAuthorUpdates(fetchPage, FOUNDER);
  assert.equal(read.complete, true);
  assert.deepEqual(read.events.map((e) => e.id).sort(), ["goal", "update"]);
  assert.deepEqual(asked[0].authors, [FOUNDER]);
});
