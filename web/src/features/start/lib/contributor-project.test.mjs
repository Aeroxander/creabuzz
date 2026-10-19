import assert from "node:assert/strict";
import test from "node:test";

import { selectorOf } from "@creaton/core/launchpad/evmAbi.ts";
import {
  CONTRIBUTOR_DEFAULTS,
  contributorIssue,
  contributorRecordInput,
  contributorSalt,
  contributorTerms,
  createAddress,
  encodeKitLaunch,
  encodePredictDao,
  formatBps,
  KIT_LAUNCH_SIGNATURE,
  sharePreview,
} from "./contributor-project.ts";
import { isContributorProject } from "../../launchpad/lib/funding.ts";

const R1 = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const R2 = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc";
const FOUNDER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const SALT = `0x${"ab".repeat(32)}`;

function draft(overrides = {}) {
  return {
    name: "Docs Commons",
    pitch: "Open docs for everyone, written by the people who use them.",
    symbol: "DOCS",
    ...CONTRIBUTOR_DEFAULTS,
    reviewers: `${R1}\n${R2}`,
    quorum: "",
    projectName: "docs",
    projectCheck: "docs merged and reviewed",
    ...overrides,
  };
}

test("the kit's launch call is byte-for-byte what cast encodes", () => {
  // Pinned with `cast sig` and `cast calldata` on the same values.
  assert.equal(selectorOf(KIT_LAUNCH_SIGNATURE), "0x7f039bd5");
  const data = encodeKitLaunch({
    terms: contributorTerms(draft()),
    salt: SALT,
    founder: FOUNDER,
    currency: `0x${"44".repeat(20)}`,
    predictedBudget: `0x${"55".repeat(20)}`,
    now: 1_000,
  });
  assert.equal(
    data,
    "0x7f039bd500000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000024000000000000000000000000000000000000000000000152d02c7e14af6800000abababababababababababababababababababababababababababababababab000000000000000000000000444444444444444444444444444444444444444400000000000000000000000000000000000000000000152d02c7e14af680000000000000000000000000000000000000000000000000054b40b1f852bda00000000000000000000000000000000000000000000000000000000000000076aae8000000000000000000000000000000000000000000000000000000000000028000000000000000000000000000000000000000000000000000000000000000020000000000000000000000005555555555555555555555555555555555555555646f637300000000000000000000000000000000000000000000000000000000000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb9226600000000000000000000000000000000000000000000054b40b1f852bda00000000000000000000000000000000000000000000000000000000000000076aae8e8164af4b3d1186a31c4eecb6012657bf68042eb1ce8130d9d766a096b0418ff000000000000000000000000000000000000000000000000000000000000000c446f637320436f6d6d6f6e7300000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000004444f435300000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000200000000000000000000000070997970c51812dc3a010c7d01b50e0d17dc79c80000000000000000000000003c44cdddb6a900fa2b585dd299e03d12fa4293bc",
  );
  assert.equal(
    encodePredictDao(FOUNDER, 100_000n, SALT),
    `0xfd762067000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb9226600000000000000000000000000000000000000000000152d02c7e14af6800000${"ab".repeat(32)}`,
  );
});

test("the next budget's address is where a plain CREATE puts it", () => {
  // cast compute-address 0x2222…2222 --nonce N
  const sender = `0x${"22".repeat(20)}`;
  const expected = {
    0: "0x659b375d76a8e9a2c68da8818022d6561aa60845",
    1: "0x894bcfd2eed71b2082101dc85f86865824efb62d",
    5: "0x433adfe1f7439b818b65ac6043bac66b8abf1436",
    127: "0x94d8faba855284d49ef42fafe3357f57a8dedf87",
    128: "0xed50a8106e29e03ec86c56c7ad1ae5dd8e51bb9c",
    300: "0x2bc87f257cf48f3fba6e554a2acd19589e60b65c",
    70000: "0xf86761eeef51d7725e160a157860ce4a5260c34b",
  };
  for (const [nonce, address] of Object.entries(expected)) {
    assert.equal(createAddress(sender, BigInt(nonce)), address, nonce);
  }
});

test("the salt is the same for the same project and differs for another one or another founder", () => {
  const a = contributorSalt("aa".repeat(32), "docs-commons");
  assert.match(a, /^0x[0-9a-f]{64}$/);
  assert.equal(a, contributorSalt("aa".repeat(32), "docs-commons"));
  assert.notEqual(a, contributorSalt("aa".repeat(32), "docs-commons-2"));
  assert.notEqual(a, contributorSalt("bb".repeat(32), "docs-commons"));
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
    [{ projectName: "" }, "projectName"],
    [{ projectName: "a".repeat(33) }, "projectName"],
    [{ projectName: "0xdocs" }, "projectName"],
    [{ projectCheck: "ok" }, "projectCheck"],
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
  const empty = {
    ...draft(),
    name: "",
    pitch: "",
    reviewers: "",
    projectName: "",
  };
  assert.deepEqual(sharePreview(empty), {
    founderWhole: 100_000n,
    budgetWhole: 100_000n,
    contributorsBps: 5000,
  });
  assert.equal(sharePreview({ ...empty, budgetShares: "abc" }), null);
  assert.equal(sharePreview({ ...empty, projectCap: "200000" }), null);
});
