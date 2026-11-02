import assert from "node:assert/strict";
import test from "node:test";
import { finalizeEvent, generateSecretKey } from "nostr-tools";

import {
  acceptedPublisherPolicy,
  collectScoreRoots,
  safeProofUrl,
  scoreRootsQueryScope,
  standingOf,
  verifySignedEvent,
} from "./score-root-policy.ts";

const RELAY = "ws://localhost:3000/ws";
const REMOTE_RELAY = "wss://score.example.com/ws";
const PROGRAM = "trustgraphs.output.nostr-member.v1";
const KIND = 37006;
const ROOT_HEX = `0x${"11".repeat(32)}`;

const config = (value) =>
  acceptedPublisherPolicy({
    relayUrl: RELAY,
    env: { VITE_SCORE_ROOT_PUBLISHERS: value },
  });

/** A real, signed score-root record from `secretKey`, with its content's fields. */
const signedRoot = (
  secretKey,
  {
    coordinate = `${PROGRAM}:12`,
    root = ROOT_HEX,
    epoch = "12",
    created_at = 300,
    anchorBlock = null,
    indexerUrl = null,
  } = {},
) => {
  const tags = [["d", coordinate]];
  const content = JSON.stringify({
    ...(anchorBlock !== null ? { anchorBlock } : {}),
    epoch,
    ...(indexerUrl ? { indexerUrl } : {}),
    program: coordinate.split(":")[0],
    root,
  });
  return finalizeEvent(
    { kind: KIND, created_at, tags, content },
    secretKey ?? generateSecretKey(),
  );
};

const policyFor = (event) => {
  const stringish = JSON.stringify({
    "localhost:3000": { publishers: [event.pubkey] },
  });
  return config(stringish);
};

const collect = (relayUrl, policy, events) =>
  collectScoreRoots({
    relayUrl,
    policy,
    kind: KIND,
    query: async () => events,
  });

test("a policy names the community, its accepted publishers and its programs", () => {
  const keys = generateSecretKey();
  const event = signedRoot(keys);
  const policy = policyFor(event);
  assert.equal(policy.community, "localhost:3000");
  assert.deepEqual(policy.publishers, [event.pubkey]);
  // With no program list, only the default member-score program is accepted.
  assert.deepEqual(policy.programs, [PROGRAM]);
});

test("the host key selects the community: a different server gets no policy", () => {
  assert.equal(
    config(
      JSON.stringify({ "other.example": { publishers: ["a".repeat(64)] } }),
    ),
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
        "localhost:3000": { publishers: ["a".repeat(64)], programs: [] },
      }),
    ),
    null,
  );
});

test("with no policy nothing is accepted: roots stay publisher claims", () => {
  const event = signedRoot(generateSecretKey());
  assert.equal(
    standingOf({ author: event.pubkey, program: PROGRAM }, null),
    "publisher-claim",
  );
  assert.equal(
    standingOf({ author: "b".repeat(64), program: PROGRAM }, policyFor(event)),
    "publisher-claim",
  );
});

test("an explicit program list is what is accepted", () => {
  const policy = config(
    JSON.stringify({
      "localhost:3000": { publishers: ["a".repeat(64)], programs: ["x.v2"] },
    }),
  );
  assert.deepEqual(policy?.programs, ["x.v2"]);
  assert.equal(
    standingOf({ author: "a".repeat(64), program: "x.v2" }, policy),
    "accepted",
  );
  assert.equal(
    standingOf({ author: "a".repeat(64), program: PROGRAM }, policy),
    "publisher-claim",
  );
});

test("a forged root naming an accepted publisher is refused; a real signed one passes", () => {
  const keys = generateSecretKey();
  const real = signedRoot(keys, { indexerUrl: "https://idx.example.com" });
  const policy = policyFor(real);
  // A server answering with the real bytes sees them verified.
  assert.equal(verifySignedEvent(real), true);
  return collect(RELAY, policy, [real])
    .then((roots) => {
      assert.equal(roots.length, 1);
      assert.equal(roots[0].author, real.pubkey);
      assert.equal(roots[0].standing, "accepted");
      assert.equal(roots[0].root, ROOT_HEX);
    })
    .then(() => {
      // The query surface does not check signatures, so this is what a hostile
      // answer looks like: the same shape, the accepted publisher's key — but
      // bytes this key never signed (the content was flipped after signing).
      const forged = JSON.parse(JSON.stringify(signedRoot(keys)));
      forged.content = JSON.stringify({
        program: PROGRAM,
        root: `0x${"22".repeat(32)}`,
        epoch: "12",
      });
      assert.equal(verifySignedEvent(forged), false);
      // And a record whose pubkey is swapped to the accepted key, keeping the
      // original signature: verified against the bytes, it fails too.
      const impersonated = JSON.parse(
        JSON.stringify(signedRoot(generateSecretKey())),
      );
      impersonated.pubkey = real.pubkey;
      assert.equal(verifySignedEvent(impersonated), false);
      return collect(RELAY, policy, [forged, impersonated]).then((roots) => {
        assert.deepEqual(roots, []);
      });
    });
});

test("broken shapes are never a crash and never a pass", () => {
  assert.equal(verifySignedEvent(null), false);
  assert.equal(verifySignedEvent("x"), false);
  assert.equal(verifySignedEvent({ id: 5, pubkey: "a", sig: "b" }), false);
  const partial = JSON.parse(JSON.stringify(signedRoot(generateSecretKey())));
  delete partial.sig;
  assert.equal(verifySignedEvent(partial), false);
});

test("the query names the accepted publishers only while a policy stands", () => {
  const asked = [];
  const keys = generateSecretKey();
  const real = signedRoot(keys);
  const policy = policyFor(real);
  const capture = async (filter) => {
    asked.push(filter);
    return [];
  };
  return collectScoreRoots({
    relayUrl: RELAY,
    policy,
    kind: KIND,
    query: capture,
  }).then(() => {
    assert.deepEqual(asked[0].authors, [real.pubkey]);
    return collectScoreRoots({
      relayUrl: RELAY,
      policy: null,
      kind: KIND,
      query: capture,
    }).then(() => {
      assert.equal(asked[1].authors, undefined);
    });
  });
});

test("the cache scope separates communities and policies, and is order-stable", () => {
  const keys = generateSecretKey();
  const event = signedRoot(keys);
  const policy = policyFor(event);
  const same = JSON.stringify({
    "localhost:3000": {
      publishers: [...policy.publishers].reverse(),
      programs: [...policy.programs],
    },
  });
  const other = config(
    JSON.stringify({
      "localhost:3000": { publishers: [event.pubkey], programs: ["other.v1"] },
    }),
  );
  assert.equal(
    scoreRootsQueryScope(RELAY, policy),
    scoreRootsQueryScope(RELAY, config(same)),
  );
  assert.notEqual(
    scoreRootsQueryScope(RELAY, policy),
    scoreRootsQueryScope(RELAY, other),
  );
  assert.notEqual(
    scoreRootsQueryScope(RELAY, policy),
    scoreRootsQueryScope(REMOTE_RELAY, policy),
  );
  assert.equal(scoreRootsQueryScope(RELAY, null), "localhost:3000:no-policy");
  assert.notEqual(
    scoreRootsQueryScope(RELAY, policy),
    scoreRootsQueryScope(RELAY, null),
  );
});

test("two publishers signing the same coordinate stay distinct root records", () => {
  const keyA = generateSecretKey();
  const keyB = generateSecretKey();
  const a = signedRoot(keyA, { created_at: 200 });
  // Same d tag (program:epoch), different signer, later — a replacement attempt by another key.
  const b = signedRoot(keyB, { created_at: 400, root: `0x${"22".repeat(32)}` });
  return collect(RELAY, null, [b, a]).then((roots) => {
    assert.equal(roots.length, 2);
    assert.equal(roots[0].id, b.id);
    assert.equal(roots[1].id, a.id);
    assert.notEqual(roots[0].id, roots[1].id);
    // The ids are the signed records', not the shared coordinate.
    assert.notEqual(roots[0].id, `${PROGRAM}:12`);
    assert.notEqual(roots[1].id, `${PROGRAM}:12`);
    assert.equal(roots[0].coordinate, `${PROGRAM}:${roots[0].epoch}`);
    assert.equal(roots[0].coordinate, roots[1].coordinate);
  });
});

test("the anchor block stays the record's own claim, never marked verified", () => {
  const keyA = generateSecretKey();
  const claimed = signedRoot(keyA, { anchorBlock: 500 });
  const silent = signedRoot(keyA, { anchorBlock: null });
  return collect(RELAY, policyFor(claimed), [claimed, silent]).then((roots) => {
    const withClaim = roots.find((r) => r.id === claimed.id);
    const without = roots.find((r) => r.id === silent.id);
    assert.equal(withClaim?.anchorBlock, 500);
    assert.equal(without?.anchorBlock, null);
    // Nothing here fabricated a checked anchor: the number is the record's
    // own assertion, and no field of the row claims more than that.
    for (const root of roots) {
      assert.ok(!("anchorVerified" in root));
    }
  });
});

test("proof pointers allow only browser-safe origins on the community's own machine", () => {
  const pol = config(
    JSON.stringify({ "localhost:3000": { publishers: ["a".repeat(64)] } }),
  );
  assert.notEqual(pol, null);
  // https from any host: the scheme filter is not containment, the pointer
  // still only leads somewhere when a person asks for the proofs.
  assert.equal(
    safeProofUrl("https://idx.example.com/proofs.json", RELAY),
    "https://idx.example.com/proofs.json",
  );
  // Local http is a development convenience, only for a community that is
  // itself local — a remote record naming this visitor's localhost is refused.
  assert.equal(
    safeProofUrl("http://localhost:8080/proofs.json", RELAY),
    "http://localhost:8080/proofs.json",
  );
  assert.equal(
    safeProofUrl("http://localhost:8080/proofs.json", REMOTE_RELAY),
    null,
  );
  assert.equal(
    safeProofUrl("http://127.0.0.1:8080/proofs.json", REMOTE_RELAY),
    null,
  );
  // Embedded credentials are a credential box, not a proofs pointer.
  assert.equal(
    safeProofUrl("https://user:secret@idx.example.com/proofs.json", RELAY),
    null,
  );
  assert.equal(
    safeProofUrl("https://user@idx.example.com/proofs.json", RELAY),
    null,
  );
  // Pretend schemes go nowhere.
  assert.equal(safeProofUrl("javascript:alert(1)", RELAY), null);
  assert.equal(safeProofUrl("data:text/html,x", RELAY), null);
  assert.equal(safeProofUrl("file:///etc/hosts", RELAY), null);
  assert.equal(safeProofUrl("ws://idx.example.com", REMOTE_RELAY), null);
  assert.equal(safeProofUrl("  ", RELAY), null);
  assert.equal(safeProofUrl(null, RELAY), null);
});
