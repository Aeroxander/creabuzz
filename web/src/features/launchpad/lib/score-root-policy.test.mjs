import assert from "node:assert/strict";
import test from "node:test";

import {
  acceptedPublisherPolicy,
  safeProofUrl,
  standingOf,
} from "./score-root-policy.ts";

const RELAY = "ws://localhost:3000/ws";

const PUBLISHER_A = "a".repeat(64);
const PUBLISHER_B = "b".repeat(64);

const config = (value) =>
  acceptedPublisherPolicy({
    relayUrl: RELAY,
    env: { VITE_SCORE_ROOT_PUBLISHERS: value },
  });

test("a policy names the community, its accepted publishers and its programs", () => {
  const policy = config(
    JSON.stringify({ "localhost:3000": { publishers: [PUBLISHER_A] } }),
  );
  assert.notEqual(policy, null);
  assert.equal(policy.community, "localhost:3000");
  assert.deepEqual(policy.publishers, [PUBLISHER_A]);
  // With no program list, only the default member-score program is accepted.
  assert.deepEqual(policy.programs, ["trustgraphs.output.nostr-member.v1"]);
});

test("the host key selects the community: a different server gets no policy", () => {
  assert.equal(
    config(JSON.stringify({ "other.example": { publishers: [PUBLISHER_A] } })),
    null,
  );
});

test("malformed or partial config is no policy, never a half-accepted key", () => {
  assert.equal(config("not json"), null);
  assert.equal(config(JSON.stringify([])), null);
  assert.equal(config(JSON.stringify({ "localhost:3000": null })), null);
  assert.equal(
    config(JSON.stringify({ "localhost:3000": { publishers: [] } })),
    null,
  );
  assert.equal(
    config(JSON.stringify({ "localhost:3000": { publishers: ["0xzz"] } })),
    null,
  );
  assert.equal(
    config(
      JSON.stringify({
        "localhost:3000": { publishers: [PUBLISHER_A], programs: [] },
      }),
    ),
    null,
  );
});

test("an explicit program list is what is accepted", () => {
  const policy = config(
    JSON.stringify({
      "localhost:3000": { publishers: [PUBLISHER_A], programs: ["x.v2"] },
    }),
  );
  assert.deepEqual(policy?.programs, ["x.v2"]);
  assert.equal(
    standingOf({ author: PUBLISHER_A, program: "x.v2" }, policy),
    "accepted",
  );
  assert.equal(
    standingOf(
      { author: PUBLISHER_A, program: "trustgraphs.output.nostr-member.v1" },
      policy,
    ),
    "publisher-claim",
  );
});

test("with no policy nothing is accepted: roots stay publisher claims", () => {
  assert.equal(
    standingOf(
      { author: PUBLISHER_A, program: "trustgraphs.output.nostr-member.v1" },
      null,
    ),
    "publisher-claim",
  );
});

test("only the policy's keys and programs stand as accepted", () => {
  const policy = config(
    JSON.stringify({
      "localhost:3000": {
        publishers: [PUBLISHER_A, PUBLISHER_B],
        programs: ["trustgraphs.output.nostr-member.v1", "other.v1"],
      },
    }),
  );
  const root = {
    author: PUBLISHER_A.toUpperCase(),
    program: "other.v1",
  };
  assert.equal(standingOf(root, policy), "accepted");
  root.author = "c".repeat(64);
  assert.equal(standingOf(root, policy), "publisher-claim");
});

test("proof pointers allow only browser-safe origins", () => {
  const local = "http://localhost:8080/proofs.json";
  const pol = config(
    JSON.stringify({ "localhost:3000": { publishers: [PUBLISHER_A] } }),
  );
  assert.notEqual(pol, null);
  assert.equal(
    safeProofUrl("https://idx.example.com/proofs.json"),
    "https://idx.example.com/proofs.json",
  );
  assert.equal(safeProofUrl(local), local);
  assert.equal(safeProofUrl("http://idx.example.com/proofs.json"), null);
  assert.equal(safeProofUrl("javascript:alert(1)"), null);
  assert.equal(safeProofUrl("data:text/html,x"), null);
  assert.equal(safeProofUrl("file:///etc/hosts"), null);
  assert.equal(safeProofUrl("  "), null);
});
