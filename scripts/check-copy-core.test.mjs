import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import { findCopyViolations } from "./check-copy-core.mjs";

// The scanner takes the compiler as an argument; borrow the app's copy.
const require = createRequire(new URL("../app/package.json", import.meta.url));
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
  assert.deepEqual(scan("const g = <p>Your Nostr account changed.</p>;"), [
    "plain-words",
  ]);
  assert.deepEqual(scan('const h = "Also share on public Nostr";'), [
    "plain-words",
  ]);
  assert.deepEqual(scan('const i = "0x12…ab (no explorer on this chain)";'), [
    "plain-words",
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

test("no-earn-shares: flags earn next to Shares, either order, in any string form", () => {
  for (const text of [
    '"Shares earned here are test records."',
    '"To earn Shares, take the work on the Work tab."',
    '"Take back a team member\'s unearned Shares."',
    '"Who earns the Shares"',
    '"Shares held in a round don\'t earn payouts."',
    "`Set up a project where work can earn Shares, which are votes.`",
  ])
    assert.deepEqual(scan(`const a = ${text};`), ["no-earn-shares"], text);
  // JSX text wrapped over lines is one string.
  assert.deepEqual(
    scan(`const b = (
      <p>
        Each role's person can earn
        Shares for reviewed work.
      </p>
    );`),
    ["no-earn-shares"],
  );
});

test("no-earn-shares: leaves awarded Shares, other earn words and the ownership-only sentence alone", () => {
  for (const text of [
    '"Shares are awarded for accepted work."',
    '"Learn how Shares work."',
    '"Tasks here give no points."',
    '"Earns 10 points for the task."',
    // Far apart: more than 40 characters between the words.
    '"The project earns money from its many customers all over the world, and Shares are separate."',
    // Legal sentence, kept exactly: "revenue share" is not "Shares".
    '"Buyers acquire ownership only: governance and exit. No dividends or revenue share, ever, unless they contribute and earn one."',
  ])
    assert.deepEqual(scan(`const a = ${text};`), [], text);
});

test("no-earn-shares: ignores comments and identifiers", () => {
  assert.deepEqual(
    scan(`
      // Who earned the Shares
      const { earned, totalShares } = snapshot;
    `),
    [],
  );
});
