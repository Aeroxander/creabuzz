import assert from "node:assert/strict";
import test from "node:test";

import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

import { agentLabel, agentMark, conditionsHold } from "./agent-label.ts";
import { helpRequest, parseHelpSignal } from "./help-request.ts";

const OWNER_KEY = "1".repeat(64);
const AGENT_KEY = "2".repeat(64);
const pub = (key) => bytesToHex(schnorr.getPublicKey(hexToBytes(key)));
const OWNER = pub(OWNER_KEY);
const AGENT = pub(AGENT_KEY);

/** The owner's proof for `agent`, as the app's browser agent writes it. */
function auth(agent, conditions, ownerKey = OWNER_KEY) {
  const digest = sha256(
    new TextEncoder().encode(`nostr:agent-auth:${agent}:${conditions}`),
  );
  return [
    "auth",
    pub(ownerKey),
    conditions,
    bytesToHex(schnorr.sign(digest, hexToBytes(ownerKey))),
  ];
}

test("a person's record carries no agent mark", () => {
  assert.equal(
    agentMark({ pubkey: OWNER, created_at: 100, tags: [["a", "x"]] }),
    null,
  );
});

test("an agent that proves who runs it is labelled with its owner", () => {
  const record = {
    pubkey: AGENT,
    created_at: 100,
    tags: [["agent", AGENT], auth(AGENT, "kind=47003")],
  };
  assert.deepEqual(agentMark(record, 47003), { owner: OWNER });
  assert.equal(agentLabel("Sam"), "Agent, run by Sam");
});

test("a proof made for another account, another kind, or by nobody names no owner", () => {
  // Signed for a different agent key: it does not vouch for this account.
  const other = pub("3".repeat(64));
  assert.deepEqual(
    agentMark({
      pubkey: AGENT,
      created_at: 100,
      tags: [["agent", AGENT], auth(other, "")],
    }),
    { owner: null },
  );
  // The owner allowed another kind of record only.
  assert.deepEqual(
    agentMark(
      {
        pubkey: AGENT,
        created_at: 100,
        tags: [["agent", AGENT], auth(AGENT, "kind=37001")],
      },
      47003,
    ),
    { owner: null },
  );
  // A made-up signature.
  assert.deepEqual(
    agentMark({
      pubkey: AGENT,
      created_at: 100,
      tags: [
        ["agent", AGENT],
        ["auth", OWNER, "", "0".repeat(128)],
      ],
    }),
    { owner: null },
  );
  assert.equal(agentLabel(null), "Agent");
});

test("a proof alone marks an agent, and naming someone else's key as the agent marks nothing", () => {
  assert.deepEqual(
    agentMark({ pubkey: AGENT, created_at: 100, tags: [auth(AGENT, "")] }),
    {
      owner: OWNER,
    },
  );
  assert.equal(
    agentMark({ pubkey: OWNER, created_at: 100, tags: [["agent", AGENT]] }),
    null,
  );
  // An account cannot be its own owner.
  assert.equal(
    agentMark({
      pubkey: OWNER,
      created_at: 100,
      tags: [auth(OWNER, "", OWNER_KEY)],
    }),
    null,
  );
});

test("an owner's word that has run out names nobody: the record must fall inside the dates it covers", () => {
  const record = (at, conditions) => ({
    pubkey: AGENT,
    created_at: at,
    tags: [["agent", AGENT], auth(AGENT, conditions)],
  });
  const until = "kind=47003&created_at<1000";
  assert.deepEqual(agentMark(record(999, until), 47003), { owner: OWNER });
  // Dated at or after the end of the owner's word: still an agent, with no owner named.
  assert.deepEqual(agentMark(record(1000, until), 47003), { owner: null });
  assert.deepEqual(agentMark(record(5000, until), 47003), { owner: null });
  // Not before a start date either.
  assert.deepEqual(agentMark(record(10, "created_at>50"), 47003), {
    owner: null,
  });
  assert.deepEqual(agentMark(record(60, "created_at>50"), 47003), {
    owner: OWNER,
  });
});

test("conditions that are not understood are never waved through", () => {
  const at = { kind: 47003, createdAt: 100 };
  assert.equal(conditionsHold("", at), true);
  assert.equal(conditionsHold("kind=47003", at), true);
  assert.equal(
    conditionsHold("kind=47003&created_at<200&created_at>50", at),
    true,
  );
  for (const bad of [
    "kind=47003&",
    "&kind=47003",
    "kind=047003",
    "expires=never",
    "kind=47003&&created_at<200",
    "created_at<abc",
    "kind=70000",
    "Kind=47003",
  ])
    assert.equal(conditionsHold(bad, at), false, bad);
  // Every clause must hold, not any one.
  assert.equal(conditionsHold("kind=47003&created_at<100", at), false);
});

test("reading a claim checks no signature; a proof is checked once, when the offer is shown", () => {
  const update = "a".repeat(64);
  const event = (n, tags) => ({
    id: n.toString(16).padStart(64, "0"),
    pubkey: AGENT,
    created_at: 10 + n,
    content: "{}",
    tags: [["help-offer", update], ["agent", AGENT], ...tags],
  });
  // Many proofs on one record: only the first is kept, so one record costs at most one check.
  const signal = parseHelpSignal(
    event(1, [["auth", OWNER, "", "0".repeat(128)], auth(AGENT, "kind=47003")]),
  );
  assert.equal(signal.agent.says, true);
  assert.equal(signal.agent.auth.sig, "0".repeat(128));
  // Unchecked as read: the claim is data, not a verdict.
  assert.equal("owner" in signal.agent, false);
  const view = helpRequest({
    update: { id: update, help: { text: "x", size: "small", time: "" } },
    signals: [signal],
    team: new Set([OWNER]),
    viewer: OWNER,
  });
  // The first proof was the bad one: an agent, with no owner named.
  assert.deepEqual(view.offers[0].agent, { owner: null });
});

test("an offer to help from an agent says so, with who runs it", () => {
  const update = "a".repeat(64);
  const signals = [
    parseHelpSignal({
      id: "b".repeat(64),
      pubkey: AGENT,
      created_at: 10,
      content: JSON.stringify({
        title: "Offer to help",
        body: "I can test it.",
      }),
      tags: [
        ["a", `37001:${OWNER}:nebula`],
        ["e", update],
        ["help-offer", update],
        ["agent", AGENT],
        auth(AGENT, "kind=47003"),
      ],
    }),
    parseHelpSignal({
      id: "c".repeat(64),
      pubkey: pub("5".repeat(64)),
      created_at: 11,
      content: "{}",
      tags: [["help-offer", update]],
    }),
  ];
  const view = helpRequest({
    update: { id: update, help: { text: "x", size: "small", time: "" } },
    signals,
    team: new Set([OWNER]),
    viewer: OWNER,
  });
  const byAuthor = Object.fromEntries(
    view.offers.map((o) => [o.author, o.agent]),
  );
  assert.deepEqual(byAuthor[AGENT], { owner: OWNER });
  // A person's offer carries no label.
  assert.equal(byAuthor[pub("5".repeat(64))], null);
});
