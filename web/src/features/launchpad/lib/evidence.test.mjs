import assert from "node:assert/strict";
import test from "node:test";

import { hashText } from "@creaton/core/launchpad/work.ts";

import {
  EVIDENCE_MAX_CHARS,
  evidenceFor,
  evidenceProblem,
  evidenceUpdateContent,
  packetMatches,
  packetsOf,
  splitSelfCheck,
  urlsIn,
  withSelfCheck,
} from "./evidence.ts";

const ID = `0x${"77".repeat(32)}`;
const OTHER = `0x${"88".repeat(32)}`;
const MANDATE = "0x00000000000000000000000000000000000000ee";
const EVIDENCE = "The docs are merged: https://example.com/pr/1";
const CHECK = "docs merged and reviewed";
const claim = (over = {}) => ({
  id: ID,
  record: {
    evidenceHash: hashText(EVIDENCE),
    checkHash: hashText(CHECK),
    ...over,
  },
});
const update = (over = {}, claimOver = {}) => ({
  id: "e1",
  author: "a".repeat(64),
  createdAt: 100,
  body: EVIDENCE,
  claim: { id: ID, mandate: MANDATE, check: CHECK, ...claimOver },
  ...over,
});

test("only updates that name a claim are evidence", () => {
  const packets = packetsOf([
    update(),
    { id: "e2", author: "b", createdAt: 1, body: "an ordinary update" },
  ]);
  assert.equal(packets.length, 1);
  assert.equal(packets[0].claimId, ID);
});

test("evidence is what hashes to what the claim committed to, and nothing else is shown as it", () => {
  const [packet] = packetsOf([update()]);
  assert.equal(packetMatches(claim(), packet), true);
  // Different words: the hash no longer matches.
  assert.equal(
    packetMatches(claim({ evidenceHash: hashText("something else") }), packet),
    false,
  );
  assert.equal(
    packetMatches(claim({ checkHash: hashText("other words") }), packet),
    false,
  );
  // A claim that has no check yet can still show its evidence.
  assert.equal(
    packetMatches(claim({ checkHash: `0x${"0".repeat(64)}` }), packet),
    true,
  );
  // Another claim's packet is not this claim's.
  assert.equal(packetMatches({ ...claim(), id: OTHER }, packet), false);
});

test("a claim with no packet, or only packets that do not match, tells the reviewer so", () => {
  assert.deepEqual(evidenceFor(claim(), []), { kind: "missing" });
  assert.deepEqual(
    evidenceFor(claim(), packetsOf([update({}, { id: OTHER })])),
    { kind: "missing" },
  );
  const wrong = packetsOf([update({ body: "tampered" })]);
  assert.deepEqual(evidenceFor(claim(), wrong), {
    kind: "mismatch",
    packets: 1,
  });
});

test("the newest matching packet is the one shown, and a bad one beside a good one does not hide it", () => {
  const packets = packetsOf([
    update({ id: "old", createdAt: 100 }),
    update({ id: "new", createdAt: 200 }),
    update({ id: "junk", createdAt: 300, body: "tampered" }),
  ]);
  const standing = evidenceFor(claim(), packets);
  assert.equal(standing.kind, "verified");
  assert.equal(standing.packet.eventId, "new");
});

test("a packet for the right claim in another work budget is not accepted when the budget is named", () => {
  const packets = packetsOf([
    update({}, { mandate: "0x00000000000000000000000000000000000000ff" }),
  ]);
  assert.equal(evidenceFor(claim(), packets, MANDATE).kind, "missing");
  assert.equal(evidenceFor(claim(), packets).kind, "verified");
});

test("the update that publishes evidence carries the text exactly and names the claim", () => {
  const content = evidenceUpdateContent({
    name: "write-docs",
    claimId: ID.toUpperCase().replace("0X", "0x"),
    mandate: MANDATE,
    evidence: EVIDENCE,
    check: CHECK,
  });
  assert.equal(content.body, EVIDENCE);
  assert.deepEqual(content.claim, { id: ID, mandate: MANDATE, check: CHECK });
  assert.deepEqual(content.links, ["https://example.com/pr/1"]);
  assert.match(content.title, /write-docs/);
});

test("links are found for the update and capped", () => {
  assert.deepEqual(
    urlsIn(
      "see https://a.example/x and https://a.example/x, plus http://b.example",
    ),
    ["https://a.example/x", "http://b.example"],
  );
  assert.equal(
    urlsIn(
      Array.from({ length: 20 }, (_, i) => `https://e.example/${i}`).join(" "),
    ).length,
    8,
  );
  assert.deepEqual(urlsIn("javascript:alert(1)"), []);
});

test("empty and oversized evidence are refused in plain words", () => {
  assert.match(evidenceProblem("  "), /Say what you are submitting/);
  assert.match(evidenceProblem("x".repeat(EVIDENCE_MAX_CHARS + 1)), /too long/);
  assert.equal(evidenceProblem("done"), null);
});

test("how the submitter checked their work goes at the end of the evidence, which the claim commits to whole", () => {
  const full = withSelfCheck("  https://example.com/pr/1 ", {
    met: "Ran the docs build; every page from the list is there",
    notMet: "",
  });
  assert.equal(
    full,
    "https://example.com/pr/1\n\nHow I checked it: Ran the docs build; every page from the list is there",
  );
  const both = withSelfCheck("PR 1", {
    met: "Read it twice",
    notMet: "No pictures yet",
  });
  assert.match(
    both,
    /How I checked it: Read it twice\n\nNot met yet: No pictures yet$/,
  );
  // Nothing said: the evidence alone, as before.
  assert.equal(withSelfCheck("PR 1", { met: " ", notMet: "" }), "PR 1");
  // The hash is of the whole text, so a reviewer reading it can check it is what was submitted.
  assert.notEqual(hashText(full), hashText("https://example.com/pr/1"));
});

test("the evidence splits back into the work and the submitter's check, and older evidence is all work", () => {
  const full = withSelfCheck("https://example.com/pr/1", {
    met: "Ran the build",
    notMet: "No pictures",
  });
  assert.deepEqual(splitSelfCheck(full), {
    work: "https://example.com/pr/1",
    met: "Ran the build",
    notMet: "No pictures",
  });
  assert.deepEqual(splitSelfCheck("Old evidence\nwith lines"), {
    work: "Old evidence\nwith lines",
    met: "",
    notMet: "",
  });
  assert.deepEqual(
    splitSelfCheck(withSelfCheck("PR", { met: "Read it", notMet: "" })),
    { work: "PR", met: "Read it", notMet: "" },
  );
});
