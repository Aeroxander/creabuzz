/**
 * `check-runs.test.mjs` — the reviewer-side check-run record path, driven at
 * its production bounds: every record here is a REAL nostr event (id hash +
 * schnorr signature computed by nostr-tools), so what is tested is the actual
 * path the page reads — a forged, tampered or wrongly-scoped record never
 * reaches an attribution, and a wrong-context record is counted out, never
 * shown as the latest result.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  finalizeEvent,
  generateSecretKey,
  getEventHash,
  getPublicKey,
} from "nostr-tools/pure";

import {
  CHECK_RUN_ARGV_ENTRY_CAP,
  CHECK_RUN_MAX_CHECKS,
  CHECK_RUN_QUERY_LIMIT,
  CHECK_RUN_TEXT_CAP,
  checkRunContextTag,
  checkRunsFor,
  checkRunsQueryFilter,
  criterionOf,
  derivedCounts,
  parseVerifiedCheckRun,
  statusLabel,
} from "./check-runs.ts";
import { KIND_WORK_CHECK_RUN } from "../../../shared/constants/kinds.ts";

const CLAIM_ID = `0x${"a".repeat(64)}`;
const EVIDENCE = `0x${"b".repeat(64)}`;
const CHECK_HASH = `0x${"c".repeat(64)}`;
const MANDATE = `0x${"3".repeat(40)}`;
const OTHER_MANDATE = `0x${"4".repeat(40)}`;
const OTHER_EVIDENCE = `0x${"d".repeat(64)}`;

const caught = (parts = {}) => ({
  v: 1,
  type: "work-check-run",
  run: `0x${"1".repeat(64)}`,
  claim: { id: CLAIM_ID, mandate: MANDATE },
  evidenceHash: EVIDENCE,
  criteria: { claimCheck: { hash: CHECK_HASH, words: null } },
  checks: [
    {
      name: "tests",
      argv: ["/bin/true"],
      auxiliary: false,
      criterion: { source: "claim-check", hash: CHECK_HASH, words: null },
      status: "passed",
      exitStatus: 0,
      stdout: "ok",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      notRunReason: null,
    },
  ],
  summary: { passed: 1, failed: 0, timedOut: 0, notRun: 0, auxiliary: 0 },
  notIndependentVerification:
    "These are the contributor's own execution records, not independent verification.",
  limitations: ["Ran on the contributor's own machine."],
  model: null,
  sandboxEnforced: true,
  ...parts,
});

/** The event the page actually reads: kind 47010, signed by a real key. */
const signedCheckRun = (parts = {}, secret = generateSecretKey()) =>
  finalizeEvent(
    {
      kind: 47010,
      created_at: 1_728_000_000,
      tags: [
        ["a", `37001:${getPublicKey(secret).slice(0, 8)}…:launch`],
        ["claim", CLAIM_ID],
        ["evidence", EVIDENCE],
        ["mandate", MANDATE],
        ["sandbox", "enforced"],
      ],
      content: JSON.stringify(caught(parts)),
    },
    secret,
  );

const signedByOther = (parts, mandate, evidence) => {
  const second = generateSecretKey();
  return finalizeEvent(
    {
      kind: 47010,
      created_at: 1_728_000_200,
      tags: [
        ["claim", parts?.claim?.id ?? CLAIM_ID],
        ["evidence", evidence ?? EVIDENCE],
        ["mandate", mandate ?? MANDATE],
        ["sandbox", "unchecked"],
      ],
      content: JSON.stringify(caught(parts)),
    },
    second,
  );
};

const claim = {
  id: CLAIM_ID,
  mandate: MANDATE,
  record: { evidenceHash: EVIDENCE, checkHash: CHECK_HASH },
};

test("a signed record parses; attribution is the signer, and the sandbox stays their claim", () => {
  const secret = generateSecretKey();
  const event = signedCheckRun({}, secret);
  const record = parseVerifiedCheckRun(event);
  assert.ok(record, "a signed well-formed record parses");
  assert.equal(
    record.author,
    getPublicKey(secret),
    "attribution is the signer",
  );
  assert.equal(record.mandate, MANDATE);
  assert.equal(record.evidenceHash, EVIDENCE);
  assert.equal(record.sandboxClaim, "enforced");
  assert.equal(
    record.sandboxEnforced,
    true,
    "this is the publisher's report, not an attestation of anything",
  );
  assert.deepEqual(record.selfContradictions, []);
  assert.equal(record.summaryConsistent, true);
});

test("a tampered record is refused before it can attribute anything", () => {
  // The signed bytes, then someone edits the content, keeping id and sig.
  const untouched = signedCheckRun();
  const tampered = {
    ...untouched,
    content: JSON.stringify(caught({ run: `0x${"2".repeat(64)}` })),
  };
  assert.equal(
    parseVerifiedCheckRun(tampered),
    null,
    "a changed content under repaired id is refused whole: the id is the signed one",
  );
  // Recompute the id honestly so the id-hash check passes — the signature
  // still belongs to the old bytes, and the signature is the attribution.
  const reserialized = { ...untouched };
  reserialized.content = JSON.stringify(caught({ run: `0x${"f".repeat(64)}` }));
  reserialized.id = getEventHash(reserialized);
  assert.equal(
    parseVerifiedCheckRun(reserialized),
    null,
    "a new id with the old signature is refused: the signature proves the publisher or nothing",
  );
  // A signature that belongs to nobody: shape-correct, digitally empty.
  const zeroSig = { ...signedCheckRun(), sig: "0".repeat(128) };
  assert.equal(parseVerifiedCheckRun(zeroSig), null);
  // Not our kind at all is likewise nothing to parse.
  assert.equal(
    parseVerifiedCheckRun({ ...signedCheckRun(), kind: 47003 }),
    null,
  );
});

test("a record for this claim id under another mandate is misattributed, never current", () => {
  const mine = parseVerifiedCheckRun(signedCheckRun());
  const foreign = parseVerifiedCheckRun(
    signedByOther(
      {
        claim: { id: CLAIM_ID, mandate: OTHER_MANDATE },
        sandboxEnforced: false,
      },
      OTHER_MANDATE,
      EVIDENCE,
    ),
  );
  assert.ok(mine && foreign);
  assert.equal(foreign.mandate, OTHER_MANDATE);
  assert.deepEqual(foreign.selfContradictions, []);
  const got = checkRunsFor(claim, [mine, foreign]);
  assert.deepEqual(got.current, [mine]);
  assert.equal(
    got.misattributed,
    1,
    "one record carries the claim id under another mandate — matched by id alone would be a guess",
  );
  assert.equal(got.stale, 0);
});

test("matching claim and mandate but other evidence is stale, counted not shown", () => {
  const mine = parseVerifiedCheckRun(signedCheckRun());
  const otherEvidence = parseVerifiedCheckRun(
    signedCheckRun({ evidenceHash: OTHER_EVIDENCE }),
  );
  const event = signedCheckRun({ evidenceHash: OTHER_EVIDENCE });
  assert.ok(otherEvidence);
  // The same publisher's later run against other evidence binds nothing for
  // this submission.
  const againstOther = parseVerifiedCheckRun(event);
  assert.ok(mine && againstOther);
  const got = checkRunsFor(claim, [mine, againstOther]);
  assert.deepEqual(got.current, [mine]);
  assert.equal(got.stale, 1);
  assert.equal(got.misattributed, 0);
});

test("the claimed summary is checked against the checks, never trusted", () => {
  const record = parseVerifiedCheckRun(
    signedCheckRun({
      summary: { passed: 9, failed: 0, timedOut: 0, notRun: 0, auxiliary: 0 },
    }),
  );
  assert.ok(record);
  assert.equal(
    record.summaryConsistent,
    false,
    "claimed counts over what one check adds up to are not a fact",
  );
  const counts = derivedCounts(record.checks);
  assert.equal(counts.passed, 1);
  assert.equal(counts.contradicted, 0);
});

test("a claim of passed beside a nonzero exit is said loudly and taken out of the pass count", () => {
  const record = parseVerifiedCheckRun(
    signedCheckRun({
      checks: [
        {
          name: "tests",
          argv: ["/bin/true"],
          auxiliary: false,
          criterion: { source: "claim-check", hash: CHECK_HASH, words: null },
          status: "passed",
          exitStatus: 3,
          stdout: "",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          notRunReason: null,
        },
      ],
      summary: { passed: 1, failed: 0, timedOut: 0, notRun: 0, auxiliary: 0 },
    }),
  );
  assert.ok(record);
  assert.equal(record.summaryConsistent, false);
  const counts = derivedCounts(record.checks);
  assert.equal(
    counts.passed,
    0,
    "a passed claim with a nonzero exit is not a pass under any reading",
  );
  assert.equal(counts.contradicted, 1);
  assert.equal(record.checks[0].selfContradicted, true);
});

test("criteria mapped to words the claim does not commit to are extra, and unknown criteria too", () => {
  const otherWords = parseVerifiedCheckRun(
    signedCheckRun({
      checks: [
        {
          name: "style",
          argv: ["/bin/true"],
          auxiliary: true,
          criterion: {
            source: "claim-check",
            hash: `0x${"e".repeat(64)}`,
            words: null,
          },
          status: "passed",
          exitStatus: 0,
          stdout: "",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          notRunReason: null,
        },
        {
          name: "lint",
          argv: ["/bin/true"],
          auxiliary: true,
          criterion: null,
          status: "passed",
          exitStatus: 0,
          stdout: "",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          notRunReason: null,
        },
      ],
      summary: { passed: 2, failed: 0, timedOut: 0, notRun: 0, auxiliary: 2 },
    }),
  );
  assert.ok(otherWords);
  const [style, lint] = otherWords.checks;
  assert.equal(
    criterionOf(style, claim),
    "other",
    "a hash the claim does not commit to is not mapping to its answer",
  );
  assert.equal(
    criterionOf(lint, claim),
    "none",
    "declared with no criterion stays extra",
  );
  assert.equal(derivedCounts(otherWords.checks).auxiliary, 2);
});

test("binding tags: a mismatch between a record's tags and its own text is named, not hidden", () => {
  const secret = generateSecretKey();
  const event = finalizeEvent(
    {
      kind: 47010,
      created_at: 1_728_001_000,
      tags: [
        ["claim", `0x${"f".repeat(64)}`], // not the claim the content names
        ["evidence", EVIDENCE],
        ["mandate", MANDATE],
      ],
      content: JSON.stringify(caught()),
    },
    secret,
  );
  const record = parseVerifiedCheckRun(event);
  assert.ok(record);
  assert.equal(
    record.selfContradictions.some((line) => line.includes("claim id tag")),
    true,
  );
  // The content (what the publisher signed twice-set) stays what it binds to.
  assert.equal(record.claimId, CLAIM_ID);
  assert.equal(record.mandate, MANDATE);
});

test("no sandbox tag means the record claims nothing certain, visibly", () => {
  const secret = generateSecretKey();
  const event = finalizeEvent(
    {
      kind: 47010,
      created_at: 1_728_002_000,
      tags: [
        ["claim", CLAIM_ID],
        ["evidence", EVIDENCE],
        ["mandate", MANDATE],
      ],
      content: JSON.stringify(caught({ sandboxEnforced: true })),
    },
    secret,
  );
  const record = parseVerifiedCheckRun(event);
  assert.ok(record);
  assert.equal(record.sandboxClaim, null);
  assert.equal(
    record.selfContradictions.some((line) => line.includes("sandbox tag")),
    true,
    "a record asserting enforcement cannot be silent about that in what it ignores",
  );
});

test("oversized content is cut with a marker, bounded caps hold, malformed is refused whole", () => {
  const longArg = "x".repeat(CHECK_RUN_ARGV_ENTRY_CAP + 100);
  const hugeStdout = "y".repeat(CHECK_RUN_TEXT_CAP + 1000);
  const record = parseVerifiedCheckRun(
    signedCheckRun({
      checks: [
        {
          name: "tests",
          argv: [longArg],
          auxiliary: false,
          criterion: { source: "claim-check", hash: CHECK_HASH, words: null },
          status: "passed",
          exitStatus: 0,
          stdout: hugeStdout,
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          notRunReason: null,
        },
      ],
    }),
  );
  assert.ok(record);
  assert.equal(
    record.checks[0].stdout.length <= CHECK_RUN_TEXT_CAP + 32,
    true,
    "a huge excerpt is held to the page's bound, visibly cut",
  );
  assert.equal(record.checks[0].stdoutTruncated, true);
  assert.ok(record.checks[0].argv[0].includes("…"));
  // Too many checks: refused whole.
  const tooMany = new Array(CHECK_RUN_MAX_CHECKS + 1).fill({
    name: "x",
    argv: [],
    auxiliary: true,
    criterion: null,
    status: "passed",
    exitStatus: 0,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    notRunReason: null,
  });
  assert.equal(
    parseVerifiedCheckRun(
      finalizeEvent(
        {
          kind: 47010,
          created_at: 1_728_003_000,
          tags: [
            ["claim", CLAIM_ID],
            ["evidence", EVIDENCE],
            ["mandate", MANDATE],
          ],
          content: JSON.stringify(caught({ checks: tooMany })),
        },
        generateSecretKey(),
      ),
    ),
    null,
  );
});

test("statuses have plain words; aux rows say what is missing", () => {
  assert.equal(statusLabel("passed"), "Passed");
  assert.equal(statusLabel("timed-out").includes("unknown"), true);
  assert.equal(statusLabel("??"), "Unknown");
});

test("the read asks the server for exactly one canonical binding value, kind 47010, before any limit", () => {
  // The golden triplet: mandate, then claim id, then evidence hash — each
  // lower-cased, `0x` prefixes kept, joined by `:`.
  const golden = checkRunContextTag({
    claimId: CLAIM_ID,
    mandate: MANDATE,
    evidenceHash: EVIDENCE,
  });
  assert.equal(
    golden,
    `0x${"3".repeat(40)}:0x${"a".repeat(64)}:0x${"b".repeat(64)}`,
  );
  const mixed = checkRunContextTag({
    claimId: `0x${"A".repeat(64)}`,
    mandate: MANDATE.toUpperCase(),
    evidenceHash: `0x${"B".repeat(64)}`,
  });
  assert.equal(
    mixed,
    `0x${"3".repeat(40)}:0x${"a".repeat(64)}:0x${"b".repeat(64)}`,
    "the binding is canonical regardless of the case it arrived in",
  );

  const filter = checkRunsQueryFilter({
    claimId: CLAIM_ID,
    mandate: MANDATE,
    evidenceHash: EVIDENCE,
  });
  // The exact accepted field names: only ONE binding tag (a serde reader
  // drops multi-letter names anyway), and only the record kind before the
  // limit, so the narrow push can serve exactly this shelf.
  assert.deepEqual(Object.keys(filter).sort(), ["#c", "kinds", "limit"]);
  assert.deepEqual(filter.kinds, [KIND_WORK_CHECK_RUN]);
  assert.equal(filter.limit, CHECK_RUN_QUERY_LIMIT);
  assert.deepEqual(filter["#c"], [golden]);
  for (const absent of ["#m", "#x", "#claim", "#mandate", "#evidence"]) {
    assert.equal(absent in filter, false, `${absent} must not be in the read`);
  }
  // The scope inputs are what the read is about: another claim's inputs make
  // another binding value, so one claim's bounded read cannot answer for
  // another's.
  const other = checkRunsQueryFilter({
    claimId: `0x${"f".repeat(64)}`,
    mandate: OTHER_MANDATE,
    evidenceHash: EVIDENCE,
  });
  assert.deepEqual(other["#c"], [
    `${OTHER_MANDATE}:0x${"f".repeat(64)}:${EVIDENCE}`,
  ]);
});
