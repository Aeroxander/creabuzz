import { expect, test, type Page } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";

import { expectAccessible } from "../helpers/a11y";
import { createMockRelay } from "./mock-relay";

/**
 * Contributor projects, in the browser, against a stubbed server and a stubbed chain (same-origin `/test-rpc`).
 *
 * The Start page offers the path and says plainly there is no token sale; a build that names no DAO maker for
 * the network says so and does not offer to start. A contributor project's page calls itself what it is (never "Sale
 * completed"), has no buyer copy, and its Contributions tab shows who earned how many Shares for which claim in which
 * project, from the award events the stub chain serves.
 *
 * The real run (making the DAO, publishing, opening the first budget, a claim accepted and awarded) is
 * `contributor-journey.spec.ts`, driven by `scripts/web-contributor-e2e.sh` against a real local chain.
 */

const NSEC = "6".repeat(64);
const ME = getPublicKey(Uint8Array.from(Buffer.from(NSEC, "hex")));
const E18 = 10n ** 18n;

const a = (byte: string) => `0x${byte.repeat(20)}`;
const word = (n: bigint | string) =>
  (typeof n === "bigint" ? n.toString(16) : n.replace(/^0x/, "")).padStart(
    64,
    "0",
  );
const label = (text: string) =>
  `0x${Buffer.from(text, "utf8").toString("hex").padEnd(64, "0")}`;

const DAO = a("da");
const POLICY = a("70");
const FACTORY = a("fa");
const SHARES = a("5e");
const BUDGET = a("b1");
const ALICE = a("a1");
const BOB = a("b0");
const CAROL = a("c4");
const FOUNDER_WALLET = a("f0");

const TOPIC_MANDATE_CREATED =
  "0x2a075deaacc4f205aa6d5c9cdadfaf7c96743415971a38b677820238f7a0965b";
const TOPIC_CONTRIBUTION_CONSUMED =
  "0x9bb4ec6ba5d3a80ea80a6926798482c0e41c1e10214a686fc8e8695253439e95";
/** `Transfer(address,address,uint256)`: the Shares token's mints confirm each award. */
const TOPIC_TRANSFER =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const CALL = {
  votingWeight: "0x6f533638",
  mandateFactory: "0xb04b7bdb",
  shares: "0x03314efa",
  totalSupply: "0x18160ddd",
  claimProject: "0x84a95c5f",
  decimals: "0x313ce567",
  balanceOf: "0x70a08231",
};

const record = {
  id: "a".repeat(64),
  pubkey: ME,
  created_at: 100,
  kind: 37001,
  tags: [
    ["d", "docs-commons"],
    ["name", "Docs Commons"],
    ["t", "dao-launchpad"],
    ["admission", "community"],
    ["chain", "31337"],
    ["token", SHARES],
    ["treasury", DAO],
  ],
  content: JSON.stringify({
    pitch: "Open docs for everyone, written by the people who use them.",
    stage: "graduated",
    funding: {
      stance: "not-raising",
      seeking: ["contributors"],
      path: "contributors",
    },
    tokenPlan: {
      mode: "dao",
      name: "Docs Commons",
      symbol: "DOCS",
      supply: "100000",
    },
  }),
  sig: "sig",
};

/**
 * Award events: Alice 25 for write-docs (work area docs) and 15 for translate; Bob 10 for fix-search; and 5 recorded for
 * Carol whose Shares never arrived (a vote that used her claim without awarding it). 150 Shares in all: the founder's
 * 100 and the 50 actually awarded.
 */
const txOf = (block: number) => `0x${word(BigInt(block))}`;
function awardLog(claim: string, who: string, shares: bigint, block: number) {
  return {
    address: BUDGET,
    topics: [TOPIC_CONTRIBUTION_CONSUMED, label(claim), `0x${word(who)}`],
    data: `0x${word(shares * E18)}`,
    blockNumber: `0x${block.toString(16)}`,
    transactionHash: txOf(block),
    logIndex: "0x0",
  };
}

/** A mint of `shares` to `who` in the transaction of `block`. */
function mintLog(who: string, shares: bigint, block: number) {
  return {
    address: SHARES,
    topics: [TOPIC_TRANSFER, `0x${word(0n)}`, `0x${word(who)}`],
    data: `0x${word(shares * E18)}`,
    blockNumber: `0x${block.toString(16)}`,
    transactionHash: txOf(block),
    logIndex: "0x1",
  };
}

const HELD: Record<string, bigint> = { [ALICE]: 40n, [BOB]: 10n, [CAROL]: 0n };

async function installChain(page: Page, { awards = true } = {}) {
  await page.addInitScript(() => {
    window.localStorage.setItem(
      "buzz.launchpad.rpc",
      `${window.location.origin}/test-rpc`,
    );
  });
  await page.route("**/test-rpc", async (route) => {
    const { id, method, params } = JSON.parse(
      route.request().postData() ?? "{}",
    ) as { id: number; method: string; params: Record<string, unknown>[] };
    const reply = (body: Record<string, unknown>) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ jsonrpc: "2.0", id, ...body }),
      });
    if (method === "eth_chainId") return reply({ result: "0x7a69" });
    if (method === "eth_blockNumber") return reply({ result: "0x20" });
    const target = String(
      params?.[0]?.address ?? params?.[0]?.to ?? "",
    ).toLowerCase();
    if (method === "eth_getLogs") {
      const topics = (params[0]?.topics ?? []) as (string | null)[];
      if (target === FACTORY && topics[0] === TOPIC_MANDATE_CREATED) {
        return reply({
          result: [
            {
              address: FACTORY,
              topics: [
                TOPIC_MANDATE_CREATED,
                `0x${word(DAO)}`,
                `0x${word(BUDGET)}`,
              ],
              data: `0x${[word(a("c0")), word(0n), word(0n), word(100_000n * E18), word(25_000n * E18)].join("")}`,
              blockNumber: "0x5",
              transactionHash: `0x${"cd".repeat(32)}`,
              logIndex: "0x0",
            },
          ],
        });
      }
      if (target === BUDGET && topics[0] === TOPIC_CONTRIBUTION_CONSUMED) {
        return reply({
          result: awards
            ? [
                awardLog("write-docs", ALICE, 25n, 10),
                awardLog("fix-search", BOB, 10n, 11),
                awardLog("translate", ALICE, 15n, 12),
                awardLog("review-copy", CAROL, 5n, 13),
              ]
            : [],
        });
      }
      if (target === SHARES && topics[0] === TOPIC_TRANSFER) {
        // Mints only (from the zero address); nothing ever left the DAO's reserve here.
        if (topics[1] !== `0x${word(0n)}`) return reply({ result: [] });
        return reply({
          result: awards
            ? [
                mintLog(FOUNDER_WALLET, 100n, 2),
                mintLog(ALICE, 25n, 10),
                mintLog(BOB, 10n, 11),
                mintLog(ALICE, 15n, 12),
              ]
            : [mintLog(FOUNDER_WALLET, 150n, 2)],
        });
      }
      return reply({ result: [] });
    }
    if (method === "eth_call") {
      const data = String(params[0]?.data ?? "");
      if (target === DAO && data === CALL.votingWeight)
        return reply({ result: `0x${word(POLICY)}` });
      if (target === POLICY && data === CALL.mandateFactory)
        return reply({ result: `0x${word(FACTORY)}` });
      if (target === DAO && data === CALL.shares)
        return reply({ result: `0x${word(SHARES)}` });
      if (target === SHARES && data === CALL.totalSupply)
        return reply({ result: `0x${word(150n * E18)}` });
      if (target === SHARES && data.startsWith(CALL.balanceOf)) {
        const who = `0x${data.slice(-40)}`;
        return reply({ result: `0x${word((HELD[who] ?? 0n) * E18)}` });
      }
      if (target === BUDGET && data.startsWith(CALL.claimProject)) {
        const claim = `0x${data.slice(10)}`;
        return reply({
          result:
            claim === label("write-docs") ? label("docs") : `0x${word(0n)}`,
        });
      }
      return reply({ error: { code: -32000, message: "not stubbed" } });
    }
    return reply({ error: { code: -32601, message: `no ${method}` } });
  });
}

async function signIn(page: Page) {
  await page.addInitScript((nsec) => {
    window.localStorage.setItem("buzz.identity.nsec", nsec);
    window.localStorage.setItem("buzz.identity.backedUp", "1");
  }, NSEC);
}

test("Start offers a contributor project, says it has no token sale, and shows who holds what at the start and later", async ({
  page,
}) => {
  const relay = createMockRelay();
  await relay.install(page);
  await installChain(page);
  await signIn(page);
  await page.goto("/start");

  const path = page.getByTestId("start-contributor");
  await expect(path).toContainText("Start without a token sale");
  await path.getByTestId("start-go-contributor").click();
  await expect(page).toHaveURL(/\/start\/contributor$/);

  const intro = page.getByTestId("contributor-no-raise");
  await expect(intro).toContainText("Starts without a token sale");
  // No promise the treasury can never receive money, the founder's starting Shares said before signing, review and
  // award as separate steps, and the transfer rule as it is.
  await expect(intro).toContainText(
    "The project can still receive money into its shared funds.",
  );
  await expect(intro).toContainText(
    "At first you may hold every Share that votes.",
  );
  await expect(intro).toContainText("Approval alone gives no Shares.");
  await expect(intro).toContainText(
    "Opening transfers takes two project votes, at least 30 days apart.",
  );
  // The first project is part of the form: work can start the day the project exists.
  await expect(page.getByTestId("contributor-project-name")).toBeVisible();
  await expect(page.getByTestId("contributor-project-check")).toBeVisible();

  // The short name follows the name until the founder types their own.
  await page.getByTestId("contributor-name").fill("Docs Commons");
  await expect(page.getByTestId("contributor-symbol")).toHaveValue("DOCS");
  await page
    .getByTestId("contributor-pitch")
    .fill("Open docs for everyone, written by the people who use them.");
  // Today and the illustration kept apart: the unawarded budget is never shown as contributors' Shares now.
  await expect(page.getByTestId("contributor-preview-start")).toHaveText(
    "At the start: you hold 100,000 of 100,000 Shares, every Share that votes. The work budget can award up to 300,000 more; those do not vote until they are awarded.",
  );
  await expect(page.getByTestId("contributor-preview-full")).toContainText(
    "If the whole work budget is awarded (an illustration, not a prediction): contributors would hold 75% of all Shares and you 25%",
  );
  await page.getByTestId("contributor-budget-shares").fill("900000");
  await expect(page.getByTestId("contributor-preview-full")).toContainText(
    "contributors would hold 90% of all Shares and you 10%",
  );

  // This build names no DAO maker for the local network: it says so and offers no button that would fail.
  await expect(page.getByTestId("contributor-gate")).toContainText(
    "Contributor projects cannot be started on",
  );
  await expect(page.getByTestId("contributor-submit")).toBeDisabled();
  await expectAccessible(page, "contributor start page");
});

test("a contributor project's page names what it is, sells nothing, and shows who earned the Shares for what", async ({
  page,
}) => {
  const relay = createMockRelay();
  relay.seed(record);
  await relay.install(page);
  await installChain(page);
  await page.goto(`/launchpad/docs-commons?author=${ME}&tab=contributions`);

  await expect(page.getByTestId("contributions-tab")).toBeVisible({
    timeout: 20_000,
  });
  // What it is, in the header: never a sale that took place, never buyer copy.
  await expect(page.getByTestId("contributor-badge")).toHaveText(
    "Contributor project",
  );
  await expect(page.getByTestId("launch-hero")).not.toContainText(
    "Sale completed",
  );
  await expect(page.getByTestId("launch-hero")).not.toContainText(
    "Raise closed",
  );
  // This build names no contributor kit and the stub chain cannot answer for the Shares: the header says only what
  // the record says and that the rules could not be read, never "only from awards" or "locked".
  await expect(page.getByTestId("contributor-note")).toHaveText(
    "Its page says it started without a token sale; this could not be checked.",
  );
  await expect(page.getByTestId("contributor-issuance")).toContainText(
    "Could not check how this project's Shares work just now",
    { timeout: 20_000 },
  );
  await expect(page.getByTestId("contributor-transfers")).toHaveCount(0);
  // Contributions come right after the overview for a project whose Shares only come from work.
  const tabs = page.getByRole("tab");
  await expect(tabs.nth(0)).toHaveText("Overview");
  await expect(tabs.nth(1)).toHaveText("Contributions");
  await expect(page.getByRole("tab", { name: "My bids" })).toHaveCount(0);

  // The figures are the chain's: 50 awarded and confirmed by the Shares that arrived, 5 recorded whose Shares never
  // did, and the founder's 100 starting Shares read from the token's own mint, not worked out from what is left.
  await expect(page.getByTestId("contributions-earned")).toHaveText("50");
  await expect(page.getByTestId("contributions-unconfirmed")).toHaveText("5");
  await expect(page.getByTestId("contributions-starting")).toHaveText("100");
  await expect(page.getByTestId("contributions-total")).toHaveText("150");

  const people = page.getByTestId("contribution-person");
  await expect(people).toHaveCount(3);
  await expect(
    people.nth(0).getByTestId("contribution-person-earned"),
  ).toHaveText("40 Shares awarded");
  // What they hold now is its own figure, beside what they were awarded.
  await expect(
    people.nth(0).getByTestId("contribution-person-held"),
  ).toHaveText("Holds 40 now (26.7% of all Shares now).");
  await expect(
    people.nth(0).getByTestId("contribution-award-title"),
  ).toHaveText([
    "15 Shares for translate",
    "25 Shares for write-docs in the work area docs",
  ]);
  // The story behind an award says only what it could read: this stub chain gives no block times and no claims, so
  // the date is "not read" and the evidence is left to the Work tab, never guessed; the transaction is still there.
  const story = people.nth(0).getByTestId("contribution-award-story").first();
  await expect(story).toContainText("Date not read");
  await expect(story).toContainText(
    "Its evidence is on the Work tab with the claim.",
  );
  await expect(story.getByTestId("tx-link")).toBeVisible();
  await expect(
    people.nth(1).getByTestId("contribution-person-earned"),
  ).toHaveText("10 Shares awarded");
  // An award the budget recorded but whose Shares never reached her: shown, and not counted as received.
  await expect(
    people.nth(2).getByTestId("contribution-person-earned"),
  ).toHaveText("0 Shares awarded · 5 recorded, not confirmed");
  await expect(
    people.nth(2).getByTestId("contribution-award-unconfirmed"),
  ).toHaveText("Award recorded; the Shares were not found reaching them");
  // Each award links to its claim on the Work tab.
  await expect(
    people.nth(1).getByRole("link", { name: "fix-search" }),
  ).toHaveAttribute("href", /tab=work.*claim=0x6669782d736561726368/);
  await expectAccessible(page, "contributions tab");
});

test("a project nobody has earned Shares in yet says so", async ({ page }) => {
  const relay = createMockRelay();
  relay.seed(record);
  await relay.install(page);
  await installChain(page, { awards: false });
  await page.goto(`/launchpad/docs-commons?author=${ME}&tab=contributions`);
  await expect(page.getByTestId("contributions-empty")).toContainText(
    "No Share awards are shown yet",
    { timeout: 20_000 },
  );
  await expect(page.getByTestId("contributions-starting")).toHaveText("150");
});

test("anyone suggests work with a % ask, and Put to a vote opens Approve a work area filled in from it", async ({
  page,
}) => {
  const BOARD = "5b0a7d1e-0000-4000-8000-000000000002";
  const CHECK = "every docs page is in Spanish and merged";
  const relay = createMockRelay();
  relay.seed(record);
  relay.seed({
    id: "b".repeat(64),
    pubkey: "c".repeat(64),
    created_at: 50,
    kind: 39000,
    tags: [["d", BOARD], ["name", "ideas"], ["public"], ["t", "forum"]],
    content: "",
    sig: "sig",
  });
  await relay.install(page);
  await installChain(page);
  await signIn(page);
  await page.goto(`/launchpad/docs-commons?author=${ME}&tab=work`);

  const section = page.getByTestId("suggested-work");
  await expect(section.getByTestId("suggested-work-empty")).toBeVisible({
    timeout: 20_000,
  });
  await section.getByTestId("suggest-work").click();
  await page.getByTestId("suggest-title").fill("Translate the docs to Spanish");
  await page.getByTestId("suggest-name").fill("docs-es");
  await page.getByTestId("suggest-check").fill(CHECK);
  // 5% once added to the 150 Shares that exist: 8 Shares, rounded up so the ask reaches the share.
  await page.getByTestId("suggest-amount").fill("5");
  await expect(page.getByTestId("suggest-ask-preview")).toHaveText(
    "8 Shares: 5.1% of the project once they are added to the 150 that exist now, so everyone else's part shrinks by that much.",
  );
  // The same ask can be typed in Shares.
  await page.getByTestId("suggest-unit-shares").click();
  await page.getByTestId("suggest-amount").fill("12");
  await expect(page.getByTestId("suggest-ask-preview")).toContainText(
    "12 Shares: 7.4% of the project",
  );
  await page.getByTestId("suggest-submit").click();

  // It is a board post, on the board, that names this project.
  const card = section.locator('[data-testid^="work-proposal-"][data-status]');
  await expect(card).toHaveCount(1, { timeout: 10_000 });
  await expect(card).toHaveAttribute("data-status", "suggested");
  await expect(card.getByTestId("work-proposal-ask")).toHaveText(
    "12 Shares (7.4%)",
  );
  const posts = relay.events.filter((event) => event.kind === 45001);
  expect(posts).toHaveLength(1);
  expect(posts[0].tags).toEqual(
    expect.arrayContaining([
      ["h", BOARD],
      ["t", "work-proposal"],
      ["t", `work-proposal:31337:${DAO}`],
      ["project", "docs-es"],
      ["ask", "12"],
      ["check", CHECK],
    ]),
  );

  // A holder puts it to a vote: the Decisions tab opens, to "Approve a work area" filled in from it (the form itself needs
  // the chain's decisions, so `contributor-journey.spec.ts` checks it on a real one).
  await expectAccessible(page, "suggested work");
  await card.getByTestId("work-proposal-sponsor").click();
  await expect(page.getByRole("tab", { name: "Decisions" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

test("a contributor project keeps its funds and the way to leave (no sale is not no treasury)", async ({
  page,
}) => {
  const relay = createMockRelay();
  relay.seed(record);
  await relay.install(page);
  await installChain(page);
  // An old link to the treasury opens the project's Funds, not the overview.
  await page.goto(`/launchpad/docs-commons?author=${ME}&tab=treasury`);
  const funds = page.getByRole("tab", { name: "Funds", exact: true });
  await expect(funds).toHaveAttribute("aria-selected", "true", {
    timeout: 20_000,
  });
  // This build names no contributor kit, so the DAO cannot be checked: it says so rather than show unverified money.
  await expect(page.getByTestId("contributor-funds-unchecked")).toContainText(
    "could not be checked against the contributor kit",
  );
  await expect(page.getByTestId("contributor-funds")).not.toContainText(
    /graduation|price floor|raise/i,
  );
});

test("a contributor project's founder keeps its settings: the words people read, and taking it off Discover", async ({
  page,
}) => {
  const relay = createMockRelay();
  relay.seed({
    ...record,
    content: JSON.stringify({
      ...JSON.parse(record.content),
      workAreas: [{ name: "docs", check: "The pages are merged and reviewed" }],
    }),
  });
  await relay.install(page);
  await installChain(page);
  await signIn(page);
  await page.goto(`/launchpad/docs-commons?author=${ME}&tab=manage`);
  await expect(
    page.getByRole("tab", { name: "Manage", exact: true }),
  ).toHaveAttribute("aria-selected", "true", { timeout: 20_000 });
  const settings = page.getByTestId("contributor-settings");
  await expect(settings).toBeVisible();
  // None of the sale's set-up.
  await expect(page.getByTestId("launch-readiness")).toHaveCount(0);
  await expect(page.getByText("Edit terms")).toHaveCount(0);

  await page.getByTestId("settings-name").fill("");
  await expect(page.getByTestId("settings-problem")).toHaveText(
    "Give the project a name.",
  );
  await expect(page.getByTestId("settings-save")).toBeDisabled();
  await page.getByTestId("settings-name").fill("Docs Commons Plus");
  await page.getByTestId("settings-save").click();
  await expect
    .poll(
      () =>
        relay.events.filter(
          (e) =>
            e.kind === 37001 &&
            e.tags.some((t) => t[1] === "Docs Commons Plus"),
        ).length,
      { timeout: 20_000 },
    )
    .toBe(1);
  // Only the name changed: its DAO, Shares, work areas and how it is funded are republished as they were.
  const saved = relay.events.find(
    (e) => e.kind === 37001 && e.tags.some((t) => t[1] === "Docs Commons Plus"),
  );
  expect(saved?.tags).toContainEqual(["treasury", DAO]);
  expect(saved?.tags).toContainEqual(["token", SHARES]);
  const content = JSON.parse(saved?.content ?? "{}");
  expect(content.funding?.path).toBe("contributors");
  expect(content.tokenPlan?.mode).toBe("dao");
  expect(content.workAreas).toEqual([
    { name: "docs", check: "The pages are merged and reviewed" },
  ]);
  await expect(page.getByTestId("settings-remove")).toBeVisible();
});

test("a contributor project's decisions keep undoing a freeze, and offer money decisions only for money it has", async ({
  page,
}) => {
  const { selectorOf } = await import(
    "../../../packages/creaton-core/src/launchpad/evmAbi.ts"
  );
  const relay = createMockRelay();
  relay.seed(record);
  await relay.install(page);
  await installChain(page);
  await signIn(page);
  await page.route("**/test-rpc", async (route) => {
    const body = route.request().postDataJSON();
    let result: unknown;
    if (body.method === "eth_getBlockByNumber")
      result = { number: "0x20", timestamp: "0x68000000" };
    if (
      body.method === "eth_call" &&
      [
        selectorOf("getProposalCount()"),
        selectorOf("proposalThreshold()"),
      ].includes(body.params?.[0]?.data)
    )
      result = `0x${word(0n)}`;
    if (result === undefined) return route.fallback();
    return route.fulfill({ json: { jsonrpc: "2.0", id: body.id, result } });
  });
  await page.goto(`/launchpad/docs-commons?author=${ME}&tab=decisions`);
  await page.getByTestId("decision-new").click({ timeout: 20_000 });
  await expect(page.getByTestId("decision-kind-freeze")).toBeVisible();
  // The way back from a freeze is always offered, in words without money.
  await expect(page.getByTestId("decision-kind-unwind")).toContainText(
    "End a frozen submission for good",
  );
  // This DAO holds no USDC (none on this network here): paying from the treasury is not offered.
  await expect(page.getByTestId("decision-kind-pay")).toHaveCount(0);
});
