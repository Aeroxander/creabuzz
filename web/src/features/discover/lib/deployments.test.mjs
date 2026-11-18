// kind:37018 deployment records — the parse rule the Discover DAO section
// consumes, including the line it will not cross (a deployment documents a
// contract; a DAO address comes from a kind:47005 summon receipt only).
//
// The expectations below mirror the wire contract in
// `crates/buzz-core/src/kind.rs` `KIND_DEPLOYMENT_RECORD`.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { KIND_DEPLOYMENT, parseDeployment } from "./deployments.ts";

const FOUNDER = "f".repeat(64);
const CONTRACT = `0x${"22".repeat(20)}`;
const TX = `0x${"c".repeat(64)}`;

function record({
  d = "11155111:summoner",
  chain = "11155111",
  role = "summoner",
  address = CONTRACT,
  tx = TX,
  drop = [],
  content = {},
  kind = KIND_DEPLOYMENT,
} = {}) {
  const tags = [];
  if (!drop.includes("d")) tags.push(["d", d]);
  if (!drop.includes("chain")) tags.push(["chain", chain]);
  if (!drop.includes("role")) tags.push(["role", role]);
  if (!drop.includes("address")) tags.push(["address", address]);
  if (tx && !drop.includes("tx")) tags.push(["tx", tx]);
  return {
    id: "e1",
    kind,
    pubkey: FOUNDER,
    created_at: 1_400,
    tags,
    content: JSON.stringify({ v: 1, block: 42, project: "orion", ...content }),
    sig: "sig",
  };
}

describe("parseDeployment", () => {
  it("parses the contract's full field set", () => {
    const parsed = parseDeployment(record());
    assert.ok(parsed);
    assert.equal(parsed.chainId, "11155111");
    assert.equal(parsed.role, "summoner");
    assert.equal(parsed.address, CONTRACT);
    assert.equal(parsed.tx, TX);
    assert.equal(parsed.block, 42);
    assert.equal(parsed.project, "orion");
    assert.equal(parsed.createdAt, 1_400);
  });

  it("refuses anything that is not a kind:37018 record", () => {
    assert.equal(parseDeployment(record({ kind: 37017 })), null);
  });

  it("refuses a record without a `d` coordinate", () => {
    assert.equal(parseDeployment(record({ drop: ["d"] })), null);
  });

  it("falls back to the `d` coordinate when a tag is absent", () => {
    const parsed = parseDeployment(record({ drop: ["chain", "role"] }));
    assert.equal(parsed?.chainId, "11155111");
    assert.equal(parsed?.role, "summoner");
  });

  it("refuses a coordinate that contradicts its own tags", () => {
    assert.equal(
      parseDeployment(record({ d: "8453:summoner" })),
      null,
      "chain",
    );
    assert.equal(
      parseDeployment(record({ d: "11155111:factory" })),
      null,
      "role",
    );
    assert.equal(
      parseDeployment(record({ d: "nonsense" })),
      null,
      "unparseable",
    );
  });

  it("refuses a role outside the contract's three", () => {
    assert.equal(
      parseDeployment(record({ d: "11155111:treasury", role: "treasury" })),
      null,
      "an unknown role would mean an unknown contract",
    );
    assert.ok(
      parseDeployment(record({ d: "11155111:factory", role: "factory" })),
      "factory is one",
    );
    assert.ok(
      parseDeployment(
        record({ d: "11155111:implementation", role: "implementation" }),
      ),
      "implementation is one",
    );
  });

  it("refuses an unusable address tag", () => {
    assert.equal(parseDeployment(record({ address: "0xnope" })), null);
    assert.equal(parseDeployment(record({ drop: ["address"] })), null);
  });

  it("refuses a missing or malformed deployment tx", () => {
    assert.equal(parseDeployment(record({ drop: ["tx"] })), null);
    assert.equal(parseDeployment(record({ tx: "0xdeadbeef" })), null);
    assert.ok(parseDeployment(record()), "a 32-byte tx parses");
  });

  it("carries an unusable project slug as null rather than trusting it", () => {
    const bad = parseDeployment(record({ content: { project: "Orion!" } }));
    assert.equal(bad?.project, null, "counted as unlinked, not listed");
    assert.equal(
      parseDeployment(record({ content: { project: undefined } }))?.project,
      null,
      "an absent project is a fact, not a failure",
    );
  });

  it("never reads a dao address out of a deployment — the contract has none", () => {
    const parsed = parseDeployment(record({ content: { dao: "0xdead" } }));
    assert.ok(parsed);
    assert.equal("dao" in parsed, false, "no such field on kind:37018");
    assert.equal(parsed.address, CONTRACT, "the address is the contract's");
  });
});
