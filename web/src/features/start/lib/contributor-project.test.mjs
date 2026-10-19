import assert from "node:assert/strict";
import test from "node:test";

import { selectorOf } from "@creaton/core/launchpad/evmAbi.ts";
import {
  CONTRIBUTOR_DEFAULTS,
  contributorIssue,
  contributorRecordInput,
  contributorRootId,
  contributorTerms,
  daoFromReceiptLogs,
  encodeBindingOf,
  encodeSummonAndBind,
  firstBudgetDecision,
  firstBudgetNonce,
  formatBps,
  proposalThreshold,
  sharePreview,
  SUMMON_AND_BIND_SIGNATURE,
  TOPIC_DAO_BOUND,
} from "./contributor-project.ts";
import { isContributorProject } from "../../launchpad/lib/funding.ts";

const R1 = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const R2 = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc";
const FOUNDER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const ROOT = `0x${"ab".repeat(32)}`;

function draft(overrides = {}) {
  return {
    name: "Docs Commons",
    pitch: "Open docs for everyone, written by the people who use them.",
    symbol: "DOCS",
    ...CONTRIBUTOR_DEFAULTS,
    reviewers: `${R1}\n${R2}`,
    quorum: "",
    ...overrides,
  };
}

test("the summon call is byte-for-byte what cast encodes", () => {
  // Pinned with `cast sig` and `cast calldata` on the same values.
  assert.equal(selectorOf(SUMMON_AND_BIND_SIGNATURE), "0x0a330b28");
  const data = encodeSummonAndBind({
    rootId: ROOT,
    name: "Docs Commons",
    symbol: "DOCS",
    molochImpl: `0x${"11".repeat(20)}`,
    founder: FOUNDER,
    founderWhole: 100_000n,
  });
  assert.equal(
    data,
    "0x0a330b28abababababababababababababababababababababababababababababababab0000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000018000000000000000000000000000000000000000000000000000000000000001c0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000001f4000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000003635c9adc5dea00000000000000000000000000000000000000000000000000000000000000012750000000000000000000000000000000000000000000000000000000000000151800000000000000000000000001111111111111111111111111111111111111111abababababababababababababababababababababababababababababababab00000000000000000000000000000000000000000000000000000000000002200000000000000000000000000000000000000000000000000000000000000260000000000000000000000000000000000000000000000000000000000000000c446f637320436f6d6d6f6e7300000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000004444f43530000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb92266000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000152d02c7e14af6800000",
  );
  assert.equal(encodeBindingOf(ROOT), `0x17530ef1${"ab".repeat(32)}`);
  assert.equal(
    TOPIC_DAO_BOUND,
    "0x8c724736a761e84e54207b4fa4b41f626d0ffc61381c8d10ce9a83dffdf45c24",
  );
});

test("a vote can be opened with 1% of the starting Shares", () => {
  assert.equal(proposalThreshold(100_000n), 1_000n * 10n ** 18n);
  assert.equal(proposalThreshold(1n), 10n ** 16n);
});

test("the key is the same for the same project and differs for another one or another founder", () => {
  const a = contributorRootId("aa".repeat(32), "docs-commons");
  assert.match(a, /^0x[0-9a-f]{64}$/);
  assert.equal(a, contributorRootId("aa".repeat(32), "docs-commons"));
  assert.notEqual(a, contributorRootId("aa".repeat(32), "docs-commons-2"));
  assert.notEqual(a, contributorRootId("bb".repeat(32), "docs-commons"));
  assert.notEqual(firstBudgetNonce(a), a);
  assert.equal(firstBudgetNonce(a), firstBudgetNonce(a));
});

test("the terms say what share of all Shares contributors would hold", () => {
  const terms = contributorTerms(draft());
  assert.equal(terms.founderWhole, 100_000n);
  assert.equal(terms.budgetWhole, 100_000n);
  assert.equal(terms.quorum, 2); // a simple majority of two
  assert.equal(formatBps(terms.contributorsAtFullBudgetBps), "50%");
  assert.equal(
    formatBps(
      contributorTerms(draft({ budgetShares: "50000" }))
        .contributorsAtFullBudgetBps,
    ),
    "33.3%",
  );
});

test("every refusal names its field", () => {
  const cases = [
    [{ name: "" }, "name"],
    [{ pitch: "short" }, "pitch"],
    [{ symbol: "x" }, "symbol"],
    [{ founderShares: "0" }, "founderShares"],
    [{ founderShares: "1.5" }, "founderShares"],
    [{ budgetShares: "2000000000" }, "budgetShares"],
    [{ projectCap: "200000" }, "projectCap"],
    [{ reviewers: "" }, "reviewers"],
    [{ reviewers: "alice" }, "reviewers"],
    [
      { reviewers: `${R1}\n${R1.toUpperCase().replace("0X", "0x")}` },
      "reviewers",
    ],
    [{ quorum: "3" }, "quorum"],
    [{ quorum: "0" }, "quorum"],
  ];
  for (const [overrides, field] of cases) {
    assert.equal(
      contributorIssue(draft(overrides))?.field,
      field,
      JSON.stringify(overrides),
    );
  }
  assert.equal(contributorIssue(draft()), null);
});

test("the founder cannot be the one reviewer whose approval is enough", () => {
  const solo = draft({ reviewers: `${FOUNDER}\n${R1}`, quorum: "1" });
  assert.equal(contributorIssue(solo, FOUNDER)?.field, "quorum");
  assert.equal(contributorIssue({ ...solo, quorum: "2" }, FOUNDER), null);
  // Without them on the panel one approval is the founder's choice to make.
  assert.equal(contributorIssue(draft({ quorum: "1" }), FOUNDER), null);
});

test("the first decision is a Shares-only work budget, sent straight to the factory", () => {
  const terms = contributorTerms(draft());
  const factory = `0x${"22".repeat(20)}`;
  const decision = firstBudgetDecision({
    terms,
    dao: `0x${"33".repeat(20)}`,
    factory,
    currency: `0x${"44".repeat(20)}`,
    currencyDecimals: 6,
    now: 1_000,
  });
  // No money moves, so the DAO calls the factory directly instead of approving a currency first.
  assert.equal(decision.to, factory);
  assert.equal(decision.lane, "unrestricted");
  assert.equal(
    decision.lines[0],
    "Shares for work: 100,000 in all, at most 25,000 per project",
  );
  assert.ok(!decision.lines.some((line) => line.startsWith("Money")));
  assert.ok(decision.lines.includes("2 reviewers, 2 must agree on each claim"));
});

test("the DAO is read from the maker's own log for this key, never another's", () => {
  const binding = `0x${"55".repeat(20)}`;
  const dao = `0x${"66".repeat(20)}`;
  const log = (address, root) => ({
    address,
    topics: [TOPIC_DAO_BOUND, root, `0x${"0".repeat(24)}${dao.slice(2)}`],
  });
  assert.equal(daoFromReceiptLogs([log(binding, ROOT)], binding, ROOT), dao);
  assert.equal(
    daoFromReceiptLogs([log(`0x${"77".repeat(20)}`, ROOT)], binding, ROOT),
    null,
  );
  assert.equal(
    daoFromReceiptLogs([log(binding, `0x${"cd".repeat(32)}`)], binding, ROOT),
    null,
  );
  assert.equal(daoFromReceiptLogs([], binding, ROOT), null);
});

test("the record says contributors only, names the DAO and sells nothing", () => {
  const input = contributorRecordInput({
    launchId: "docs-commons",
    terms: contributorTerms(draft()),
    chainId: 31337,
    dao: "0xdao",
    shares: "0xshares",
    currency: "0xusdc",
  });
  assert.equal(input.treasury, "0xdao");
  assert.equal(input.token, "0xshares");
  assert.equal(input.auction, "");
  assert.equal(input.requiredRaised, "");
  assert.equal(input.funding.path, "contributors");
  assert.equal(input.tokenPlan.mode, "dao");
  assert.equal(input.tokenPlan.supply, "100000");
  assert.equal(isContributorProject({ ...input, auction: null }), true);
});

test("the preview needs only the Share fields, and none while they do not make sense", () => {
  const empty = { ...draft(), name: "", pitch: "", reviewers: "" };
  assert.deepEqual(sharePreview(empty), {
    founderWhole: 100_000n,
    budgetWhole: 100_000n,
    contributorsBps: 5000,
  });
  assert.equal(sharePreview({ ...empty, budgetShares: "abc" }), null);
  assert.equal(sharePreview({ ...empty, projectCap: "200000" }), null);
});
