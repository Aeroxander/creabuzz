import { expect, test, type Page } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";

import { expectAccessible } from "../helpers/a11y";
import { createMockRelay } from "./mock-relay";

/**
 * Contributor projects, in the browser, against a stubbed server and a stubbed chain (same-origin `/test-rpc`).
 *
 * The Start page offers the path and says plainly the project cannot raise money; a build that names no DAO maker for
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

const TOPIC_MANDATE_CREATED =
  "0x2a075deaacc4f205aa6d5c9cdadfaf7c96743415971a38b677820238f7a0965b";
const TOPIC_CONTRIBUTION_CONSUMED =
  "0x9bb4ec6ba5d3a80ea80a6926798482c0e41c1e10214a686fc8e8695253439e95";
const CALL = {
  votingWeight: "0x6f533638",
  mandateFactory: "0xb04b7bdb",
  shares: "0x03314efa",
  totalSupply: "0x18160ddd",
  claimProject: "0x84a95c5f",
  decimals: "0x313ce567",
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

/** Award events: Alice 25 for write-docs (project docs) and 15 for translate; Bob 10 for fix-search. 150 Shares in all. */
function awardLog(claim: string, who: string, shares: bigint, block: number) {
  return {
    address: BUDGET,
    topics: [TOPIC_CONTRIBUTION_CONSUMED, label(claim), `0x${word(who)}`],
    data: `0x${word(shares * E18)}`,
    blockNumber: `0x${block.toString(16)}`,
    transactionHash: `0x${"ab".repeat(32)}`,
    logIndex: "0x0",
  };
}

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
              ]
            : [],
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

test("Start offers a contributor project, says it cannot raise money, and shows who would hold what", async ({
  page,
}) => {
  const relay = createMockRelay();
  await relay.install(page);
  await installChain(page);
  await signIn(page);
  await page.goto("/start");

  const path = page.getByTestId("start-contributor");
  await expect(path).toContainText("The project cannot raise money");
  await path.getByTestId("start-go-contributor").click();
  await expect(page).toHaveURL(/\/start\/contributor$/);

  await expect(page.getByTestId("contributor-no-raise")).toContainText(
    "There is no sale. Nobody can buy Shares from the project",
  );
  await expect(page.getByTestId("contributor-no-raise")).toContainText(
    "Shares are earned only for accepted work",
  );

  // The short name follows the name until the founder types their own.
  await page.getByTestId("contributor-name").fill("Docs Commons");
  await expect(page.getByTestId("contributor-symbol")).toHaveValue("DOCS");
  await page
    .getByTestId("contributor-pitch")
    .fill("Open docs for everyone, written by the people who use them.");
  await expect(page.getByTestId("contributor-preview")).toContainText(
    "You start with 100,000 Shares. If all 100,000 in this budget are earned, contributors will hold 50% of all Shares and you 50%.",
  );
  await page.getByTestId("contributor-budget-shares").fill("300000");
  await expect(page.getByTestId("contributor-preview")).toContainText(
    "contributors will hold 75% of all Shares and you 25%",
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
  await expect(page.getByTestId("contributor-note")).toHaveText(
    "Nothing is for sale. Shares are earned only for accepted work.",
  );
  // Contributions come right after the overview for a project whose Shares only come from work.
  const tabs = page.getByRole("tab");
  await expect(tabs.nth(0)).toHaveText("Overview");
  await expect(tabs.nth(1)).toHaveText("Contributions");
  await expect(page.getByRole("tab", { name: "My bids" })).toHaveCount(0);

  // The figures are the chain's: 50 earned of 150, so 100 were the starting Shares.
  await expect(page.getByTestId("contributions-earned")).toHaveText(
    "50 (33.3% of all)",
  );
  await expect(page.getByTestId("contributions-not-from-work")).toHaveText(
    "100",
  );
  await expect(page.getByTestId("contributions-total")).toHaveText("150");

  const people = page.getByTestId("contribution-person");
  await expect(people).toHaveCount(2);
  await expect(
    people.nth(0).getByTestId("contribution-person-earned"),
  ).toHaveText("40 Shares, 26.7% of all");
  await expect(people.nth(0).getByTestId("contribution-award")).toHaveText([
    "15 Shares for translate",
    "25 Shares for write-docs in the project docs",
  ]);
  await expect(
    people.nth(1).getByTestId("contribution-person-earned"),
  ).toHaveText("10 Shares, 6.7% of all");
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
    "Nobody has earned Shares for work yet",
    { timeout: 20_000 },
  );
  await expect(page.getByTestId("contributions-not-from-work")).toHaveText(
    "150",
  );
});
