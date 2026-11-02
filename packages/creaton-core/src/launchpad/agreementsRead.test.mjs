import assert from "node:assert/strict";
import test from "node:test";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import {
  encodeReadAgreement,
  encodeReadSplits,
  encodeReadAgreementsVersion,
  encodeReadSharesReserved,
  splitHashOf,
} from "./agreements.ts";
import {
  AGREEMENTS_DISCOVERY_LIMIT,
  MAX_AGREEMENT_IDS,
  TOPIC_AGREEMENT_PROPOSED,
  decodeAgreementProposed,
  discoverAgreementOffers,
  readAgreementsSnapshot,
  readAgreementsVersion,
  readAgreementRows,
  readSharesReserved,
  resolveAgreementsCapability,
} from "./agreementsRead.ts";

const MANDATE = "0x" + "55".repeat(20);
const PROJECT = "0x" + "1".repeat(64);
const SLOT = "0x" + "ab".repeat(32);
const AGREEMENT_ID = (() => {
  const hex = PROJECT.replace(/^0x/, "") + SLOT.replace(/^0x/, "");
  return `0x${bytesToHex(keccak_256(Uint8Array.from(hex.match(/../g).map((b) => Number.parseInt(b, 16)))))}`;
})();
const ID_2 = "0x" + "d".repeat(64);
const BENEFICIARY = "0x1111111111111111111111111111111111111111";
const COAUTHOR = "0x3333333333333333333333333333333333333333";
const CLAIM = "0x" + "cc".repeat(32);
const mh = (h, n) => h.replace(/^0x/, "").padStart(n, "0");
const word = (n) => n.toString(16).padStart(64, "0");

/** A real `agreements(bytes32)` answer for one agreed row. */
const agreedRowHex = ({
  projectId = PROJECT,
  beneficiary = BENEFICIARY,
  shares = 101n,
  criteriaHash = "0x" + "55".repeat(32),
  policyRef = "0x" + "66".repeat(32),
  acceptedAt = 500,
  reviewPeriod = 604800,
  workDeadline = 1600,
  revisionDeadline = 3000000,
  claimId = CLAIM,
  terminalKind = 0,
  attempts = 1,
  splitHash = "0x" + "88".repeat(32),
}) =>
  "0x" +
  [
    mh(projectId, 64),
    mh(beneficiary, 64),
    BigInt(shares).toString(16).padStart(64, "0"),
    mh(criteriaHash, 64),
    mh(policyRef, 64),
    BigInt(acceptedAt).toString(16).padStart(64, "0"),
    BigInt(reviewPeriod).toString(16).padStart(64, "0"),
    BigInt(workDeadline).toString(16).padStart(64, "0"),
    BigInt(revisionDeadline).toString(16).padStart(64, "0"),
    mh(claimId, 64),
    BigInt(terminalKind).toString(16).padStart(64, "0"),
    BigInt(attempts).toString(16).padStart(64, "0"),
    mh(splitHash, 64),
  ].join("");

const splitRowHex = (count, parties, percentages) =>
  "0x" +
  [
    parties[0] ? BigInt(parties[0]).toString(16).padStart(64, "0") : word(0n),
    parties[1] ? BigInt(parties[1]).toString(16).padStart(64, "0") : word(0n),
    word(0n),
    word(0n),
    BigInt(percentages[0] ?? 0)
      .toString(16)
      .padStart(64, "0"),
    BigInt(percentages[1] ?? 0)
      .toString(16)
      .padStart(64, "0"),
    word(0n),
    word(0n),
    word(BigInt(count)),
  ].join("");

/** The chain seam with an exact call ledger, so tests bind the production seam. */
const chain = (
  mapping,
  { logs: logAnswer, now: answerNow = 1000, codeHash: codeHashAnswer } = {},
) => {
  const ledger = [];
  return {
    ledger,
    async call(to, data) {
      ledger.push({ to, data });
      const rule = mapping[`${to.toLowerCase()} ${data}`];
      if (!rule) throw new Error(`unexpected read: ${to} ${data.slice(0, 10)}`);
      if (rule instanceof Error) throw rule;
      if (rule?.revert)
        throw new Error("revert: the mandate does not have this function");
      return rule.hex ?? rule;
    },
    async now() {
      return answerNow;
    },
    async logs(_filter) {
      ledger.push({ logRead: true });
      return logAnswer ? logAnswer(_filter) : [];
    },
    ...(codeHashAnswer
      ? {
          codeHash:
            typeof codeHashAnswer === "function"
              ? codeHashAnswer
              : async () => codeHashAnswer,
        }
      : {}),
  };
};

const CODE_HASH = "0x" + "ef".repeat(32);
const LEGACY_MANIFEST = { codeHashes: ["0x" + "cd".repeat(32)] };
/** The split the seamless fixtures declare, as the proposal would have hashed it. */
const DECLARED_SPLIT = splitHashOf([BENEFICIARY, COAUTHOR], [3300, 6700]);

// ── capability classification: the getter never says legacy ─────────────────

test("a version that the manifest names stands as supported", () => {
  assert.equal(
    resolveAgreementsCapability({
      version: { value: 1n },
      codeHash: CODE_HASH,
      legacyManifest: LEGACY_MANIFEST,
    }),
    "supported",
  );
  const noManifest = resolveAgreementsCapability({
    version: { value: 1n },
    codeHash: CODE_HASH,
  });
  assert.equal(noManifest, "supported");
});

test("a different version is unsupported — the explicit manifest alone may soften it to known-legacy", () => {
  const plain = resolveAgreementsCapability({
    version: { value: 2n },
    codeHash: null,
    legacyManifest: LEGACY_MANIFEST,
  });
  assert.equal(plain, "unsupported");
  const matched = resolveAgreementsCapability({
    version: { value: 2n },
    codeHash: "0x" + "cd".repeat(32),
    legacyManifest: LEGACY_MANIFEST,
  });
  assert.equal(matched, "known-legacy");
});

test("a failed version read is unreadable, never legacy — unless the manifest explicitly names the code", () => {
  assert.equal(
    resolveAgreementsCapability({
      version: { error: new Error("revert") },
      codeHash: null,
    }),
    "unreadable",
  );
  assert.equal(
    resolveAgreementsCapability({
      version: { error: new Error("revert") },
      codeHash: null,
      legacyManifest: LEGACY_MANIFEST,
    }),
    "unreadable",
  );
  const pinned = resolveAgreementsCapability({
    version: { error: new Error("revert") },
    codeHash: "0x" + "cd".repeat(32),
    legacyManifest: LEGACY_MANIFEST,
  });
  assert.equal(pinned, "known-legacy");
});

test("the marker read is its own call; a malformed, short, or trailing-byte answer refuses", async () => {
  const chainOk = chain({
    [`${MANDATE.toLowerCase()} ${encodeReadAgreementsVersion()}`]: {
      hex: "0x" + word(1n),
    },
  });
  const had = await readAgreementsVersion(chainOk, MANDATE);
  assert.deepEqual(had, { value: 1n });
  const bad = chain({
    [`${MANDATE.toLowerCase()} ${encodeReadAgreementsVersion()}`]: "0x1234",
  });
  const got = await readAgreementsVersion(bad, MANDATE);
  assert.ok(got.error instanceof Error);
  assert.match(got.error.message, /32-byte/);
  // Trailing bytes would ambiguate the word: refused, never sliced off.
  const trailing = chain({
    [`${MANDATE.toLowerCase()} ${encodeReadAgreementsVersion()}`]: {
      hex: "0x" + word(1n) + "ff",
    },
  });
  const sliced = await readAgreementsVersion(trailing, MANDATE);
  assert.ok(sliced.error instanceof Error);
  assert.match(sliced.error.message, /32-byte/);
});

// ── rows: supplied ids read off the chain, each by its own call ──────────────

const RULES = (extra = {}) => ({
  [`${MANDATE.toLowerCase()} ${encodeReadAgreement(AGREEMENT_ID)}`]: {
    hex: agreedRowHex({ splitHash: DECLARED_SPLIT }),
  },
  [`${MANDATE.toLowerCase()} ${encodeReadAgreement(ID_2)}`]: {
    hex: agreedRowHex({ splitHash: DECLARED_SPLIT }),
  },
  [`${MANDATE.toLowerCase()} ${encodeReadAgreementsVersion()}`]: {
    hex: "0x" + word(1n),
  },
  [`${MANDATE.toLowerCase()} ${encodeReadSplits(AGREEMENT_ID)}`]: {
    hex: splitRowHex(2, [BENEFICIARY, COAUTHOR], [3300, 6700]),
  },
  [`${MANDATE.toLowerCase()} ${encodeReadSharesReserved(PROJECT)}`]: {
    hex: "0x" + word(101n),
  },
  ...extra,
});

test("the rows go to their own exact call for every supplied id", async () => {
  const calls = RULES();
  const c = chain({
    ...calls,
    [`${MANDATE.toLowerCase()} ${encodeReadAgreement(ID_2)}`]: {
      revert: true,
    },
  });
  const { rows, truncated } = await readAgreementRows(c, MANDATE, [
    AGREEMENT_ID,
    ID_2,
  ]);
  assert.equal(truncated, false);
  // Two supplied ids: two exact calls, each for its own id (the split read follows).
  assert.deepEqual(
    c.ledger.slice(0, 2).map((l) => l.data),
    [encodeReadAgreement(AGREEMENT_ID), encodeReadAgreement(ID_2)],
  );
  assert.equal(rows[0].kind, "present");
  assert.equal(rows[0].terms.shares, 101n);
  assert.equal(rows[0].terms.claimId, CLAIM);
  assert.deepEqual(rows[0].split, {
    kind: "declared",
    parties: [BENEFICIARY, COAUTHOR],
    percentages: [3300, 6700],
  });
  assert.equal(
    rows[1].kind,
    "unreadable",
    "a revert is unreadable, never an absence",
  );
  assert.match(rows[1].reason, /revert/);
});

test("a no-split record does not read the split getter; an absent id is absent", async () => {
  const noSplitId = "0x" + "9".repeat(64);
  const c = chain({
    [`${MANDATE.toLowerCase()} ${encodeReadAgreement(AGREEMENT_ID)}`]: {
      hex: agreedRowHex({ splitHash: "0x" + "0".repeat(64) }),
    },
  });
  const { rows } = await readAgreementRows(c, MANDATE, [AGREEMENT_ID]);
  assert.equal(rows[0].split.kind, "none");
  assert.equal(
    c.ledger.filter((l) => l.data === encodeReadSplits(AGREEMENT_ID)).length,
    0,
  );
  const absentChain = chain({
    [`${MANDATE.toLowerCase()} ${encodeReadAgreement(noSplitId)}`]: {
      hex: "0x" + word(0n).repeat(13),
    },
  });
  const out = await readAgreementRows(absentChain, MANDATE, [noSplitId]);
  assert.deepEqual(out.rows, [{ id: noSplitId, kind: "absent" }]);
});

test("a record that answers outside this version's words is unreadable — never empty, never legacy", async () => {
  const hostile = chain({
    [`${MANDATE.toLowerCase()} ${encodeReadAgreement(AGREEMENT_ID)}`]:
      "0x" + word(0n).repeat(10), // wrong-shape answer (10 words)
  });
  const { rows } = await readAgreementRows(hostile, MANDATE, [AGREEMENT_ID]);
  assert.equal(rows[0].kind, "unreadable");
  assert.match(rows[0].reason, /13 words|tuple/);
  const crazyKind = chain({
    [`${MANDATE.toLowerCase()} ${encodeReadAgreement(AGREEMENT_ID)}`]: {
      hex: agreedRowHex({ terminalKind: 7 }),
    },
  });
  const out = await readAgreementRows(crazyKind, MANDATE, [AGREEMENT_ID]);
  assert.equal(out.rows[0].kind, "unreadable");
  assert.match(out.rows[0].reason, /outside this version/);
});

test("a split that does not reproduce the record's own commitment is recorded, not smothered", async () => {
  const wrong = chain({
    ...RULES(),
    [`${MANDATE.toLowerCase()} ${encodeReadSplits(AGREEMENT_ID)}`]: {
      hex: splitRowHex(2, [BENEFICIARY, COAUTHOR], [5000, 5000]),
    },
  });
  const { rows } = await readAgreementRows(wrong, MANDATE, [AGREEMENT_ID]);
  assert.equal(rows[0].split.kind, "unreadable");
  assert.match(rows[0].split.reason, /commitment/);
});

test("supplied ids past the bound are reported as truncation, never dropped silently", async () => {
  assert.equal(MAX_AGREEMENT_IDS, 32);
  const ids = Array.from(
    { length: MAX_AGREEMENT_IDS + 3 },
    (_, i) => `0x${String(i).padStart(64, "0")}`,
  );
  const empty = () => "0x" + word(0n).repeat(13);
  const rules = {};
  for (const id of ids.slice(0, MAX_AGREEMENT_IDS)) {
    rules[`${MANDATE.toLowerCase()} ${encodeReadAgreement(id)}`] = {
      hex: empty(),
    };
  }
  const c = chain(rules);
  const { rows, truncated } = await readAgreementRows(c, MANDATE, ids);
  assert.equal(truncated, true);
  assert.equal(rows.length, MAX_AGREEMENT_IDS);
});

// ── bounded discovery from the mandate's own offer logs ─────────────────────

const offerLog = (
  agreementId,
  {
    projectId = PROJECT,
    beneficiary = BENEFICIARY,
    shares = 101n,
    workDeadline = 1600,
    revisionDeadline = 3000000,
    reviewPeriod = 604800,
    criteriaHash = "0x" + "55".repeat(32),
    policyRef = "0x" + "66".repeat(32),
    splitHash = "0x" + "88".repeat(32),
  } = {},
) => ({
  address: MANDATE,
  topics: [
    TOPIC_AGREEMENT_PROPOSED,
    agreementId,
    projectId,
    "0x000000000000000000000000" + beneficiary.slice(2),
  ],
  data:
    "0x" +
    BigInt(shares).toString(16).padStart(64, "0") +
    BigInt(workDeadline).toString(16).padStart(64, "0") +
    BigInt(revisionDeadline).toString(16).padStart(64, "0") +
    BigInt(reviewPeriod).toString(16).padStart(64, "0") +
    mh(criteriaHash, 64) +
    mh(policyRef, 64) +
    mh(splitHash, 64),
});

test("offers come from the mandate's own logs, from the explicit start block, bounded", async () => {
  const logs = [offerLog(AGREEMENT_ID), offerLog(ID_2)];
  const c = chain(
    {},
    {
      logs: async (filter) => {
        assert.equal(filter.address, MANDATE);
        assert.deepEqual(filter.topics, [TOPIC_AGREEMENT_PROPOSED]);
        assert.equal(filter.fromBlock, 5_000);
        return logs;
      },
    },
  );
  const { offers, truncated } = await discoverAgreementOffers(
    c,
    MANDATE,
    5_000,
  );
  assert.equal(truncated, false);
  assert.deepEqual(
    offers.map((o) => o.agreementId),
    [AGREEMENT_ID, ID_2],
  );
  assert.equal(offers[0].shares, 101n);
  assert.equal(offers[0].beneficiary, BENEFICIARY);
  assert.equal(offers[0].workDeadline, 1600);
  assert.equal(offers[0].splitHash, "0x" + "88".repeat(32));
});

test("an omitted start block is refused; too many logs mark truncation; malformed logs count", async () => {
  const c = chain({}, { logs: async () => [] });
  await assert.rejects(
    () => discoverAgreementOffers(c, MANDATE, undefined),
    /explicit start block/,
  );
  const many = Array.from({ length: AGREEMENTS_DISCOVERY_LIMIT + 1 }, (_, i) =>
    offerLog(`0x${String(i).padStart(64, "0")}`),
  );
  const full = chain({}, { logs: async () => many });
  const caught = await discoverAgreementOffers(full, MANDATE, 1);
  assert.equal(caught.truncated, true);
  assert.equal(caught.offers.length, AGREEMENTS_DISCOVERY_LIMIT);
  // A log in the page that cannot decode is not skipped: it is truncation, said out loud.
  const murky = chain(
    {},
    {
      logs: async () => [
        offerLog(AGREEMENT_ID),
        { address: MANDATE, topics: [TOPIC_AGREEMENT_PROPOSED], data: "0x" },
      ],
    },
  );
  const mixed = await discoverAgreementOffers(murky, MANDATE, 1);
  assert.equal(
    mixed.truncated,
    true,
    "an unreadable log still counts, never a silent false empty",
  );
  assert.equal(mixed.offers.length, 1);
});

test("decodeAgreementProposed keeps the event's own words, and refuses another event's", () => {
  const o = decodeAgreementProposed(offerLog(AGREEMENT_ID));
  assert.equal(o.agreementId, AGREEMENT_ID);
  assert.equal(o.policyRef, "0x" + "66".repeat(32));
  assert.equal(decodeAgreementProposed({ topics: ["0xdead"] }), null);
  assert.equal(
    decodeAgreementProposed({
      topics: [
        TOPIC_AGREEMENT_PROPOSED,
        AGREEMENT_ID,
        PROJECT,
        "0x000000000000000000000000" + BENEFICIARY.slice(2),
      ],
      data: "0x" + word(0n),
    }),
    null,
  );
});

// ── snapshot: capability, clock and rows in one bounded read ─────────────────

test("the snapshot reads the version marker once, then the rows it was handed", async () => {
  const c = chain(RULES());
  const snap = await readAgreementsSnapshot({
    chain: c,
    mandate: MANDATE,
    ids: [ID_2],
  });
  assert.equal(snap.capability, "supported");
  assert.equal(snap.chainTime, 1000);
  assert.equal(snap.rows[0].kind, "present");
  assert.equal(snap.versionUnreadable, false);
  assert.equal(snap.truncatedIds, false);
  // The version read is exactly one call, and it goes to the mandate.
  assert.equal(
    c.ledger.filter((l) => l.data === encodeReadAgreementsVersion()).length,
    1,
  );
});

test("a failed version read leaves rows readable and the snapshot says the marker is unreadable", async () => {
  const c = chain(
    {
      [`${MANDATE.toLowerCase()} ${encodeReadAgreementsVersion()}`]: {
        revert: true,
      },
      [`${MANDATE.toLowerCase()} ${encodeReadAgreement(AGREEMENT_ID)}`]: {
        hex: agreedRowHex({}),
      },
    },
    { codeHash: async () => null },
  );
  const snap = await readAgreementsSnapshot({
    chain: c,
    mandate: MANDATE,
    ids: [AGREEMENT_ID],
  });
  // Do not force a null codeHash: an unset seam is no classification either way.
  assert.equal(snap.capability, "unreadable");
  assert.equal(snap.versionUnreadable, true);
  assert.equal(
    snap.rows[0].kind,
    "present",
    "a legacy-or-not verdict must not hide a real row",
  );
});

// ── reservation counters: figures, never promises ───────────────────────────

test("reservation reads are plain words; a failed read throws instead of promising zero", async () => {
  const c = chain(RULES());
  assert.equal(await readSharesReserved(c, MANDATE, PROJECT), 101n);
  const bad = chain({
    [`${MANDATE.toLowerCase()} ${encodeReadSharesReserved(PROJECT)}`]: "0x1234",
  });
  await assert.rejects(() => readSharesReserved(bad, MANDATE, PROJECT), /word/);
});
