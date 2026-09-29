// Registry drift guard: the web constants mirror crates/buzz-core/src/kind.rs.
// Run with: node --experimental-strip-types --test src/shared/constants/kinds.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import * as kindsNamespace from "./kinds.ts";

// A plain copy, so lookups by computed name are not dynamic namespace access.
const kinds = { ...kindsNamespace };

const RUST = readFileSync(
  new URL("../../../../crates/buzz-core/src/kind.rs", import.meta.url),
  "utf8",
);
const rustKinds = new Map(
  [...RUST.matchAll(/pub const (KIND_[A-Z0-9_]+): u32 = (\d+);/g)].map(
    (match) => [match[1], Number(match[2])],
  ),
);

const FORK_KINDS = [
  "KIND_ORG_NODE",
  "KIND_ORG_GRANT",
  "KIND_ORG_BUDGET",
  "KIND_CONTRIBUTION_RECORD",
  "KIND_BUDGET_SPEND_RECEIPT",
  "KIND_ORG_PITCH",
  "KIND_ORG_JOIN_REQUEST",
  "KIND_EVM_BINDING",
  "KIND_DEPLOYMENT_RECORD",
  "KIND_AUDIT_ENTRY",
  "KIND_SKILL",
  "KIND_WIKI_PAGE",
  "KIND_AGENT_WIKI_PAGE",
  "KIND_AGENT_CAPABILITIES",
];

test("the fork's kinds are exported and equal the Rust registry", () => {
  for (const name of FORK_KINDS) {
    assert.ok(rustKinds.has(name), `${name} is not in the Rust registry`);
    assert.equal(kinds[name], rustKinds.get(name), name);
  }
});

test("every constant that reuses a registry name reuses its number", () => {
  let compared = 0;
  for (const [name, value] of Object.entries(kinds)) {
    if (!name.startsWith("KIND_") || typeof value !== "number") continue;
    if (!rustKinds.has(name)) continue;
    compared += 1;
    assert.equal(value, rustKinds.get(name), name);
  }
  assert.ok(compared >= 20, `only ${compared} constants were compared`);
});

test("the org kinds are described as community-level, not `h`-scoped", () => {
  const source = readFileSync(new URL("./kinds.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /h = community/);
});

test("the binding kind used by projects is the shared constant", () => {
  const bindings = readFileSync(
    new URL("../../features/projects/lib/bindings.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(bindings, /KIND_EVM_BINDING\s*=\s*37017/);
  assert.match(bindings, /shared\/constants\/kinds/);
});
