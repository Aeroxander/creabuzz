import assert from "node:assert/strict";
import { test } from "node:test";
import { hashText } from "@creaton/core/launchpad/work.ts";
import {
  challengeEvidenceFor,
  challengeEvidenceView,
  challengeEvidenceHash,
  challengeUpdateContent,
} from "./challenge-evidence.ts";
import { packetsOf } from "./evidence.ts";

const LOCK = "0xcccccccccccccccccccccccccccccccccccccccc";
const WORDS = "A beta is live at a public address, with its source published";
const TEXT =
  "Live at https://beta.example.org, source at https://example.org/src";
const milestone = (over = {}) => ({
  evidence: challengeEvidenceHash(TEXT),
  checkHash: hashText(WORDS),
  ...over,
});
const update = (over = {}) => ({
  id: "e1",
  author: "a".repeat(64),
  createdAt: 100,
  body: TEXT,
  claim: {
    id: challengeEvidenceHash(TEXT),
    mandate: LOCK,
    check: WORDS,
  },
  ...over,
});

test("the evidence the lock is given is the hash of the text published beside it", () => {
  assert.equal(challengeEvidenceHash(TEXT), hashText(TEXT));
  const content = challengeUpdateContent({
    milestone: 1,
    evidence: TEXT,
    check: WORDS,
    lock: LOCK.toUpperCase().replace("0X", "0x"),
  });
  assert.equal(content.title, "Evidence: milestone 2");
  assert.equal(content.body, TEXT);
  assert.deepEqual(content.links, [
    "https://beta.example.org",
    "https://example.org/src",
  ]);
  assert.deepEqual(content.claim, {
    id: challengeEvidenceHash(TEXT),
    mandate: LOCK,
    check: WORDS,
  });
});

test("a text is shown as the evidence only when it hashes to what the lock holds and its words are the milestone's", () => {
  const packets = packetsOf([update()]);
  const standing = challengeEvidenceFor(milestone(), packets, LOCK);
  assert.equal(standing.kind, "verified");
  assert.equal(standing.packet.evidence, TEXT);
  // Nothing published for it.
  assert.deepEqual(challengeEvidenceFor(milestone(), [], LOCK), {
    kind: "missing",
  });
  // Nothing submitted to the lock yet.
  assert.deepEqual(
    challengeEvidenceFor(milestone({ evidence: null }), packets, LOCK),
    { kind: "missing" },
  );
  // A text that does not hash to the lock's number is not shown, even under the right name.
  const forged = packetsOf([update({ body: "Something else entirely" })]);
  assert.deepEqual(challengeEvidenceFor(milestone(), forged, LOCK), {
    kind: "mismatch",
    packets: 1,
  });
  // The right text under other milestone words is not this milestone's evidence.
  const wrongWords = packetsOf([
    update({
      claim: {
        id: challengeEvidenceHash(TEXT),
        mandate: LOCK,
        check: "Something easier",
      },
    }),
  ]);
  assert.equal(
    challengeEvidenceFor(milestone(), wrongWords, LOCK).kind,
    "mismatch",
  );
  // A packet for another lock, or another evidence hash, is not about this one.
  const elsewhere = packetsOf([
    update({
      claim: {
        id: challengeEvidenceHash(TEXT),
        mandate: "0x" + "d".repeat(40),
        check: WORDS,
      },
    }),
  ]);
  assert.deepEqual(challengeEvidenceFor(milestone(), elsewhere, LOCK), {
    kind: "missing",
  });
});

test("the newest matching text wins, and a bad one beside a good one does not hide it", () => {
  const packets = packetsOf([
    update({ id: "old", createdAt: 100 }),
    update({ id: "bad", createdAt: 300, body: "tampered" }),
    update({ id: "new", createdAt: 200 }),
  ]);
  const standing = challengeEvidenceFor(milestone(), packets, LOCK);
  assert.equal(standing.kind, "verified");
  assert.equal(standing.packet.eventId, "new");
});

test("looking and not finding is not the same as the team not having published", () => {
  const verified = { kind: "verified", packet: {} };
  const missing = { kind: "missing" };
  const mismatch = { kind: "mismatch", packets: 1 };
  const view = (over) =>
    challengeEvidenceView({
      submitted: true,
      standing: missing,
      error: false,
      incomplete: false,
      ...over,
    });
  assert.equal(view({ submitted: false }), "none");
  assert.equal(view({ standing: verified }), "verified");
  // A text that verifies is shown even if a later read failed or the history was cut short.
  assert.equal(
    view({ standing: verified, error: true, incomplete: true }),
    "verified",
  );
  assert.equal(view({ error: true }), "unreadable");
  assert.equal(view({ error: true, standing: mismatch }), "unreadable");
  assert.equal(view({ standing: mismatch }), "mismatch");
  assert.equal(view({ incomplete: true }), "incomplete");
  assert.equal(view({ standing: mismatch, incomplete: true }), "mismatch");
  assert.equal(view({}), "missing");
});
