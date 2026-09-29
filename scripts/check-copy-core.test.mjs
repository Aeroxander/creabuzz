import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import { findCopyViolations } from "./check-copy-core.mjs";

// The scanner takes the compiler as an argument; borrow the web app's copy.
const require = createRequire(new URL("../web/package.json", import.meta.url));
const ts = require("typescript");

const scan = (text, name = "x.tsx") =>
  findCopyViolations(ts, name, text).map((v) => v.rule);

test("flags citations and protocol internals in user-visible strings", () => {
  assert.deepEqual(scan('const a = "Failure modes (WEF five)";'), ["citation"]);
  assert.deepEqual(scan("const b = <h4>Thrash vs work (Cursor)</h4>;"), [
    "citation",
  ]);
  assert.deepEqual(scan('throw new Error("see GraduationExecutor.sol:86");'), [
    "contract-source",
  ]);
  assert.deepEqual(scan("const c = `publishes kind:37010 ${x}`;"), [
    "event-kind",
  ]);
  assert.deepEqual(scan('const d = "install a NIP-07 extension";'), [
    "nip-number",
  ]);
  assert.deepEqual(scan('const e = "value is below the Q96 minimum";'), [
    "fixed-point",
  ]);
  assert.deepEqual(scan('const f = "open /identity-demo first";'), [
    "demo-route",
  ]);
});

test("ignores comments, identifiers, imports and console logs", () => {
  assert.deepEqual(
    scan(`
      // kind:37010 comes from GraduationExecutor.sol:86 (WEF, NIP-29)
      /* Q96 math */
      import { KIND_37010 } from "./nip-29";
      const KIND_ORG_NODE = 37010;
      console.error("kind:37010 failed", err);
    `),
    [],
  );
});

test("plain copy passes", () => {
  assert.deepEqual(
    scan('const ok = <p>Health checks: churn vs progress this week.</p>;'),
    [],
  );
});
