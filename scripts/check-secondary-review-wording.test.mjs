// Docs consistency guard for the secondary-trading review status.
//
// The agent review pass is an internal pass, not an outside or independent
// audit, and "off by default" describes where the listing starts and which
// builds name a factory, not a check the software makes for a sign-off.
// Packet section 6 item 1 stays the single source of truth for the audit
// status. Run with: node --test scripts/check-secondary-review-wording.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const dir = new URL("../docs/v3-review/", import.meta.url);
const read = (name) => readFileSync(new URL(name, dir), "utf8");
const packet = read("SECONDARY-TRADING-REVIEW.md");
const runbook = read("SECONDARY-TRADING-RUNBOOK.md");
const v5 = read("V5-IMPLEMENTATION.md");

test("the first review is named as an internal agent pass, not an outside audit", () => {
  assert.match(
    packet,
    /^## 10\. First review \(internal agent pass, not an outside audit\)/m,
  );
  assert.match(
    v5,
    /^### First review \(internal agent pass, not an outside audit\): three defects, fixed/m,
  );
  for (const [name, text] of [
    ["packet", packet],
    ["v5", v5],
  ]) {
    assert.match(
      text,
      /An agent review pass read `SecondaryMarket\.sol`/,
      name,
    );
    assert.doesNotMatch(
      text,
      /An outside reviewer read `SecondaryMarket\.sol`/,
      name,
    );
  }
});

test("the runbook does not say an independent review has happened", () => {
  assert.doesNotMatch(runbook, /first independent review has happened/i);
  assert.doesNotMatch(runbook, /One independent review has read/i);
  assert.match(runbook, /no independent human audit has happened/i);
});

test("off by default is described as a release gate owned by people", () => {
  assert.doesNotMatch(runbook, /stays off without this/);
  assert.doesNotMatch(
    packet,
    /Trading activation stays off\s+until that sign-off exists/,
  );
  for (const [name, text] of [
    ["packet", packet],
    ["runbook", runbook],
  ]) {
    assert.match(
      text,
      /nothing in the software checks for (a|the)\s+sign-off/i,
      name,
    );
  }
});

// ---- Factual alignment with the code (founder schedule, gas, section 6, vocabulary) ----------------------------------

const root = new URL("../", import.meta.url);
const readRoot = (path) => readFileSync(new URL(path, root), "utf8");
const prBody = read("PR-BODY.md");
const spec = read("SECONDARY-LISTING-SPEC.md");
const chainConfig = readRoot("web/src/features/launchpad/chain-config.ts");
const envExample = readRoot(".env.example");
const activationVoting = readRoot("contracts/src/ActivationVoting.sol");
// Collapse whitespace, and the comment markers ("*" in a doc comment, "#" in .env.example) that wrap a sentence.
const flat = (text) => text.replace(/^\s*(\*|#)\s?/gm, "").replace(/\s+/g, " ");
/** The text of one numbered "## N." section of a document, up to the next "## " heading. */
const section = (text, n) => {
  const m = text.match(
    new RegExp(`^## ${n}\\. [\\s\\S]*?(?=^## |(?![\\s\\S]))`, "m"),
  );
  assert.ok(m, `section ${n} exists`);
  return m[0];
};

test("the code the schedule wording rests on: only the founder is reduced, other holders get their balance", () => {
  // If this changes, every sentence below about who the schedule constrains is wrong and must change with it.
  assert.match(
    activationVoting,
    /if \(holder != founder \|\| !configured\) return bal;/,
    "saleCapacity returns the plain balance for every non-founder",
  );
});

test("a listing vote is the only deliberate act, and the founder schedule limits only the founder", () => {
  const stale = [
    /two independent acts/i,
    /two separate acts/i,
    /independent acts/i,
    /two deliberate DAO\s+acts/i,
    /Neither happens by default/i,
    /must have released units before\s+anything is sellable/i,
    /and the founder's schedule has\s+released units/i,
    /sells\s+nothing until the DAO publishes a listing and/i,
  ];
  for (const [name, text] of [
    ["packet", packet],
    ["runbook", runbook],
    ["pr body", prBody],
    ["v5 ledger", v5],
    ["chain-config.ts", chainConfig],
    [".env.example", envExample],
  ]) {
    for (const re of stale)
      assert.doesNotMatch(text, re, `${name} still says ${re}`);
  }
  // The packet's section 9 and section 4 now say the same thing as the runbook's qualification paragraph.
  assert.match(
    flat(section(packet, 9)),
    /one deliberate DAO act \(the listing vote\)/,
  );
  for (const [name, text] of [
    ["packet section 4", section(packet, 4)],
    ["runbook", runbook],
  ]) {
    assert.match(
      flat(text),
      /the schedule constrains the founder and only the founder/,
      name,
    );
    assert.match(
      flat(text),
      /may offer their own Shares as soon as a listing exists/,
      name,
    );
  }
  // The "nothing sellable yet" table rows are true of the founder only, and say so.
  assert.doesNotMatch(packet, /\| nothing sellable yet \|/);
  assert.match(flat(section(packet, 4)), /true of the founder only/);
  // The two places that carry the wording into the product say who is constrained.
  for (const [name, text] of [
    ["chain-config.ts", chainConfig],
    [".env.example", envExample],
  ]) {
    assert.match(flat(text), /only the founder's own sales/, name);
  }
});

const gasRows = (text) =>
  text.split("\n").filter((line) => /^\| (Typical|Five|Eight)/.test(line));
const settleColumn = (row) => row.split("|")[2].replace(/\*/g, "").trim();

test("the gas text states the settle that fits one transaction, in the packet and the runbook alike", () => {
  const expected = ["2.40M", "2.97M", "2.88M", "3.58M", "3.15M"];
  const packetRows = gasRows(packet);
  const runbookRows = gasRows(runbook);
  assert.equal(packetRows.length, 5, "packet gas table has its five shapes");
  assert.equal(runbookRows.length, 5, "runbook gas table has its five shapes");
  assert.deepEqual(packetRows.map(settleColumn), expected);
  assert.deepEqual(runbookRows.map(settleColumn), expected);
  for (const row of packetRows.concat(runbookRows)) {
    assert.doesNotMatch(
      row,
      /\b(11\.29|17\.48|14\.45|20\.87|18\.86)M\b/,
      "no pre-fix figure in a current table",
    );
  }
  assert.doesNotMatch(flat(section(packet, 6)), /exceed a 2\^24/);
  assert.doesNotMatch(packet, /exceeds the 2\^24 per-transaction cap/);
  assert.doesNotMatch(packet, /see the options in the batch report/);
  assert.doesNotMatch(flat(v5), /its open `MAX_ACTIVE_SELLERS` decision/);
});

test("the runbook no longer says the real policy is unmeasured or that the composition is unattacked", () => {
  assert.doesNotMatch(runbook, /unmeasured/i);
  assert.doesNotMatch(runbook, /about \*\*2\.63M gas with a mock/);
  assert.doesNotMatch(runbook, /have no adversarial\s+coverage/);
  assert.doesNotMatch(runbook, /Nobody has attacked the composition/);
  assert.doesNotMatch(runbook, /prefer smaller rounds/i);
  const open = flat(
    runbook.slice(runbook.indexOf("### Still open after the first review")),
  );
  assert.match(open, /SecondaryMarketAdversaryReal/);
  assert.match(open, /before settle stopped returning unsold Shares/i);
  assert.match(open, /could not be mined/);
  assert.match(
    open,
    /void rounds refund by claim|every seller's Shares and every buyer's quote come back by claim/,
  );
});

test("settle is described as moving no Shares; the unsold remainder is a claim", () => {
  assert.doesNotMatch(
    flat(runbook),
    /returned to the seller inside the settle transaction/,
  );
  assert.doesNotMatch(
    flat(runbook),
    /come back on their own — in the settle transaction/,
  );
  assert.doesNotMatch(
    flat(runbook),
    /unsold-lot return inside `settle` reads the listing/,
  );
  assert.match(flat(runbook), /`settle` moves no Shares/);
  assert.match(
    flat(runbook),
    /a seller's unsold Shares: `claimShares\(id, seller\)`/,
  );
});

test("section 6 of the packet records the design limits and open product decisions", () => {
  const s6 = flat(section(packet, 6));
  assert.match(s6, /33rd buyer/);
  assert.match(s6, /TooManyBuyers/);
  assert.match(s6, /move the price and then be pulled/);
  assert.match(s6, /size inflation/i);
  assert.match(s6, /pro.rata/i);
  assert.match(s6, /squatting/i);
  assert.match(s6, /TooManySellers/);
  assert.match(s6, /open product decision/i);
  // F4's "now recorded in section 6" is true.
  assert.match(flat(packet), /they are recorded in §6/);
});

test("Shares not yet released for sale, never unvested, and exit is still always allowed", () => {
  for (const [name, text] of [
    ["packet", packet],
    ["runbook", runbook],
  ]) {
    assert.doesNotMatch(text, /unvested/i, name);
    assert.match(flat(text), /Shares not yet released for sale/, name);
    assert.match(flat(text), /exits? (is|are) always allowed/i, name);
  }
  assert.match(spec, /sale eligibility, not\s+conventional financial vesting/);
});
