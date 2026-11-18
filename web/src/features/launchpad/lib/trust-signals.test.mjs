// Trust signals — verdicts/claims/receipts per launch, contribution reviews
// and approval outcomes per community.
//
// Sources bound here (READ-ONLY citations):
// - `docs/nips/NIP-LP.md:268-284` — 47005 `kind=verdict` with the closed
//   `approve|reject` vocabulary, `kind=claim` with the evidence hash, both
//   carrying the settlement `tx` tag the relay refuses to accept without.
// - `web/src/shared/constants/kinds.ts` — 47003 is the founder *update*
//   (title/body); verdicts ride 47005, which is why this module aggregates
//   `LaunchReceipt.table === "verdict"`.
// - `docs/nips/NIP-ORG.md:373-399` — 37013 review disposal: reviewers
//   republish under their own key, canonical = newest `created_at` per `d`
//   tag, tie broken by lowest event id.
// - `crates/buzz-core/src/kind.rs:695-697` — 46030 grant / 46031 deny.
import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregateLaunchTrustSignals,
  communityDerivation,
  communityTrackState,
  EMPTY_COMMUNITY_COPY,
  EMPTY_TRACK_RECORD_COPY,
  emptyTrustRecord,
  KIND_APPROVAL_DENY,
  KIND_APPROVAL_GRANT,
  summarizeCommunityTrustSignals,
  trackRecordDerivation,
  trackRecordState,
} from "./trust-signals.ts";

const FOUNDER = "a".repeat(64);
const VERIFIER_ONE = "b".repeat(64);
const VERIFIER_TWO = "c".repeat(64);
const TX_OK = `0x${"cd".repeat(32)}`;
const LAUNCH_KEY = `${FOUNDER}:nebula`;

let seq = 0;

function receipt(
  table,
  payload,
  { id, author = VERIFIER_ONE, createdAt = 1000, tx = TX_OK } = {},
) {
  seq += 1;
  return {
    id: id ?? `receipt-${seq}`,
    launchId: "nebula",
    launchKey: LAUNCH_KEY,
    author,
    createdAt,
    table,
    tx,
    payload,
  };
}

function event(kind, id, content, tags = [], overrides = {}) {
  seq += 1;
  return {
    id: id ?? `event-${seq}`,
    pubkey: FOUNDER,
    created_at: 1000,
    kind,
    tags,
    content: typeof content === "string" ? content : JSON.stringify(content),
    sig: "sig",
    ...overrides,
  };
}

test("verdicts pair with their claim by milestone id, oldest verdict first", () => {
  const record = aggregateLaunchTrustSignals([
    receipt(
      "claim",
      { table: "claim", claim: "m1", evidenceHash: "ab".repeat(32) },
      { id: "c-m1", createdAt: 10 },
    ),
    receipt(
      "verdict",
      { table: "verdict", claim: "m2", verdict: "reject" },
      { id: "v-m2", createdAt: 20 },
    ),
    receipt(
      "verdict",
      { table: "verdict", claim: "m1", verdict: "approve" },
      { id: "v-m1a", createdAt: 30, author: VERIFIER_ONE },
    ),
    receipt(
      "claim",
      { table: "claim", claim: "m2", evidenceHash: "cd".repeat(32) },
      { id: "c-m2", createdAt: 40 },
    ),
    receipt(
      "verdict",
      { table: "verdict", claim: "m1", verdict: "approve" },
      { id: "v-m1b", createdAt: 50, author: VERIFIER_TWO },
    ),
  ]);

  assert.equal(record.timeline.length, 2, "two milestones, no cross-pairing");
  const m1 = record.timeline.find((e) => e.claimId === "m1");
  const m2 = record.timeline.find((e) => e.claimId === "m2");
  assert.ok(m1 && m2);
  assert.equal(m1.claim?.evidenceHash, "ab".repeat(32));
  assert.equal(m2.claim?.evidenceHash, "cd".repeat(32));
  assert.deepEqual(
    m1.verdicts.map((v) => v.eventId),
    ["v-m1a", "v-m1b"],
    "verdicts on m1 stay on m1, in timestamp order",
  );
  assert.deepEqual(
    m1.verdicts.map((v) => v.author),
    [VERIFIER_ONE, VERIFIER_TWO],
    "each verdict keeps its own author",
  );
  assert.deepEqual(
    m2.verdicts.map((v) => v.eventId),
    ["v-m2"],
  );
  assert.equal(record.counts.approved, 2);
  assert.equal(record.counts.rejected, 1);
  assert.equal(
    record.counts.settled,
    2,
    "both milestones are claim+verdict with good tx",
  );
});

test("a verdict whose claim was never mirrored still appears (never dropped)", () => {
  const record = aggregateLaunchTrustSignals([
    receipt(
      "verdict",
      { table: "verdict", claim: "orphan", verdict: "approve" },
      { id: "v-orphan" },
    ),
  ]);
  assert.equal(record.timeline.length, 1);
  assert.equal(record.timeline[0].claimId, "orphan");
  assert.equal(record.timeline[0].claim, null);
  assert.equal(record.timeline[0].settled, false, "no claim means not settled");
});

test("malformed mirrors are counted, not dropped", () => {
  const record = aggregateLaunchTrustSignals([
    // No claim id: unreadable as a verdict.
    receipt(
      "verdict",
      { table: "verdict", verdict: "approve" },
      { id: "bad-1" },
    ),
    // Outside the closed vocabulary: unreadable, never coerced.
    receipt(
      "verdict",
      { table: "verdict", claim: "m1", verdict: "maybe" },
      { id: "bad-2" },
    ),
    // Claim without its milestone id.
    receipt(
      "claim",
      { table: "claim", evidenceHash: "ab".repeat(32) },
      { id: "bad-3" },
    ),
    // Well-formed payload, malformed tx tag.
    receipt(
      "verdict",
      { table: "verdict", claim: "m1", verdict: "approve" },
      { id: "bad-4", tx: "not-a-tx" },
    ),
  ]);

  assert.equal(record.unreadable.verdicts, 2);
  assert.equal(record.unreadable.claims, 1);
  assert.equal(record.unreadable.total, 3);
  assert.equal(record.verdicts.length, 1, "only the readable verdict counts");
  assert.equal(record.counts.receiptsTotal, 4);
  assert.equal(record.counts.receiptsMalformed, 1, "one bad tx tag");
  assert.equal(record.counts.receiptsConfirmed, 3);
  assert.equal(
    record.counts.receiptsConfirmed + record.counts.receiptsMalformed,
    record.counts.receiptsTotal,
    "every mirror is accounted for on both axes",
  );
  assert.equal(trackRecordState(record), "recorded");
});

test("the derivation rows equal inputs recomputed from the raw mirrors", () => {
  const receipts = [
    receipt(
      "claim",
      { table: "claim", claim: "m1", evidenceHash: "ab".repeat(32) },
      { id: "r1", createdAt: 10 },
    ),
    receipt(
      "verdict",
      { table: "verdict", claim: "m1", verdict: "approve" },
      { id: "r2", createdAt: 20 },
    ),
    receipt(
      "verdict",
      { table: "verdict", claim: "m2", verdict: "reject" },
      { id: "r3", createdAt: 30 },
    ),
    receipt(
      "verdict",
      { table: "verdict", verdict: "approve" },
      { id: "r4", createdAt: 40 },
    ),
    receipt(
      "sweep",
      { table: "sweep", auction: "0x1" },
      { id: "r5", createdAt: 50 },
    ),
    receipt(
      "lock",
      { table: "lock", auction: "0x1" },
      { id: "r6", createdAt: 60 },
    ),
    receipt(
      "ragequit",
      { table: "ragequit" },
      { id: "r7", createdAt: 70, tx: "bad-tx" },
    ),
    receipt("graduate", { table: "graduate" }, { id: "r8", createdAt: 80 }),
    receipt("claim", { table: "claim" }, { id: "r9", createdAt: 90 }),
  ];
  const record = aggregateLaunchTrustSignals(receipts);
  const rows = trackRecordDerivation(record);
  const value = (key) => {
    const row = rows.find((r) => r.key === key);
    assert.ok(row, `derivation row ${key} exists`);
    return row.value;
  };

  // Independently recomputed from the fixture above.
  assert.equal(
    value("approved"),
    1,
    "readable verdicts with approve (r2; r4 has no claim id)",
  );
  assert.equal(value("rejected"), 1, "verdicts with reject (r3)");
  assert.equal(value("claims"), 1, "readable claims (r1)");
  assert.equal(value("settled"), 1, "only m1 has claim + verdict + good tx");
  assert.equal(
    value("receipts-confirmed"),
    8,
    "all but r7 carry a well-formed tx",
  );
  assert.equal(value("receipts-malformed"), 1, "r7");
  assert.equal(value("unreadable-verdicts"), 1, "r4 has no claim id");
  assert.equal(value("unreadable-claims"), 1, "r9 has no claim id");
  assert.equal(value("word-sweep"), 1);
  assert.equal(value("word-lock"), 1);
  assert.equal(value("word-ragequit"), 1);
  assert.equal(value("word-other"), 1, "graduate");

  // The breakdown the UI shows is this function's output — no UI-side math.
  assert.deepEqual(trackRecordDerivation(record), rows);
  // Partition identities: a row that stops matching its inputs fails here.
  assert.equal(value("approved") + value("rejected"), record.verdicts.length);
  assert.equal(
    value("receipts-confirmed") + value("receipts-malformed"),
    receipts.length,
  );
  assert.equal(
    value("word-sweep") +
      value("word-lock") +
      value("word-ragequit") +
      value("word-other") +
      value("claims") +
      value("approved") +
      value("rejected") +
      value("unreadable-verdicts") +
      value("unreadable-claims"),
    receipts.length,
    "every mirror lands in exactly one table/word bucket",
  );
  // Sources stay honest: milestone figures cite 47005 and their tag.
  for (const row of rows) {
    assert.match(
      row.source,
      /47005|counted, not dropped/,
      `${row.key} cites its source`,
    );
  }
  assert.match(
    rows.find((r) => r.key === "approved").source,
    /verdict=approve/,
  );
  assert.match(rows.find((r) => r.key === "rejected").source, /verdict=reject/);
});

test("no signals reads as no signals — never a zero-filled history", () => {
  const record = aggregateLaunchTrustSignals([]);
  assert.deepEqual(
    trackRecordDerivation(record).map((r) => r.value),
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  );
  assert.equal(trackRecordState(record), "empty");
  assert.equal(trackRecordState(emptyTrustRecord()), "empty");
  assert.equal(EMPTY_TRACK_RECORD_COPY, "No verdicts or receipts yet.");
  // Falsifiable both ways: one readable mirror flips the state.
  const withOne = aggregateLaunchTrustSignals([
    receipt("verdict", { table: "verdict", claim: "m1", verdict: "approve" }),
  ]);
  assert.equal(trackRecordState(withOne), "recorded");
});

test("canonical contribution records: newest wins, tie → lowest event id", () => {
  const older = event(
    37013,
    "id-b",
    { action: "ship the thing", reviewStatus: "pending" },
    [["d", "action-1"]],
    { created_at: 100 },
  );
  const newer = event(
    37013,
    "id-a",
    { action: "ship the thing", reviewStatus: "accepted" },
    [["d", "action-1"]],
    { created_at: 200, pubkey: VERIFIER_ONE },
  );
  const tieLoser = event(
    37013,
    "id-z",
    { action: "other", reviewStatus: "rejected" },
    [["d", "action-2"]],
    { created_at: 300 },
  );
  const tieWinner = event(
    37013,
    "id-y",
    { action: "other", reviewStatus: "accepted" },
    [["d", "action-2"]],
    { created_at: 300 },
  );

  const record = summarizeCommunityTrustSignals([
    older,
    newer,
    tieLoser,
    tieWinner,
  ]);
  assert.equal(
    record.contributions.length,
    2,
    "canonical only — never double-counted",
  );
  assert.equal(record.counts.superseded, 2);

  const action1 = record.contributions.find((c) => c.actionId === "action-1");
  assert.equal(action1?.reviewStatus, "accepted", "newest record wins");
  assert.equal(
    action1?.reviewedBy,
    VERIFIER_ONE,
    "a different key dispositioned it",
  );
  const action2 = record.contributions.find((c) => c.actionId === "action-2");
  assert.equal(
    action2?.eventId,
    "id-y",
    "created_at tie breaks to lowest event id",
  );

  assert.equal(
    record.counts.accepted +
      record.counts.rejected +
      record.counts.appealed +
      record.counts.pending +
      record.counts.unknown,
    record.contributions.length,
    "review-status counts partition the canonical records",
  );
});

test("incomplete contribution records are counted and stay visible", () => {
  const noStatus = event(
    37013,
    "e1",
    { action: "legacy" },
    [["d", "action-3"]],
    { created_at: 500 },
  );
  const badStatus = event(
    37013,
    "e2",
    { action: "weird", reviewStatus: "approved-ish" },
    [["d", "action-4"]],
    { created_at: 501 },
  );
  const noD = event(
    37013,
    "e3",
    { action: "floating", reviewStatus: "accepted" },
    [],
    { created_at: 502 },
  );
  const badContent = event(37013, "e4", "not json", [["d", "action-5"]], {
    created_at: 503,
  });

  const record = summarizeCommunityTrustSignals([
    noStatus,
    badStatus,
    noD,
    badContent,
  ]);
  assert.equal(record.contributions.length, 3, "three records still render");
  assert.equal(
    record.unreadable.contributions,
    4,
    "every incomplete read counted",
  );
  assert.equal(record.unreadable.total, 4);
  assert.equal(
    record.counts.unknown,
    2,
    "missing and out-of-vocabulary statuses",
  );
  assert.equal(record.counts.accepted, 1, "the no-d record keeps its status");
  const floating = record.contributions.find((c) => c.actionId === null);
  assert.ok(floating, "a record without an action id is not dropped");
  assert.equal(communityTrackState(record), "recorded");
});

test("approvals resolve a contribution only when the event names it", () => {
  const contribution = event(
    37013,
    "rec-1",
    { action: "ship", reviewStatus: "pending" },
    [["d", "action-1"]],
    { created_at: 100 },
  );
  const grant = event(KIND_APPROVAL_GRANT, "gr-1", "ok", [["e", "rec-1"]], {
    created_at: 200,
  });
  const record = summarizeCommunityTrustSignals([contribution, grant]);
  assert.equal(
    record.contributions[0].approval,
    "granted",
    "e tag names the record event",
  );
  assert.equal(record.counts.approvalsGranted, 1);
  assert.equal(record.counts.approvalsUnlinked, 0);

  // A `d` tag naming the action id resolves too — and a deny wins later.
  const deny = event(KIND_APPROVAL_DENY, "dn-1", "no", [["d", "action-1"]], {
    created_at: 300,
  });
  const orphan = event(
    KIND_APPROVAL_GRANT,
    "gr-2",
    "ok",
    [["e", "somewhere-else"]],
    { created_at: 400 },
  );
  const noTarget = event(KIND_APPROVAL_GRANT, "gr-3", "ok", [], {
    created_at: 500,
  });
  const second = summarizeCommunityTrustSignals([
    contribution,
    grant,
    deny,
    orphan,
    noTarget,
  ]);
  assert.equal(
    second.contributions[0].approval,
    "denied",
    "latest approval naming the record wins",
  );
  assert.equal(second.counts.approvalsGranted, 2);
  assert.equal(second.counts.approvalsDenied, 1);
  assert.equal(
    second.counts.approvalsUnlinked,
    1,
    "the orphan approval names no record we read",
  );
  assert.equal(
    second.counts.approvalsGranted + second.counts.approvalsDenied,
    3,
    "every readable approval is counted once",
  );
  assert.equal(
    second.unreadable.approvals,
    1,
    "the targetless one is counted, not dropped",
  );
});

test("the community breakdown equals its inputs and cites its kinds", () => {
  const events = [
    event(
      37013,
      "r1",
      { action: "a", reviewStatus: "accepted" },
      [["d", "d1"]],
      { created_at: 10 },
    ),
    event(
      37013,
      "r2",
      { action: "b", reviewStatus: "rejected" },
      [["d", "d2"]],
      { created_at: 20 },
    ),
    event(
      37013,
      "r3",
      { action: "c", reviewStatus: "pending" },
      [["d", "d3"]],
      { created_at: 30 },
    ),
    event(
      37013,
      "r4",
      { action: "d", reviewStatus: "accepted" },
      [["d", "d1"]],
      { created_at: 40, pubkey: VERIFIER_ONE },
    ),
    event(KIND_APPROVAL_GRANT, "g1", "ok", [["e", "r4"]], { created_at: 50 }),
    event(KIND_APPROVAL_DENY, "n1", "no", [["e", "unrelated"]], {
      created_at: 60,
    }),
    event(37013, "r5", "broken", [["d", "d5"]], { created_at: 70 }),
  ];
  const record = summarizeCommunityTrustSignals(events);
  const rows = communityDerivation(record);
  const value = (key) => rows.find((r) => r.key === key).value;

  assert.equal(
    value("contributions-accepted"),
    1,
    "d1 canonical is accepted (r4)",
  );
  assert.equal(value("contributions-rejected"), 1);
  assert.equal(value("contributions-pending"), 1);
  assert.equal(value("contributions-appealed"), 0);
  assert.equal(value("contributions-unknown"), 0, "r5's content never parsed");
  assert.equal(value("contributions-superseded"), 1, "r1 replaced by r4");
  assert.equal(value("approvals-granted"), 1);
  assert.equal(value("approvals-denied"), 1);
  assert.equal(value("approvals-unlinked"), 1, "n1 names no record we read");
  assert.equal(value("community-unreadable"), 1, "r5 counted");
  assert.match(
    rows.find((r) => r.key === "contributions-accepted").source,
    /37013/,
  );
  assert.match(rows.find((r) => r.key === "approvals-granted").source, /46030/);
  assert.match(rows.find((r) => r.key === "approvals-denied").source, /46031/);
  assert.deepEqual(
    communityDerivation(record),
    rows,
    "the UI renders exactly this",
  );
});

test("an empty community reads as no records yet", () => {
  const record = summarizeCommunityTrustSignals([]);
  assert.equal(communityTrackState(record), "empty");
  assert.equal(EMPTY_COMMUNITY_COPY, "No contribution records yet.");
  assert.deepEqual(
    communityDerivation(record).map((r) => r.value),
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    "the empty state derives zeros, not invented rows",
  );
  assert.equal(
    communityTrackState(
      summarizeCommunityTrustSignals([
        event(
          37013,
          "only",
          { action: "a", reviewStatus: "pending" },
          [["d", "d"]],
          { created_at: 1 },
        ),
      ]),
    ),
    "recorded",
  );
});
