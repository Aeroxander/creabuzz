import assert from "node:assert/strict";
import test from "node:test";

import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

import { agentLabel, agentMark } from "./agent-label.ts";
import { parseHelpSignal } from "./help-request.ts";

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
  assert.equal(agentMark({ pubkey: OWNER, tags: [["a", "x"]] }), null);
});

test("an agent that proves who runs it is labelled with its owner", () => {
  const record = {
    pubkey: AGENT,
    tags: [["agent", AGENT], auth(AGENT, "kind=47003")],
  };
  assert.deepEqual(agentMark(record, 47003), { owner: OWNER });
  assert.equal(agentLabel("Sam"), "Agent, run by Sam");
});

test("a proof made for another account, another kind, or by nobody names no owner", () => {
  // Signed for a different agent key: it does not vouch for this account.
  const other = pub("3".repeat(64));
  assert.deepEqual(
    agentMark({ pubkey: AGENT, tags: [["agent", AGENT], auth(other, "")] }),
    { owner: null },
  );
  // The owner allowed another kind of record only.
  assert.deepEqual(
    agentMark(
      { pubkey: AGENT, tags: [["agent", AGENT], auth(AGENT, "kind=37001")] },
      47003,
    ),
    { owner: null },
  );
  // A made-up signature.
  assert.deepEqual(
    agentMark({
      pubkey: AGENT,
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
  assert.deepEqual(agentMark({ pubkey: AGENT, tags: [auth(AGENT, "")] }), {
    owner: OWNER,
  });
  assert.equal(agentMark({ pubkey: OWNER, tags: [["agent", AGENT]] }), null);
  // An account cannot be its own owner.
  assert.equal(
    agentMark({ pubkey: OWNER, tags: [auth(OWNER, "", OWNER_KEY)] }),
    null,
  );
});

test("an offer to help from an agent says so, with who runs it", () => {
  const update = "a".repeat(64);
  const offer = parseHelpSignal({
    id: "b".repeat(64),
    pubkey: AGENT,
    created_at: 10,
    content: JSON.stringify({ title: "Offer to help", body: "I can test it." }),
    tags: [
      ["a", `37001:${OWNER}:nebula`],
      ["e", update],
      ["help-offer", update],
      ["agent", AGENT],
      auth(AGENT, "kind=47003"),
    ],
  });
  assert.deepEqual(offer.agent, { owner: OWNER });
  const fromPerson = parseHelpSignal({
    id: "c".repeat(64),
    pubkey: OWNER,
    created_at: 10,
    content: "{}",
    tags: [["help-offer", update]],
  });
  assert.equal(fromPerson.agent, null);
});
