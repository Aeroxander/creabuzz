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
  remixFromDraft,
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
    projects: [
      { name: "docs", check: "docs merged and reviewed", shares: "25000" },
    ],
    ...overrides,
  };
}

test("the kit's launch call is byte-for-byte what cast encodes", () => {
  // Pinned with `cast sig` and `cast calldata` on the same values.
  assert.equal(selectorOf(KIT_LAUNCH_SIGNATURE), "0x57859d36");
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
    "0x57859d360000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000018000000000000000000000000000000000000000000000000000000000000001c000000000000000000000000000000000000000000000152d02c7e14af6800000abababababababababababababababababababababababababababababababab0000000000000000000000004444444444444444444444444444444444444444000000000000000000000000000000000000000000003f870857a3e0e380000000000000000000000000000000000000000000000000054b40b1f852bda00000000000000000000000000000000000000000000000000000000000000076aae80000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000000200000000000000000000000055555555555555555555555555555555555555550000000000000000000000000000000000000000000000000000000000000260000000000000000000000000000000000000000000000000000000000000000c446f637320436f6d6d6f6e7300000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000004444f435300000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000200000000000000000000000070997970c51812dc3a010c7d01b50e0d17dc79c80000000000000000000000003c44cdddb6a900fa2b585dd299e03d12fa4293bc0000000000000000000000000000000000000000000000000000000000000001646f637300000000000000000000000000000000000000000000000000000000000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb9226600000000000000000000000000000000000000000000054b40b1f852bda00000000000000000000000000000000000000000000000000000000000000076aae8e8164af4b3d1186a31c4eecb6012657bf68042eb1ce8130d9d766a096b0418ff",
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
  assert.equal(terms.budgetWhole, 300_000n);
  assert.equal(terms.quorum, 2); // a simple majority of two
  assert.equal(formatBps(terms.contributorsAtFullBudgetBps), "75%");
  assert.equal(
    formatBps(
      contributorTerms(draft({ budgetShares: "1000000" }))
        .contributorsAtFullBudgetBps,
    ),
    "90.9%",
  );
});

test("every refusal names its field", () => {
  const cases = [
    [{ name: "" }, "name"],
    [{ pitch: "short" }, "pitch"],
    [{ symbol: "x" }, "symbol"],
    [{ founderShares: "0" }, "founderShares"],
    [{ founderShares: "1.5" }, "founderShares"],
    // D79: the founder starts with at most a third of what the first budget can award.
    [{ budgetShares: "299999" }, "founderShares"],
    [{ budgetShares: "2000000000" }, "budgetShares"],
    [{ projectCap: "400000" }, "projectCap"],
    [{ reviewers: "" }, "reviewers"],
    [{ reviewers: "alice" }, "reviewers"],
    [
      { reviewers: `${R1}\n${R1.toUpperCase().replace("0X", "0x")}` },
      "reviewers",
    ],
    [{ quorum: "3" }, "quorum"],
    [{ quorum: "0" }, "quorum"],
    [{ projects: [] }, "projects"],
    [
      { projects: [{ name: "", check: "docs merged", shares: "1" }] },
      "projects",
    ],
    [
      {
        projects: [{ name: "a".repeat(33), check: "docs merged", shares: "1" }],
      },
      "projects",
    ],
    [
      { projects: [{ name: "0xdocs", check: "docs merged", shares: "1" }] },
      "projects",
    ],
    [{ projects: [{ name: "docs", check: "ok", shares: "1" }] }, "projects"],
    [
      { projects: [{ name: "docs", check: "docs merged", shares: "25001" }] },
      "projects",
    ],
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

test("the founder does not review the first budget's work (D79)", () => {
  const onPanel = draft({ reviewers: `${FOUNDER}\n${R1}\n${R2}`, quorum: "2" });
  assert.equal(contributorIssue(onPanel, FOUNDER)?.field, "reviewers");
  assert.equal(
    contributorIssue({ ...onPanel, quorum: "1" }, FOUNDER)?.field,
    "reviewers",
  );
  // Without them on the panel one approval is the founder's choice to make.
  assert.equal(contributorIssue(draft({ quorum: "1" }), FOUNDER), null);
});

test("a founder with two accounts cannot review from the other one (D79, D139)", () => {
  // Acting from a passkey account while their name is linked to a wallet: the wallet may not review either.
  const PASSKEY = `0x${"ab".repeat(20)}`;
  const onPanel = draft({ reviewers: `${FOUNDER}\n${R1}\n${R2}`, quorum: "2" });
  assert.equal(
    contributorIssue(onPanel, PASSKEY),
    null,
    "one address alone does not see it",
  );
  assert.equal(
    contributorIssue(onPanel, [PASSKEY, FOUNDER])?.field,
    "reviewers",
  );
  assert.equal(
    contributorIssue(draft({ quorum: "1" }), [PASSKEY, FOUNDER]),
    null,
  );
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
  // Each first work area's words, exactly as the launch hashes them: the chain keeps only the hash.
  assert.deepEqual(
    input.workAreas,
    contributorTerms(draft()).projects.map((p) => ({
      name: p.name,
      check: p.check,
    })),
  );
  assert.ok(input.workAreas.length > 0);
});

test("the preview needs only the Share fields, and none while they do not make sense", () => {
  const empty = {
    ...draft(),
    name: "",
    pitch: "",
    reviewers: "",
    projects: [],
  };
  assert.deepEqual(sharePreview(empty), {
    founderWhole: 100_000n,
    budgetWhole: 300_000n,
    contributorsBps: 7500,
  });
  assert.equal(sharePreview({ ...empty, budgetShares: "abc" }), null);
  assert.equal(sharePreview({ ...empty, projectCap: "400000" }), null);
});

test("several first projects (D84): distinct names, each within the limit, together within the budget", () => {
  const two = (a, b) =>
    draft({
      projects: [
        { name: "design", check: "designs delivered", shares: a },
        { name: "dev", check: "the app is shipped", shares: b },
      ],
    });
  const terms = contributorTerms(two("20000", "25000"));
  assert.deepEqual(
    terms.projects.map((p) => [p.name, p.sharesWhole]),
    [
      ["design", 20_000n],
      ["dev", 25_000n],
    ],
  );
  const twice = draft({
    projects: [
      { name: "dev", check: "the app is shipped", shares: "1" },
      { name: "dev", check: "the app is shipped", shares: "1" },
    ],
  });
  assert.equal(contributorIssue(twice)?.index, 1);
  assert.equal(
    contributorIssue(twice)?.message,
    "Two work areas are called “dev”: give each its own name.",
  );
  // A problem names its project, even when there is only one.
  const big = draft({
    projectCap: "40",
    projects: [{ name: "docs", check: "docs delivered", shares: "25000" }],
  });
  assert.equal(
    contributorIssue(big)?.message,
    "“docs” can award at most 40 Shares, the most for one work area.",
  );
  const unnamed = draft({
    projects: [{ name: "", check: "docs delivered", shares: "1" }],
  });
  assert.equal(
    contributorIssue(unnamed)?.message,
    "Name the first work area, in a word or two.",
  );
  const nine = draft({
    projects: Array.from({ length: 9 }, (_, i) => ({
      name: `p${i}`,
      check: "work delivered",
      shares: "1",
    })),
  });
  assert.equal(contributorIssue(nine)?.field, "projects");
  // Thirteen projects of 25,000 would be more than the 300,000 budget; twelve fit, but only eight may start.
  const over = draft({
    budgetShares: "300000",
    projectCap: "200000",
    projects: [
      { name: "a", check: "work delivered", shares: "200000" },
      { name: "b", check: "work delivered", shares: "150000" },
    ],
  });
  assert.match(
    contributorIssue(over)?.message ?? "",
    /more than the 300,000 the budget holds/,
  );
});

test("the launch call carries every first project, each managed by the founder", () => {
  const data = encodeKitLaunch({
    terms: contributorTerms(
      draft({
        projects: [
          { name: "design", check: "designs delivered", shares: "20000" },
          { name: "dev", check: "the app is shipped", shares: "25000" },
        ],
      }),
    ),
    salt: SALT,
    founder: FOUNDER,
    currency: `0x${"44".repeat(20)}`,
    predictedBudget: `0x${"55".repeat(20)}`,
    now: 1_000,
  });
  // Two project tuples follow the array length word.
  assert.ok(
    data.includes(`${"0".repeat(63)}2${"64657369676e".padEnd(64, "0")}`),
  );
  assert.ok(data.includes("646576".padEnd(64, "0")));
});

test("what a project is built on, and whether others may build on it, go into its record (N11)", () => {
  const author = "a".repeat(64);
  assert.deepEqual(
    remixFromDraft({
      builtOn: `${author}:docs-commons`,
      remixInvited: true,
      remixAsks: "  Credit us on your page. ",
    }),
    {
      builtOn: { author, id: "docs-commons" },
      remixTerms: {
        invited: true,
        asks: "Credit us on your page.",
        offers: [],
      },
    },
  );
  // Nothing picked, or a malformed pick: no link, and the record still says remixes are not invited.
  assert.deepEqual(remixFromDraft({}), {
    remixTerms: { invited: false, asks: "", offers: [] },
  });
  assert.deepEqual(remixFromDraft({ builtOn: "nope", remixAsks: "ignored" }), {
    remixTerms: { invited: false, asks: "", offers: [] },
  });
});

test("one approval needed of several says an approval wins over a turn-down, as ClaimStake.settle decides", async () => {
  const { quorumSentence } = await import("./contributor-project.ts");
  assert.equal(
    quorumSentence(2, 1),
    "Either of them can decide: one approval is enough, even if the other turns it down.",
  );
  assert.match(quorumSentence(3, 1), /even if others turn it down/);
  assert.equal(
    quorumSentence(3, 2),
    "2 of these 3 must agree on each piece of work.",
  );
  assert.equal(
    quorumSentence(1, 1),
    "This reviewer decides on each piece of work alone.",
  );
});
