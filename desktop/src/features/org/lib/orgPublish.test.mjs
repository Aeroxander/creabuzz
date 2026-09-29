import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGrantContent,
  buildGrantRevocation,
  orgNodeTags,
  withAgentSeat,
} from "./orgPublish.ts";

const ME = "a".repeat(64);
const OTHER = "b".repeat(64);
const AGENT = "c".repeat(64);

test("a new grant carries the signer as its issuer", () => {
  const body = JSON.parse(
    buildGrantContent({
      issuer: ME.toUpperCase(),
      grantee: OTHER,
      via: "root",
      verbs: ["task:create"],
    }),
  );
  assert.equal(
    body.issuer,
    ME,
    "the relay rejects a grant whose issuer is not its signer",
  );
  assert.equal(body.revoked, false);
  assert.deepEqual(body.verbs, ["task:create"]);
  assert.throws(() =>
    buildGrantContent({ issuer: "", grantee: OTHER, via: "root", verbs: [] }),
  );
});

test("revocation republishes the full grant with revoked set", () => {
  const stored = JSON.stringify({
    v: 1,
    issuer: ME,
    grantee: OTHER,
    via: "root",
    verbs: ["read:#eng"],
    expires: 1800000000,
    revoked: false,
  });
  const body = JSON.parse(buildGrantRevocation(stored, ME.toUpperCase()));
  assert.equal(body.revoked, true);
  assert.equal(body.grantee, OTHER, "fields are kept, not stubbed");
  assert.equal(body.expires, 1800000000);
  assert.deepEqual(body.verbs, ["read:#eng"]);
});

test("only the issuer can revoke, and only a complete grant", () => {
  const stored = JSON.stringify({
    v: 1,
    issuer: ME,
    grantee: OTHER,
    via: "root",
    verbs: [],
    revoked: false,
  });
  assert.throws(() => buildGrantRevocation(stored, OTHER), /issuer/);
  assert.throws(() => buildGrantRevocation("{}", ME), /issuer/);
  assert.throws(
    () => buildGrantRevocation(JSON.stringify({ issuer: ME }), ME),
    /incomplete/,
  );
  assert.throws(
    () => buildGrantRevocation("not json", ME),
    /could not be read/,
  );
});

test("seating an agent keeps holders, scope, parent and unknown fields", () => {
  const stored = JSON.stringify({
    v: 1,
    name: "Head of Story",
    kind: "agent_seat",
    parent: "root",
    holders: [OTHER],
    agentSeats: [],
    scope: { readBelow: true, assignBelow: false, canGrant: ["task:create"] },
    ui: { blurb: "hi" },
    onchain: { chain: "eip155:1", dao: "0x1", boundAt: 1 },
  });
  const next = JSON.parse(withAgentSeat(stored, AGENT.toUpperCase()));
  assert.deepEqual(next.agentSeats, [AGENT]);
  const before = JSON.parse(stored);
  for (const key of [
    "holders",
    "scope",
    "parent",
    "ui",
    "onchain",
    "name",
    "kind",
  ]) {
    assert.deepEqual(next[key], before[key], key);
  }
});

test("seating is idempotent and detaching removes only that agent", () => {
  const seated = JSON.stringify({
    name: "x",
    holders: [],
    agentSeats: [AGENT, OTHER],
  });
  assert.equal(withAgentSeat(seated, AGENT), null);
  assert.equal(withAgentSeat(seated, AGENT.toUpperCase()), null);
  const detached = JSON.parse(withAgentSeat(seated, AGENT, true));
  assert.deepEqual(detached.agentSeats, [OTHER]);
  assert.equal(withAgentSeat(JSON.stringify({ name: "x" }), AGENT, true), null);
  assert.throws(() => withAgentSeat(seated, "nope"), /64-hex/);
});

test("node tags match the SDK builder: d, name, one seat per occupant", () => {
  const tags = orgNodeTags(
    "seat-writer",
    JSON.stringify({ name: "Writer", holders: [OTHER], agentSeats: [AGENT] }),
  );
  assert.deepEqual(tags, [
    ["d", "seat-writer"],
    ["name", "Writer"],
    ["seat", OTHER],
    ["seat", AGENT],
  ]);
});
