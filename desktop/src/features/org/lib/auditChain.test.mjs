// auditChain — parity with `crates/buzz-audit`, pinned by the crate's OWN
// vectors, plus a source-binding guard that reds if the Rust construction
// changes underneath this port.
//
// Vector derivation: each expected digest below was produced by running the
// crate's own `buzz_audit::hash::compute_hash` over the fixture (the harness
// also re-derived the preimage from its printed `canonical_json` string and
// asserted equality, so the printed string IS the crate's preimage). To
// regenerate, build a scratch crate that path-depends on `buzz-audit`, call
// `compute_hash` on the fixtures named `v1`…`v8` here, and replace the digests
// — any change to the crate's field order, timestamp handling, or JSON
// rendering changes them and reds this suite.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import {
  AuditChainInputError,
  CHAIN_PREIMAGE_ORDER,
  GENESIS_HEX,
  RustNumber,
  auditActionLabel,
  badgeForEvent,
  canonicalJson,
  computeChainHash,
  deriveChainBadges,
  parseChainEntry,
  parseChainEntryBatch,
  parseJson,
  storagePrecisionRfc3339,
  verifyChain,
} from "./auditChain.ts";

const C1 = "00000000-0000-0000-0000-000000000001";
const C2 = "00000000-0000-0000-0000-000000000002";
const AB = "ab".repeat(32);
const CD = "cd".repeat(32);

function entry(overrides) {
  return {
    communityId: C1,
    seq: 1,
    prevHash: null,
    action: "event_created",
    actorPubkey: null,
    objectId: null,
    detail: parseJson("null"),
    createdAt: "2026-01-01T00:00:00Z",
    hash: "",
    hashVersion: 1,
    ...overrides,
  };
}

// ── Rust source binding ─────────────────────────────────────────────────────

function rustFile(relativePath) {
  return readFileSync(
    new URL(`../../../../../${relativePath}`, import.meta.url),
    "utf8",
  );
}

function extractUpdateArgs(functionSource) {
  const stripped = functionSource
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join(" ")
    .replace(/\s+/g, " ");
  const marker = "hasher.update(";
  const args = [];
  let cursor = 0;
  for (;;) {
    const at = stripped.indexOf(marker, cursor);
    if (at === -1) break;
    let depth = 0;
    let arg = "";
    let i = at + marker.length;
    for (; i < stripped.length; i += 1) {
      const ch = stripped[i];
      if (ch === "(") {
        depth += 1;
        arg += ch;
      } else if (ch === ")") {
        if (depth === 0) break;
        depth -= 1;
        arg += ch;
      } else {
        arg += ch;
      }
    }
    args.push(arg.replace(/\s+/g, "").replace(/,+$/, ""));
    cursor = i;
  }
  return args;
}

describe("Rust source binding (crates/buzz-audit)", () => {
  const hashRs = rustFile("crates/buzz-audit/src/hash.rs");

  it("computes hashes in exactly the field order this port implements", () => {
    const start = hashRs.indexOf("pub fn compute_hash");
    const end = hashRs.indexOf("Ok(hasher.finalize().into())", start);
    assert.ok(start !== -1 && end !== -1, "could not locate compute_hash");
    const args = extractUpdateArgs(hashRs.slice(start, end));

    const direct = new Map([
      ["entry.community_id.as_bytes()", "community_id"],
      ["entry.seq.to_be_bytes()", "seq"],
      [
        "to_storage_precision(entry.created_at).to_rfc3339().as_bytes()",
        "created_at",
      ],
      ["entry.action.as_str().as_bytes()", "action"],
      ["pk", "actor_pubkey"],
      ["id.as_bytes()", "object_id"],
      ["canonical_json(&entry.detail)?.as_bytes()", "detail"],
      ["h", "prev_hash"],
      ["GENESIS_HASH", "prev_hash"],
    ]);

    const labels = [];
    for (const [i, arg] of args.entries()) {
      if (arg === "[1u8]") {
        // Presence tag: belongs to the value that follows it.
        const next = args[i + 1];
        if (next === "pk") labels.push("actor_pubkey");
        else if (next === "id.as_bytes()") labels.push("object_id");
        else labels.push(`unexpected-value-after-presence:${String(next)}`);
      } else if (arg === "[0u8]") {
        // Absent branch: shares the label of the preceding field group.
        const previous = labels[i - 1];
        if (previous === "actor_pubkey" || previous === "object_id") {
          labels.push(previous);
        } else {
          labels.push(`unexpected-absent-branch:${arg}`);
        }
      } else {
        labels.push(direct.get(arg) ?? `unknown-preimage-field:${arg}`);
      }
    }

    const collapsed = labels.filter(
      (label, i) => i === 0 || label !== labels[i - 1],
    );
    assert.deepEqual(
      collapsed,
      [...CHAIN_PREIMAGE_ORDER],
      "Rust compute_hash field order changed — update CHAIN_PREIMAGE_ORDER " +
        "and regenerate the vectors in this file",
    );
    assert.ok(
      labels.every((label) => !label.startsWith("unknown-")),
      `unmapped preimage field: ${labels.join(",")}`,
    );
  });

  it("keeps the genesis sentinel and microsecond storage precision", () => {
    assert.match(hashRs, /pub const GENESIS_HASH: \[u8; 32\] = \[0u8; 32\]/);
    assert.match(hashRs, /created_at\.trunc_subsecs\(6\)/);
  });

  it("verifies link-then-digest with a null starting expectation", () => {
    const serviceRs = rustFile("crates/buzz-audit/src/service.rs");
    const start = serviceRs.indexOf("pub async fn verify_chain");
    const end = serviceRs.indexOf("Ok(true)", start);
    const body = serviceRs.slice(start, end);
    assert.match(body, /let mut expected_prev: Option<Vec<u8>> = None/);
    const link = body.indexOf("AuditError::ChainViolation");
    const digest = body.indexOf("AuditError::HashMismatch");
    assert.ok(link !== -1 && digest !== -1, "verify_chain checks vanished");
    assert.ok(
      link < digest,
      "verify_chain must check the prev_hash link before the digest",
    );
  });
});

// ── Byte-exact vectors ──────────────────────────────────────────────────────

describe("computeChainHash — vectors from the crate's own compute_hash", () => {
  it("v1: the crate's sample_entry() (hash.rs:125-139)", () => {
    assert.equal(
      computeChainHash(
        entry({
          communityId: C1,
          seq: 1,
          action: "event_created",
          actorPubkey: AB,
          objectId: "abc123",
          detail: parseJson("null"),
          createdAt: "2026-01-01T00:00:00Z",
        }),
      ),
      "5fd6c48ddbd39979bd7fcc94357d78b5fcffa0d1443a0cdda997ad7e22f4f2ce",
    );
  });

  it("v2: same entry under another community — tenant binding", () => {
    assert.equal(
      computeChainHash(
        entry({
          communityId: C2,
          action: "event_created",
          actorPubkey: AB,
          objectId: "abc123",
        }),
      ),
      "f3351659727bfa036c9a0dc2df038a48db2b07533334e93d75f90b6036a59e57",
    );
  });

  it("v3: chained entry, canonical key order, millisecond timestamp", () => {
    assert.equal(
      computeChainHash(
        entry({
          seq: 2,
          prevHash:
            "5fd6c48ddbd39979bd7fcc94357d78b5fcffa0d1443a0cdda997ad7e22f4f2ce",
          action: "channel_created",
          detail: parseJson(
            '{"z":1,"a":{"m":[true,null,"x"],"n":2},"b":"two"}',
          ),
          createdAt: "2026-01-01T00:00:01.5Z",
        }),
      ),
      "8e2646dc6c1ad5697b33eadea58646dcb613a541895865ef524182e61092498d",
    );
    // The millisecond width chrono emits for that instant.
    assert.equal(
      storagePrecisionRfc3339("2026-01-01T00:00:01.5Z"),
      "2026-01-01T00:00:01.500+00:00",
    );
  });

  it("v4: nanosecond timestamp truncates to storage precision", () => {
    assert.equal(
      computeChainHash(
        entry({
          seq: 3,
          prevHash:
            "8e2646dc6c1ad5697b33eadea58646dcb613a541895865ef524182e61092498d",
          action: "member_added",
          actorPubkey: CD,
          objectId: "obj-4",
          createdAt: "2023-11-14T22:13:20.123456789Z",
        }),
      ),
      "4ed09599ac6cb728cc77451ca252528c0c4616d1f018af766dd5be72a80fc788",
    );
    // Pinned on the preimage by the crate itself (hash.rs:176-181).
    assert.equal(
      storagePrecisionRfc3339("2023-11-14T22:13:20.123456789Z"),
      "2023-11-14T22:13:20.123456+00:00",
    );
  });

  it("v5: presence tag separates Some(empty) from None", () => {
    const base = { action: "auth_failure", createdAt: "2026-01-01T00:00:00Z" };
    assert.equal(
      computeChainHash(entry({ ...base, actorPubkey: "" })),
      "55589e41f625b5cfc25bc13ab5fc7a9739d50c88a69353b967f9b20ae6b55af1",
    );
    assert.equal(
      computeChainHash(entry({ ...base, actorPubkey: null })),
      "e1248915f32178d51f8d3235cf4f724a0cc6dd17b04cb9c0d70fb0c6a3dfd6a2",
    );
    assert.notEqual(
      computeChainHash(entry({ ...base, actorPubkey: "" })),
      computeChainHash(entry({ ...base, actorPubkey: null })),
    );
  });

  it("v6: string escaping and UTF-8 detail bytes", () => {
    assert.equal(
      computeChainHash(
        entry({
          seq: 4,
          prevHash:
            "4ed09599ac6cb728cc77451ca252528c0c4616d1f018af766dd5be72a80fc788",
          action: "event_deleted",
          actorPubkey: AB,
          objectId: "evt/with\ttab",
          detail: parseJson('{"s":"héllo \\"wörld\\" \\\\ \\n","u":"👍"}'),
          createdAt: "2026-03-05T09:07:08.000001Z",
        }),
      ),
      "ff4ae77a851d713909d2d256611d55bc6824d439ce3a38d60b02c6dea1c10294",
    );
  });

  it("v7: serde_json number rendering, 38 lexemes", () => {
    const table = [
      [
        "1.0",
        "ae0b46900314ce9b28f193d840330d0e59cae852bcb867d0be3775e07120371f",
      ],
      [
        "1.10",
        "f6f32587526de25451e2e338dc486ecb52ceae2782fbc8de1049c80363bdbcb8",
      ],
      [
        "100.0",
        "bce9964d5ce222033db980c675b1a07f797628ebb15fb9e00d52c1c1f6a515fd",
      ],
      [
        "0.1",
        "40c102c0aa62a6bae0b0253adc0af29f6d0ad568225e9dda409b87f2fccfcfa5",
      ],
      [
        "-0.0",
        "ab5ed060d7062a580c555b4707064272121ade56533c0828a39c14e91931186f",
      ],
      [
        "1e2",
        "bce9964d5ce222033db980c675b1a07f797628ebb15fb9e00d52c1c1f6a515fd",
      ],
      [
        "1E2",
        "bce9964d5ce222033db980c675b1a07f797628ebb15fb9e00d52c1c1f6a515fd",
      ],
      [
        "1e21",
        "4397668d163612080c467fe94b14391099e57996ae08e5ae23943656fba69f31",
      ],
      [
        "1e20",
        "c042c92e20c4a0beb973833b24a214993120f71344a88b0f18faf926277650ba",
      ],
      [
        "1e16",
        "bb22deb8a541169744a824716101fc843288f4d04158ec45ab9febbad68053d2",
      ],
      [
        "1e15",
        "a4ed8eb31b11ff3016485895dc6361bfbcc47c06fda7f9bdab788824e29252cf",
      ],
      [
        "1e-5",
        "76d5b8cba6d94b46ebe4c6d111ecc88f533c8fb77c0f88aa26a0d109cf3526fa",
      ],
      [
        "1e-6",
        "e5f8cb6d3be8dbc359fc480ddbe8f447096c17348e563b41ff2afb83e0818879",
      ],
      [
        "1e-7",
        "e254c5be0b584350dd10f96738b7b2b5aae8ebdc226c5b0cfd35bdf25ee77805",
      ],
      [
        "0.0001",
        "a966abc0e942a2a0471b1369805e9ac18281dab7f82e52911e980d5333d80fa1",
      ],
      [
        "1.5e30",
        "c4e2f548365cbc68b6920d1981d72958420d840c0f53ea86b44859c669605ce7",
      ],
      [
        "3.141592653589793",
        "c99700db51699d573642e35b99928d98bed11e822e31f1737e172cedd9c9b17a",
      ],
      [
        "12345678901234567890",
        "3785e9f5b049f258a96779802fd483db4115c7c9eb6cbe26fd905649b51dbfaa",
      ],
      [
        "-12345678901234567890",
        "7ee65b13489163c6beeecff66816186dec3950377820994e6796401b1f0ce65d",
      ],
      [
        "1e300",
        "1c861baec9dab42659a1936d280f2a6ff39ab0ccd828f887534541e7ef401de0",
      ],
      [
        "42",
        "7c7d017f23568d588b5625e8f53924a89534a2ec329354a80cdf7974797d502f",
      ],
      [
        "-42",
        "7bc685bde8bbf95c8c91f2c7215cf3949e382a77bccf8e5b25e00f30be79c420",
      ],
      ["0", "5d1681a98b475a7b6f68f158ac57ba5913800e0d422b5d3595147f223af2dee9"],
      [
        "-0",
        "ab5ed060d7062a580c555b4707064272121ade56533c0828a39c14e91931186f",
      ],
      [
        "9.9e15",
        "e16af61d645626e13f5dde88f10bec14a2bf4c9b0c08920082b4683c52e21af5",
      ],
      [
        "1.2345e16",
        "1a3227627e5d776fd0e2237f50a78654d327d317cb5d052b5760925b98194602",
      ],
      [
        "1.23e-5",
        "4321a5dba2e66c9f9cd9ecba17ad5660be9724e1bb3d9ad6306343f890038a71",
      ],
      [
        "9.9e-6",
        "1fcd75891fe1cd6517f2737c60eadaa5929867f5ea8326bfbaf3938f5e8b5df3",
      ],
      [
        "5e-6",
        "8aa6d14612e74b15a9ffba7f8ee2427d6cd992181eeb8ed62a4ac72cec8602c6",
      ],
      [
        "0.0000123",
        "4321a5dba2e66c9f9cd9ecba17ad5660be9724e1bb3d9ad6306343f890038a71",
      ],
      [
        "123456789012345.0",
        "5a0c31c4b5b4ffa53061942666d8fba635bd42b23cde98aaeae15113dc203f56",
      ],
      [
        "9007199254740993",
        "c0e1ddb3232c3f8bfbbf20ee09159de6ac16954cd84606fcf36166174482c11d",
      ],
      [
        "1e17",
        "3210a8b74f63f16ea75251b287d00689ab70d5685e12965ca2bd69e88ae5e055",
      ],
      [
        "1e18",
        "a2bc71eb782a429228b31a07f4a38c8d00b34d86a939aaace9cda6e88a1afa2a",
      ],
      [
        "1.7976931348623157e308",
        "68f686840e8dc3f76d22e9a76ca39a494ef6bdf872aebef33265e8b9e5cad5dc",
      ],
      [
        "5e-324",
        "cc82dcaf98770788847e7437473605d752699f55f843e18506a5a4a91b84ac52",
      ],
      [
        "0.30000000000000004",
        "bbff777d8789e45fa8f4e59401196cb5fd7b190ee71de7178a7f762446ccd9eb",
      ],
      [
        "2.5e-10",
        "7db716615c48fc71428b71707427e37e56b80361fe14e01fa1335dc6c02ad9ed",
      ],
    ];
    assert.equal(table.length, 38);
    for (const [lexeme, expected] of table) {
      assert.equal(
        computeChainHash(entry({ detail: parseJson(`{"v":${lexeme}}`) })),
        expected,
        `number lexeme ${lexeme} rendered differently from serde_json`,
      );
    }
  });

  it("v8: a three-link chain, and a tampered copy that must not verify", () => {
    const link1 = computeChainHash(
      entry({
        action: "event_created",
        actorPubkey: AB,
        objectId: "evt-1",
        detail: parseJson('{"event_kind":40002,"channel_id":null}'),
        createdAt: "2026-02-02T10:00:00.000100Z",
      }),
    );
    assert.equal(
      link1,
      "9a1f34800d58350b780c319c3ca4893a1f3fcd048968fe85746711dcab3264df",
    );
    const link2 = computeChainHash(
      entry({
        seq: 2,
        prevHash: link1,
        action: "event_deleted",
        actorPubkey: AB,
        objectId: "evt-2",
        detail: parseJson('{"reason":"moderation"}'),
        createdAt: "2026-02-02T10:00:01.000200Z",
      }),
    );
    assert.equal(
      link2,
      "17eda9b7c689e2faaa22553b94d541ff2612586ee933a0a91d8170a70127f46c",
    );
    const link3 = computeChainHash(
      entry({
        seq: 3,
        prevHash: link2,
        action: "media_uploaded",
        objectId: "deadbeef",
        detail: parseJson('{"bytes":1024}'),
        createdAt: "2026-02-02T10:00:02Z",
      }),
    );
    assert.equal(
      link3,
      "b2771cf5c72cda07e88e477aff2f5c1449aa6a287ebfc6594ba8121ce7eaeaa6",
    );
    const tampered = computeChainHash(
      entry({
        seq: 2,
        prevHash: link1,
        action: "event_deleted",
        actorPubkey: "ff".repeat(32),
        objectId: "evt-2",
        detail: parseJson('{"reason":"moderation"}'),
        createdAt: "2026-02-02T10:00:01.000200Z",
      }),
    );
    assert.equal(
      tampered,
      "1f34665e13c224530f6992168277e82d69c87b49548f66e202e17e36c586b7fe",
    );
    assert.notEqual(tampered, link2);
  });

  it("matches a raw SHA-256 sanity vector", () => {
    assert.equal(
      bytesToHex(sha256(new TextEncoder().encode("abc"))),
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    assert.equal(GENESIS_HEX, "0".repeat(64));
  });
});

// ── canonical JSON + timestamps ─────────────────────────────────────────────

describe("canonicalJson", () => {
  it("sorts object keys by UTF-8 bytes and keeps array order", () => {
    assert.equal(
      canonicalJson(parseJson('{"z":1,"a":2,"m":3}')),
      '{"a":2,"m":3,"z":1}',
    );
    assert.equal(
      canonicalJson(parseJson('[1,"two",false,null]')),
      '[1,"two",false,null]',
    );
    assert.equal(canonicalJson(parseJson('"a\\"b"')), '"a\\"b"');
  });

  it("keeps lexemes JSON.parse would collapse", () => {
    assert.equal(canonicalJson(parseJson('{"v":1.0}')), '{"v":1.0}');
    assert.equal(canonicalJson(parseJson('{"v":1e2}')), '{"v":100.0}');
    assert.equal(
      canonicalJson(parseJson('{"v":9007199254740993}')),
      '{"v":9007199254740993}',
    );
    assert.equal(canonicalJson(parseJson('{"v":-0}')), '{"v":-0.0}');
    // Control characters use serde_json's lowercase \u00xx escapes.
    assert.equal(canonicalJson(parseJson('"\\u0001"')), '"\\u0001"');
    assert.equal(canonicalJson(parseJson('"\t\n"')), '"\\t\\n"');
  });

  it("rejects non-finite numbers instead of hashing a stand-in", () => {
    assert.throws(
      () => canonicalJson(new RustNumber("NaN")),
      AuditChainInputError,
    );
    assert.throws(
      () => canonicalJson(Number.POSITIVE_INFINITY),
      AuditChainInputError,
    );
  });

  it("rejects malformed JSON rather than guessing", () => {
    assert.throws(() => parseJson('{"a":}'), AuditChainInputError);
    assert.throws(() => parseJson("01"), AuditChainInputError);
    assert.throws(() => parseJson("{} trailing"), AuditChainInputError);
  });
});

describe("storagePrecisionRfc3339", () => {
  it("renders chrono's AutoSi widths", () => {
    assert.equal(
      storagePrecisionRfc3339("2026-01-01T00:00:00Z"),
      "2026-01-01T00:00:00+00:00",
    );
    assert.equal(
      storagePrecisionRfc3339("2026-01-01T00:00:00.5Z"),
      "2026-01-01T00:00:00.500+00:00",
    );
    assert.equal(
      storagePrecisionRfc3339("2026-02-02T10:00:01.000200Z"),
      "2026-02-02T10:00:01.000200+00:00",
    );
    assert.equal(
      storagePrecisionRfc3339("2026-01-01T00:00:00.000001Z"),
      "2026-01-01T00:00:00.000001+00:00",
    );
    // Sub-microsecond digits are dropped before hashing — they never survive
    // the TIMESTAMPTZ round trip, so hashing them would un-verify every row.
    assert.equal(
      storagePrecisionRfc3339("2026-01-01T00:00:00.000000001Z"),
      "2026-01-01T00:00:00+00:00",
    );
  });

  it("normalizes offsets to UTC", () => {
    assert.equal(
      storagePrecisionRfc3339("2026-01-01T05:30:00+05:30"),
      "2026-01-01T00:00:00+00:00",
    );
    assert.equal(
      storagePrecisionRfc3339("2025-12-31T23:00:00-01:00"),
      "2026-01-01T00:00:00+00:00",
    );
  });

  it("rejects unparseable timestamps", () => {
    assert.throws(
      () => storagePrecisionRfc3339("not-a-time"),
      AuditChainInputError,
    );
  });
});

// ── Envelope parsing ────────────────────────────────────────────────────────

function envelope(overrides = {}) {
  return JSON.stringify({
    community_id: C1,
    seq: 1,
    hash: Array.from({ length: 32 }, (_, i) => i),
    prev_hash: null,
    action: "event_created",
    actor_pubkey: Array.from({ length: 32 }, (_, i) => 255 - i),
    object_id: "evt-1",
    detail: { event_kind: 40002 },
    created_at: "2026-01-01T00:00:00.000001Z",
    hash_version: 2,
    ...overrides,
  });
}

describe("parseChainEntry", () => {
  it("reads AuditEntry's serde shape (byte arrays)", () => {
    const parsed = parseChainEntry(envelope());
    assert.ok(parsed);
    assert.equal(parsed.communityId, C1);
    assert.equal(parsed.seq, 1);
    assert.equal(
      parsed.hash,
      bytesToHex(Uint8Array.from({ length: 32 }, (_, i) => i)),
    );
    assert.equal(
      parsed.actorPubkey,
      bytesToHex(Uint8Array.from({ length: 32 }, (_, i) => 255 - i)),
    );
    assert.equal(parsed.objectId, "evt-1");
    assert.equal(parsed.prevHash, null);
    assert.equal(typeof parsed.createdAt, "string");
  });

  it("accepts hex digests and hex pubkeys too", () => {
    const parsed = parseChainEntry(
      envelope({
        hash: "00".repeat(32),
        prev_hash: "11".repeat(32),
        actor_pubkey: "ab".repeat(32),
      }),
    );
    assert.ok(parsed);
    assert.equal(parsed.hash, "00".repeat(32));
    assert.equal(parsed.prevHash, "11".repeat(32));
    assert.equal(parsed.actorPubkey, "ab".repeat(32));
  });

  it("returns null for payloads that are not audit entries", () => {
    assert.equal(parseChainEntry("not json"), null);
    assert.equal(parseChainEntry("[1,2,3]"), null);
    assert.equal(parseChainEntry(JSON.stringify({ kind: "x" })), null);
    assert.equal(parseChainEntry(envelope({ hash: "short" })), null);
  });

  it("counts malformed envelopes instead of dropping them", () => {
    const { entries, malformed } = parseChainEntryBatch([
      envelope(),
      "garbage",
      envelope({ seq: 2 }),
    ]);
    assert.equal(entries.length, 2);
    assert.equal(malformed, 1);
  });
});

// ── Verification ────────────────────────────────────────────────────────────

function chainFixture() {
  const first = entry({
    actorPubkey: AB,
    objectId: "evt-1",
    detail: parseJson('{"event_kind":37010}'),
    createdAt: "2026-02-02T10:00:00Z",
    hash: "",
  });
  first.hash = computeChainHash(first);
  const second = entry({
    seq: 2,
    prevHash: first.hash,
    action: "event_deleted",
    actorPubkey: AB,
    objectId: "evt-2",
    detail: parseJson('{"event_kind":37011}'),
    createdAt: "2026-02-02T10:00:01Z",
    hash: "",
  });
  second.hash = computeChainHash(second);
  const third = entry({
    seq: 3,
    prevHash: second.hash,
    action: "member_added",
    actorPubkey: CD,
    objectId: "evt-3",
    detail: parseJson('{"event_kind":37012}'),
    createdAt: "2026-02-02T10:00:02Z",
    hash: "",
  });
  third.hash = computeChainHash(third);
  return { first, second, third };
}

describe("verifyChain", () => {
  it("verifies a well-formed prefix", () => {
    const { first, second, third } = chainFixture();
    const result = verifyChain([third, first, second]); // shuffled on purpose
    assert.equal(result.state, "verified");
    assert.equal(result.fromSeq, 1);
    assert.equal(result.toSeq, 3);
    assert.equal(result.count, 3);
    assert.equal(result.genesis, true);
    assert.equal(result.breakSeq, undefined);
    assert.equal(result.gapAtSeq, undefined);
  });

  it("reports an empty load honestly", () => {
    assert.equal(verifyChain([]).state, "empty");
  });

  it("flags a tampered entry as a hash mismatch at its exact seq", () => {
    const { first, second, third } = chainFixture();
    const tampered = { ...second, actorPubkey: "ff".repeat(32) };
    const result = verifyChain([first, tampered, third]);
    assert.equal(result.state, "broken");
    assert.equal(result.breakSeq, 2);
    assert.equal(result.breakReason, "hash_mismatch");
    assert.equal(result.toSeq, 1);
    assert.equal(result.count, 1);
  });

  it("flags a re-linked entry as a chain violation", () => {
    const { first, second, third } = chainFixture();
    const relinked = { ...third, prevHash: first.hash };
    const result = verifyChain([first, second, relinked]);
    assert.equal(result.state, "broken");
    assert.equal(result.breakSeq, 3);
    assert.equal(result.breakReason, "chain_violation");
    assert.equal(result.toSeq, 2);
  });

  it("treats a page discontinuity as coverage, not a break", () => {
    const { first, second, third } = chainFixture();
    const tail = verifyChain([second, third]);
    assert.equal(tail.state, "verified");
    assert.equal(tail.fromSeq, 2);
    assert.equal(tail.genesis, false);
    const gapped = verifyChain([first, third]);
    assert.equal(gapped.state, "verified");
    assert.equal(gapped.gapAtSeq, 3);
    assert.equal(gapped.toSeq, 1);
    assert.equal(gapped.genesis, true);
  });

  it("reports a malformed entry as a break, never as green", () => {
    const { first, second } = chainFixture();
    const result = verifyChain([first, { ...second, createdAt: "garbage" }]);
    assert.equal(result.state, "broken");
    assert.equal(result.breakSeq, 2);
    assert.equal(result.breakReason, "malformed");
  });
});

// ── Badge derivation (the falsifiable UI guard) ─────────────────────────────

describe("deriveChainBadges", () => {
  it("marks covered events verified and leaves uncovered ones explicit", () => {
    const { first, second, third } = chainFixture();
    const badges = deriveChainBadges(
      [first, second, third],
      verifyChain([first, second, third]),
    );
    assert.deepEqual(badges.get("evt-1"), {
      state: "verified",
      seq: 1,
      action: "event_created",
    });
    assert.deepEqual(badges.get("evt-2"), {
      state: "verified",
      seq: 2,
      action: "event_deleted",
    });
    assert.deepEqual(badges.get("evt-3"), {
      state: "verified",
      seq: 3,
      action: "member_added",
    });
    assert.equal(badges.size, 3);
  });

  it("flips the tampered row's badge to broken — the falsifiable guard", () => {
    const { first, second, third } = chainFixture();
    const tampered = { ...second, actorPubkey: "ff".repeat(32) };
    const before = deriveChainBadges(
      [first, second, third],
      verifyChain([first, second, third]),
    );
    const after = deriveChainBadges(
      [first, tampered, third],
      verifyChain([first, tampered, third]),
    );
    assert.equal(before.get("evt-2").state, "verified");
    assert.equal(after.get("evt-2").state, "broken");
    assert.equal(after.get("evt-2").reason, "hash_mismatch");
    assert.equal(after.get("evt-2").action, "event_deleted");
    // The break poisons everything after it, loudly.
    assert.equal(after.get("evt-3").state, "unverified");
    assert.equal(after.get("evt-1").state, "verified");
  });

  it("reports absence distinctly from unavailability", () => {
    const { first } = chainFixture();
    const badges = deriveChainBadges([first], verifyChain([first]));
    assert.deepEqual(badgeForEvent(badges, "evt-999", true), {
      state: "not-in-chain",
    });
    assert.deepEqual(badgeForEvent(badges, "evt-1", false), {
      state: "unavailable",
    });
    assert.deepEqual(badgeForEvent(new Map(), "evt-1", true), {
      state: "not-in-chain",
    });
    assert.deepEqual(badgeForEvent(new Map(), "evt-1", false), {
      state: "unavailable",
    });
  });

  it("marks entries beyond a reported gap unverified", () => {
    const { first, third } = chainFixture();
    const badges = deriveChainBadges(
      [first, third],
      verifyChain([first, third]),
    );
    assert.equal(badges.get("evt-1").state, "verified");
    assert.equal(badges.get("evt-3").state, "unverified");
  });
});

// ── Labels ──────────────────────────────────────────────────────────────────

describe("auditActionLabel", () => {
  it("names every action in action.rs exactly once", () => {
    assert.deepEqual(
      [
        "event_created",
        "event_deleted",
        "channel_created",
        "channel_updated",
        "channel_deleted",
        "member_added",
        "member_removed",
        "auth_success",
        "auth_failure",
        "rate_limit_exceeded",
        "media_uploaded",
      ].map(auditActionLabel),
      [
        "Event created",
        "Event deleted",
        "Channel created",
        "Channel updated",
        "Channel deleted",
        "Member added",
        "Member removed",
        "Sign-in succeeded",
        "Sign-in failed",
        "Rate limit exceeded",
        "Media uploaded",
      ],
    );
  });

  it("never maps an unknown action onto a known label", () => {
    assert.equal(
      auditActionLabel("totally_bogus"),
      "Unknown action (totally_bogus)",
    );
    assert.equal(
      auditActionLabel("media_uploaded "),
      "Unknown action (media_uploaded )",
    );
  });
});

describe("computeChainHash — v2 TLV vectors from the crate's own compute_hash", () => {
  it("t1: genesis under TLV — prev_hash omitted, actor/object keep tags", () => {
    assert.equal(
      computeChainHash(
        entry({
          hashVersion: 2,
          action: "event_created",
          actorPubkey: AB,
          objectId: "abc123",
        }),
      ),
      "e12c899d941af9794679602ae83ef2ab1c8f029fe380349263a046a93374d580",
    );
  });

  it("t2: chained — prev tag present, canonical keys, millisecond timestamp", () => {
    assert.equal(
      computeChainHash(
        entry({
          hashVersion: 2,
          seq: 2,
          prevHash:
            "e12c899d941af9794679602ae83ef2ab1c8f029fe380349263a046a93374d580",
          action: "channel_created",
          detail: parseJson(
            '{"z":1,"a":{"m":[true,null,"x"],"n":2},"b":"two"}',
          ),
          createdAt: "2026-01-01T00:00:01.5Z",
        }),
      ),
      "304a04c13473d8610d063d726337a04c932520fb24bdfbd410e9e5228526de43",
    );
  });

  it("t3: Some(empty) actor keeps its tag at zero length", () => {
    assert.equal(
      computeChainHash(
        entry({
          hashVersion: 2,
          seq: 3,
          prevHash:
            "304a04c13473d8610d063d726337a04c932520fb24bdfbd410e9e5228526de43",
          action: "member_added",
          actorPubkey: "",
          objectId: "obj-4",
          detail: parseJson('{"k":1}'),
          createdAt: "2023-11-14T22:13:20.123456789Z",
        }),
      ),
      "4c53ce1289a8055c43dcf15424b0d5216a98de03aed64e04060aab6806f670fd",
    );
  });
});
