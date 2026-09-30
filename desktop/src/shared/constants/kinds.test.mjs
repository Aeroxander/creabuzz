import assert from "node:assert/strict";
import test from "node:test";

import {
  isConversationalUnreadKind,
  KIND_STREAM_MESSAGE,
  KIND_STREAM_MESSAGE_V2,
  KIND_STREAM_MESSAGE_DIFF,
  KIND_SYSTEM_MESSAGE,
  KIND_JOB_REQUEST,
  KIND_JOB_ACCEPTED,
  KIND_JOB_PROGRESS,
  KIND_JOB_RESULT,
  KIND_JOB_CANCEL,
  KIND_JOB_ERROR,
  KIND_HUDDLE_STARTED,
  KIND_HUDDLE_PARTICIPANT_JOINED,
  KIND_HUDDLE_PARTICIPANT_LEFT,
  KIND_HUDDLE_ENDED,
} from "./kinds.ts";

test("isConversationalUnreadKind_streamMessage_counts", () => {
  assert.equal(isConversationalUnreadKind(KIND_STREAM_MESSAGE), true);
});

test("isConversationalUnreadKind_streamMessageV2_counts", () => {
  // 40002 is a real message edit/v2 — must stay counted.
  assert.equal(isConversationalUnreadKind(KIND_STREAM_MESSAGE_V2), true);
});

test("isConversationalUnreadKind_streamMessageDiff_counts", () => {
  // 40008 is a real message diff — must stay counted.
  assert.equal(isConversationalUnreadKind(KIND_STREAM_MESSAGE_DIFF), true);
});

test("isConversationalUnreadKind_systemMessage_excluded", () => {
  // 40099 channel_created / member_joined rows must not inflate the pill.
  assert.equal(isConversationalUnreadKind(KIND_SYSTEM_MESSAGE), false);
});

test("isConversationalUnreadKind_allJobKinds_excluded", () => {
  for (const kind of [
    KIND_JOB_REQUEST,
    KIND_JOB_ACCEPTED,
    KIND_JOB_PROGRESS,
    KIND_JOB_RESULT,
    KIND_JOB_CANCEL,
    KIND_JOB_ERROR,
  ]) {
    assert.equal(isConversationalUnreadKind(kind), false, `kind ${kind}`);
  }
});

test("isConversationalUnreadKind_huddleLifecycle_excluded", () => {
  for (const kind of [
    KIND_HUDDLE_STARTED,
    KIND_HUDDLE_PARTICIPANT_JOINED,
    KIND_HUDDLE_PARTICIPANT_LEFT,
    KIND_HUDDLE_ENDED,
  ]) {
    assert.equal(isConversationalUnreadKind(kind), false, `kind ${kind}`);
  }
});

test("isConversationalUnreadKind_undefinedKind_countsAsConversational", () => {
  // Optimistic/pending rows whose kind has not populated must not be dropped.
  assert.equal(isConversationalUnreadKind(undefined), true);
});

test("isConversationalUnreadKind_unknownKind_countsAsConversational", () => {
  // An exclude-list, not an include-list: anything not explicitly excluded
  // (e.g. a future conversational kind) is kept.
  assert.equal(isConversationalUnreadKind(12345), true);
});

// ── Registry drift guards ──────────────────────────────────────────────────
// `crates/buzz-core/src/kind.rs` is the registry; the desktop and mobile
// constants mirror it. These tests read the Rust and Dart sources so a kind the
// fork added cannot be missing (or renumbered) on a client without a red test.

import { readFileSync } from "node:fs";

import * as kindsNamespace from "./kinds.ts";

// A plain copy, so lookups by computed name are not dynamic namespace access.
const kinds = { ...kindsNamespace };

const RUST = readFileSync(
  new URL("../../../../crates/buzz-core/src/kind.rs", import.meta.url),
  "utf8",
);
const DART = readFileSync(
  new URL(
    "../../../../mobile/lib/shared/relay/nostr_models.dart",
    import.meta.url,
  ),
  "utf8",
);
const rustKinds = new Map(
  [...RUST.matchAll(/pub const (KIND_[A-Z0-9_]+): u32 = (\d+);/g)].map(
    (match) => [match[1], Number(match[2])],
  ),
);
const dartKinds = new Map(
  [...DART.matchAll(/static const (\w+) = (\d+);/g)].map((match) => [
    match[1],
    Number(match[2]),
  ]),
);

const FORK_KINDS = [
  "KIND_ORG_PITCH",
  "KIND_ORG_JOIN_REQUEST",
  "KIND_EVM_BINDING",
  "KIND_DEPLOYMENT_RECORD",
  "KIND_AUDIT_ENTRY",
  "KIND_SKILL",
  "KIND_WIKI_PAGE",
];

test("kinds_forkKinds_matchTheRustRegistry", () => {
  for (const name of FORK_KINDS) {
    assert.ok(rustKinds.has(name), `${name} is not in the Rust registry`);
    assert.equal(kinds[name], rustKinds.get(name), name);
  }
});

test("kinds_everySharedNameCarriesTheRegistryValue", () => {
  // A constant that reuses a Rust name must reuse its number. (Some desktop
  // names are deliberately its own — those are simply not compared.)
  let compared = 0;
  for (const [name, value] of Object.entries(kinds)) {
    if (!name.startsWith("KIND_") || typeof value !== "number") continue;
    // NIP-78 slots all share 30078 by design; Rust has one name for them.
    if (!rustKinds.has(name)) continue;
    compared += 1;
    assert.equal(value, rustKinds.get(name), name);
  }
  assert.ok(compared > 40, `only ${compared} constants were compared`);
});

test("kinds_mobileMirrorsTheForkKinds", () => {
  const pairs = {
    orgPitch: "KIND_ORG_PITCH",
    orgJoinRequest: "KIND_ORG_JOIN_REQUEST",
    evmBinding: "KIND_EVM_BINDING",
    deploymentRecord: "KIND_DEPLOYMENT_RECORD",
    auditEntry: "KIND_AUDIT_ENTRY",
    skill: "KIND_SKILL",
    wikiPage: "KIND_WIKI_PAGE",
    orgNode: "KIND_ORG_NODE",
    orgGrant: "KIND_ORG_GRANT",
    orgBudget: "KIND_ORG_BUDGET",
    contributionRecord: "KIND_CONTRIBUTION_RECORD",
    budgetSpendReceipt: "KIND_BUDGET_SPEND_RECEIPT",
  };
  for (const [dartName, tsName] of Object.entries(pairs)) {
    assert.ok(dartKinds.has(dartName), `mobile is missing ${dartName}`);
    assert.equal(dartKinds.get(dartName), kinds[tsName], dartName);
  }
});

test("kinds_orgKindsAreDescribedAsCommunityLevelNotChannelScoped", () => {
  // `h` is the NIP-29 channel tag; these kinds carry none. The old comments
  // called `h` "the community", which is how a channel tag got put on them.
  for (const [file, source] of [
    ["kinds.ts", readFileSync(new URL("./kinds.ts", import.meta.url), "utf8")],
    ["nostr_models.dart", DART],
  ]) {
    assert.doesNotMatch(source, /h = community/, file);
  }
});
