// Org money plane — budgets (37012), spend receipts (37014), allowance reads,
// and the DAO binding the ragequit surface exits.
//
// Derivation (hermit env: `. ./bin/activate-hermit`, `cast 1.4.3-stable`):
//
//   cast sig 'allowanceOf(bytes32,address,uint64)' -> 0x90f42eed
//   cast sig 'spentOf(bytes32,address,uint64)'     -> 0x5f85ed9c
//   cast sig 'remainingOf(bytes32,address,uint64)' -> 0xb529bdc5
//   cast sig 'spenderOf(bytes32)'                  -> 0x6a986708
//
// The window→epoch mapping binds `crates/buzz-evm-allowance/src/epoch.rs:26-36`
// (all-time→0; day→unix/86400; week→unix/604800; month→unix/2592000 fixed
// 30-day months). The budget/spend content shapes bind `docs/nips/NIP-ORG.md`
// (37012 :180-192, 37014 :379-412); the binding record binds
// `crates/buzz-cli/src/commands/org.rs:889-896`.
import assert from "node:assert/strict";
import test from "node:test";

import {
  budgetEpoch,
  buildAllowanceReads,
  parseOrgBinding,
  parseOrgBudget,
  parseSpendReceipt,
  resolveDaoBinding,
  SELECTOR_ALLOWANCE_OF,
  SELECTOR_REMAINING_OF,
  SELECTOR_SPENT_OF,
  SELECTOR_SPENDER_OF,
} from "./org-money.ts";

const ROOT_ID = "f".repeat(64);
const DAO = `0x${"da".repeat(20)}`;
const CONTRACT = `0x${"c0".repeat(20)}`;
const AGENT = "9".repeat(64);

function orgEvent(kind, id, content, tags = []) {
  return {
    id,
    pubkey: "a".repeat(64),
    created_at: 1000,
    kind,
    tags: [["d", id], ...tags],
    content: typeof content === "string" ? content : JSON.stringify(content),
    sig: "sig",
  };
}

test("the OrgAllowance read vocabulary matches cast sig goldens", () => {
  assert.equal(SELECTOR_ALLOWANCE_OF, "0x90f42eed");
  assert.equal(SELECTOR_SPENT_OF, "0x5f85ed9c");
  assert.equal(SELECTOR_REMAINING_OF, "0xb529bdc5");
  assert.equal(SELECTOR_SPENDER_OF, "0x6a986708");
});

test("allowance reads carry the subject verbatim as bytes32 (NIP-ORG pubkey)", () => {
  const reads = buildAllowanceReads({
    contract: CONTRACT,
    subject: `0x${AGENT}`,
    token: `0x${"22".repeat(20)}`,
    epoch: 7n,
  });
  const args = `${AGENT}${"22".repeat(20).padStart(64, "0")}${7n.toString(16).padStart(64, "0")}`;
  assert.equal(reads[0].to, CONTRACT.toLowerCase());
  assert.equal(reads[0].data, `0x${SELECTOR_ALLOWANCE_OF.slice(2)}${args}`);
  assert.equal(reads[1].data, `0x${SELECTOR_SPENT_OF.slice(2)}${args}`);
  assert.equal(reads[2].data, `0x${SELECTOR_REMAINING_OF.slice(2)}${args}`);
  // spenderOf(bytes32) takes only the subject (OrgAllowance.sol:81).
  assert.equal(reads[3].data, `0x${SELECTOR_SPENDER_OF.slice(2)}${AGENT}`);
});

test("window→epoch mapping matches epoch.rs (fixed 30-day months)", () => {
  const now = 1_760_000_000n;
  assert.equal(budgetEpoch("epoch", now), 0n, "all-time never resets");
  assert.equal(budgetEpoch("day", now), now / 86_400n);
  assert.equal(budgetEpoch("week", now), now / 604_800n);
  assert.equal(budgetEpoch("month", now), now / 2_592_000n);
  assert.equal(budgetEpoch("day", 86_399n), 0n);
  assert.equal(budgetEpoch("day", 86_400n), 1n);
});

test("a 37012 budget parses with its window, ceiling, and onchain binding", () => {
  const budget = parseOrgBudget(
    orgEvent(37012, "budget-1", {
      subject: AGENT,
      periods: ["*"],
      windows: ["month"],
      allocation: "2500",
      rollover: true,
      onchain: {
        chain: "eip155:31337",
        contract: CONTRACT,
        subject: AGENT,
      },
      start: 1_755_000_000,
      end: 1_786_000_000,
    }),
  );
  assert.ok(budget);
  assert.equal(budget.id, "budget-1");
  assert.equal(budget.subject, AGENT);
  assert.deepEqual(budget.windows, ["month"]);
  assert.equal(budget.allocation, 2500n);
  assert.equal(budget.rollover, true);
  assert.equal(budget.onchain.contract, CONTRACT);
  assert.equal(budget.onchain.subject, AGENT);
  assert.equal(budget.start, 1_755_000_000);
});

test("an unbound budget (no onchain) and a malformed one both parse honestly", () => {
  const unbound = parseOrgBudget(
    orgEvent(37012, "budget-2", {
      subject: AGENT,
      periods: ["review", "merge"],
      windows: ["week", "forever"],
      allocation: 100,
    }),
  );
  assert.ok(unbound);
  assert.equal(unbound.onchain, null);
  assert.deepEqual(
    unbound.windows,
    ["week"],
    "unknown windows are dropped, not guessed",
  );
  assert.equal(
    parseOrgBudget(orgEvent(37012, "budget-3", { junk: true })),
    null,
  );
  assert.equal(parseOrgBudget(orgEvent(42, "x", {})), null);
});

test("a 37014 spend receipt parses with its amount and tx binding", () => {
  const spend = parseSpendReceipt(
    orgEvent(
      37014,
      "spend-1",
      {
        txHash: `0x${"b".repeat(64)}`,
        chain: "eip155:31337",
        contract: CONTRACT,
        subject: AGENT,
        agent: `0x${"aa".repeat(20)}`,
        actionId: "37013:alice:action-1",
        amount: "250",
        budgetId: "budget-1",
      },
      [["p", AGENT]],
    ),
  );
  assert.ok(spend);
  assert.equal(spend.amount, 250n);
  assert.equal(spend.txHash, `0x${"b".repeat(64)}`);
  assert.equal(spend.budgetId, "budget-1");
  assert.equal(spend.actionId, "37013:alice:action-1");
  assert.equal(
    parseSpendReceipt(
      orgEvent(37014, "spend-2", { contract: CONTRACT, subject: AGENT }),
    ),
    null,
    "a spend without txHash/amount is dropped, never zero-filled",
  );
});

test("the DAO binding resolves from the summon receipt, then the org root", () => {
  const summon = {
    table: "summon",
    payload: { table: "summon", dao: DAO },
    tx: `0x${"b".repeat(64)}`,
    createdAt: 200,
  };
  const bindings = [
    {
      rootEventId: ROOT_ID,
      dao: `0x${"e1".repeat(20)}`,
      chain: "eip155:31337",
      boundAt: 100,
    },
  ];
  assert.deepEqual(
    resolveDaoBinding({ receipts: [summon], orgBindings: bindings }),
    {
      dao: DAO,
      source: "summon-receipt",
      ref: `0x${"b".repeat(64)}`,
    },
  );
  assert.deepEqual(resolveDaoBinding({ receipts: [], orgBindings: bindings }), {
    dao: `0x${"e1".repeat(20)}`,
    source: "org-root",
    ref: ROOT_ID,
  });
  assert.equal(resolveDaoBinding({ receipts: [], orgBindings: [] }), null);
  // A malformed summon payload falls through to the org root instead of
  // inventing a DAO.
  assert.deepEqual(
    resolveDaoBinding({
      receipts: [
        { table: "summon", payload: { dao: "nope" }, tx: TX(), createdAt: 1 },
      ],
      orgBindings: bindings,
    }).source,
    "org-root",
  );
});

function TX() {
  return `0x${"d".repeat(64)}`;
}

test("an org root binding parses only from content.onchain with a real address", () => {
  const bound = parseOrgBinding(
    orgEvent(37010, ROOT_ID, {
      kind: "role",
      name: "root",
      onchain: { chain: "eip155:31337", dao: DAO, boundAt: 55 },
    }),
  );
  assert.ok(bound);
  assert.equal(bound.dao, DAO);
  assert.equal(bound.rootEventId, ROOT_ID);
  assert.equal(bound.boundAt, 55);

  assert.equal(
    parseOrgBinding(orgEvent(37010, "n", { kind: "role", name: "x" })),
    null,
    "an unbound root has no DAO",
  );
  assert.equal(
    parseOrgBinding(orgEvent(37010, "n2", { onchain: { dao: "0x1234" } })),
    null,
    "a malformed dao address is rejected",
  );
});

test("newest summon receipt wins when several are recorded", () => {
  const oldSummon = {
    table: "summon",
    payload: { dao: `0x${"01".repeat(20)}` },
    tx: TX(),
    createdAt: 10,
  };
  const newSummon = {
    table: "summon",
    payload: { dao: DAO },
    tx: `0x${"ee".repeat(64)}`,
    createdAt: 20,
  };
  const resolved = resolveDaoBinding({
    receipts: [oldSummon, newSummon],
    orgBindings: [],
  });
  assert.equal(resolved.dao, DAO);
  assert.equal(resolved.ref, `0x${"ee".repeat(64)}`);
});
