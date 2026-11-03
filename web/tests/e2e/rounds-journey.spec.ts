import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test, type Page } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";

import { installAnvilWallet } from "../helpers/anvil-wallet";
import { PREVIEW_ORIGIN } from "./mock-relay";

/**
 * Weekly rounds (D131) from pages, against a REAL chain: a member who wants out is matched with two people who want in,
 * and the treasury keeps its money.
 *
 * Opt-in: `scripts/web-rounds-e2e.sh` boots the chain (a local dev chain, or with `--sepolia-fork` a fork of Sepolia
 * with the Sepolia deploy's contracts), builds the app for it, and runs this spec. The founder starts a contributor
 * project and puts 200 USDC in its treasury, so leaving pays 1 USDC a Share. The DAO votes weekly rounds in; 30 days
 * later a newcomer switches them on and opens a round. The founder offers 50 Shares at 1 USDC or more; the newcomer and
 * a second buyer each bid for 30 at up to 1.30. Three days later the newcomer settles it, and everyone collects: the
 * founder 62 USDC (65, less a fifth of the 15 gained above what leaving pays), the treasury 3 more and nothing paid out,
 * each buyer 25 Shares. Later, once funding terms charge a 2% exit fee, a second holders' round trades nothing: the card
 * keeps round one's trade with its date, lists the second as "Nothing traded", and says what leaving pays after the fee
 * there and on the Overview (D147). What is stubbed: the relay and the wallets (`window.ethereum` forwarding to Anvil's
 * accounts).
 */

const ANVIL_URL = process.env.E2E_ANVIL_URL ?? "";
const KIT = process.env.E2E_KIT ?? "";
const ROUNDS = process.env.E2E_WEEKLY_ROUNDS ?? "";
const CURRENCY = process.env.E2E_CURRENCY ?? "";
const REVIEWER1 = process.env.E2E_REVIEWER1 ?? "";
const REVIEWER2 = process.env.E2E_REVIEWER2 ?? "";
// A third reviewer nobody acts as: a new project names at least three, two of whom decide (funding review D1).
const REVIEWER3 = "0x00000000000000000000000000000000000000c3";
/** Someone with money and no Shares, who wants in. */
const NEWCOMER = process.env.E2E_MANAGER ?? "";
/** A second buyer, with money of their own. */
const SECOND = process.env.E2E_CONTRIBUTOR ?? "";
const FOUNDER_WALLET =
  process.env.E2E_FOUNDER ?? "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const NSEC = "55".repeat(32);
const FOUNDER = getPublicKey(
  Uint8Array.from(NSEC.match(/.{2}/g) ?? [], (b) => Number.parseInt(b, 16)),
);
const NEWCOMER_NSEC = "66".repeat(32);
const SECOND_NSEC = "77".repeat(32);
/** `ContributorProjectLaunched(address,address,address,bytes32,uint256)`. */
const LAUNCHED =
  "0x7f4eb55556e4a4d7639e36b6ec8b0e6d4ab4fcfff92dd9c201bed8e870716583";
const E18 = 10n ** 18n;
const USD = 1_000_000n;

test.skip(
  !ANVIL_URL || !KIT || !ROUNDS || !CURRENCY || !NEWCOMER || !SECOND,
  "set E2E_ANVIL_URL, E2E_KIT, E2E_WEEKLY_ROUNDS, E2E_CURRENCY, E2E_MANAGER and E2E_CONTRIBUTOR (scripts/web-rounds-e2e.sh does)",
);

async function rpc(method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(ANVIL_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: unknown; error?: unknown };
  if (body.error) throw new Error(JSON.stringify(body.error));
  return body.result;
}

/**
 * Send a raw transaction and prove it landed.
 *
 * `eth_sendTransaction` answers with a hash even when the transaction reverts,
 * and its JSON-RPC `error` field stays empty — so a reverted call used to look
 * like a success here and only showed up much later as a wrong balance. Mine a
 * block, read the receipt, and refuse anything that is not status 1.
 */
async function sendTx(tx: Record<string, unknown>): Promise<{
  hash: string;
  contractAddress: string | null;
}> {
  const hash = String(await rpc("eth_sendTransaction", [tx]));
  await rpc("anvil_mine", ["0x1"]);
  const receipt = (await rpc("eth_getTransactionReceipt", [hash])) as {
    status?: string;
    contractAddress?: string | null;
  } | null;
  if (!receipt) throw new Error(`no receipt for ${hash}`);
  if (receipt.status !== "0x1") {
    throw new Error(
      `transaction ${hash} did not succeed (status ${receipt.status})`,
    );
  }
  return { hash, contractAddress: receipt.contractAddress ?? null };
}

async function call(to: string, data: string): Promise<string> {
  return String(await rpc("eth_call", [{ to, data }, "latest"]));
}

const addressArg = (address: string) =>
  address.slice(2).toLowerCase().padStart(64, "0");
const amountArg = (amount: bigint) => amount.toString(16).padStart(64, "0");
const wordAddress = (hex: string) => `0x${hex.slice(-40)}`;
const usdcOf = async (who: string) =>
  BigInt(await call(CURRENCY, `0x70a08231${addressArg(who)}`));

/** A round's day as the card writes it: when its bidding closed. */
const dayOf = (seconds: bigint) =>
  new Date(Number(seconds) * 1000).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
  });

/** USDC as the card writes it: at most two decimals, cut, not rounded. */
const usdcText = (units: bigint) => {
  const cents = ((units % USD) / 10_000n)
    .toString()
    .padStart(2, "0")
    .replace(/0+$/, "");
  return `${(units / USD).toLocaleString("en-US")}${cents ? `.${cents}` : ""} USDC`;
};

/** A round's bidding close, from `rounds(id)` (its fourth word). */
const closesAtOf = async (id: bigint) =>
  BigInt(
    `0x${(await call(ROUNDS, `0x8c65c81f${amountArg(id)}`)).slice(2 + 3 * 64, 2 + 4 * 64)}`,
  );

/** Let time pass on the chain, the way waiting would. */
async function pass(seconds: number) {
  await rpc("anvil_increaseTime", [seconds]);
  await rpc("anvil_mine", ["0x1"]);
}

/** Everything the pages publish, served back to every page that asks for its kind. */
const published: { id: string; kind: number }[] = [];

async function open(page: Page, wallet: string, path: string, nsec = NSEC) {
  await page.routeWebSocket(PREVIEW_ORIGIN, (ws) => {
    ws.onMessage((message) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(message));
      } catch {
        return;
      }
      if (!Array.isArray(parsed)) return;
      if (parsed[0] === "EVENT") {
        const event = parsed[1] as { id: string; kind: number };
        if (!published.some((known) => known.id === event.id))
          published.push(event);
        ws.send(JSON.stringify(["OK", event.id, true, ""]));
        return;
      }
      if (parsed[0] !== "REQ") return;
      const [, subId, filter] = parsed as [
        string,
        string,
        { kinds?: number[] },
      ];
      for (const event of published) {
        if (filter.kinds?.includes(event.kind))
          ws.send(JSON.stringify(["EVENT", subId, event]));
      }
      ws.send(JSON.stringify(["EOSE", subId]));
    });
  });
  await installAnvilWallet(page, wallet, { rpcUrl: ANVIL_URL });
  await page.addInitScript(
    ([nsec, rpcUrl]) => {
      window.localStorage.setItem("buzz.identity.nsec", nsec);
      window.localStorage.setItem("buzz.identity.backedUp", "1");
      window.localStorage.setItem("buzz.launchpad.rpc", rpcUrl);
    },
    [nsec, ANVIL_URL],
  );
  await page.goto(path);
}

const projectPath = (tab: string) =>
  `/launchpad/rounds-commons?author=${FOUNDER}&tab=${tab}`;

async function refresh(page: Page, tab: "Decisions" | "Funds") {
  await page.reload();
  await page.getByRole("tab", { name: tab }).click();
}

/** Back the newest decision, let its review pass, start its wait, let that pass, run it: each press the founder's. */
async function carryOut(
  page: Page,
  toApprove: number,
  toWait: number,
  backing = 200,
) {
  const card = page.getByTestId("decision-card").first();
  await expect(card.getByTestId("decision-status")).toHaveText(
    "Collecting support",
    { timeout: 30_000 },
  );
  await card.getByTestId("decision-vote-for").click();
  await expect(card.getByTestId("decision-support")).toContainText(
    `Backing ${backing}`,
    { timeout: 30_000 },
  );
  await pass(toApprove);
  await refresh(page, "Decisions");
  const next = page.getByTestId("decision-card").first();
  await expect(next.getByTestId("decision-status")).toHaveText("Approved", {
    timeout: 30_000,
  });
  await next.getByTestId("decision-start-wait").click();
  await expect(next.getByTestId("decision-status")).toHaveText(
    "Waiting to take effect",
    { timeout: 30_000 },
  );
  await pass(toWait);
  await refresh(page, "Decisions");
  const ready = page.getByTestId("decision-card").first();
  await expect(ready.getByTestId("decision-status")).toHaveText(
    "Ready to take effect",
    { timeout: 30_000 },
  );
  await ready.getByTestId("decision-run").click();
  await expect(ready.getByTestId("decision-status")).toHaveText("Done", {
    timeout: 30_000,
  });
}

test("a member who wants out is matched with two who want in, and the treasury keeps its money", async ({
  context,
}) => {
  test.setTimeout(Number(process.env.E2E_TIMEOUT_MS ?? 600_000));

  // ── 1. the founder starts a contributor project and puts 200 USDC in its treasury ──────────────────
  const founder = await context.newPage();
  await open(founder, FOUNDER_WALLET, "/start");
  await founder.getByTestId("start-go-contributor").click();
  await founder.getByTestId("contributor-name").fill("Rounds Commons");
  await founder
    .getByTestId("contributor-pitch")
    .fill("A small project whose members can sell to newcomers each week.");
  await founder.getByTestId("contributor-founder-shares").fill("200");
  await founder.getByTestId("contributor-budget-shares").fill("600");
  await founder.getByTestId("contributor-project-cap").fill("40");
  await founder
    .getByTestId("contributor-reviewers")
    .fill(`${REVIEWER1}\n${REVIEWER2}\n${REVIEWER3}`);
  await founder
    .getByTestId("contributor-reviewer-ties")
    .fill(
      "Both reviewers are test accounts; the third is a stand-in nobody acts as.",
    );
  await founder.getByTestId("contributor-project-name").fill("docs");
  await founder
    .getByTestId("contributor-project-check")
    .fill("docs merged and reviewed");
  await expect(founder.getByTestId("contributor-gate")).toHaveCount(0, {
    timeout: 20_000,
  });
  const blockBefore = BigInt(String(await rpc("eth_blockNumber")));
  await founder.getByTestId("contributor-submit").click();
  await expect(founder.getByTestId("contributor-done")).toBeVisible({
    timeout: 120_000,
  });
  const launched = (
    (await rpc("eth_getLogs", [
      {
        address: KIT,
        fromBlock: `0x${blockBefore.toString(16)}`,
        toBlock: "latest",
      },
    ])) as { topics: string[] }[]
  ).filter((log) => log.topics[0] === LAUNCHED);
  expect(launched).toHaveLength(1);
  const dao = wordAddress(launched[0].topics[2]);
  const shares = wordAddress(await call(dao, "0x03314efa"));
  const sharesOf = async (holder: string) =>
    BigInt(await call(shares, `0x70a08231${addressArg(holder)}`));
  await sendTx({
    from: FOUNDER_WALLET,
    to: CURRENCY,
    data: `0xa9059cbb${addressArg(dao)}${amountArg(200n * USD)}`,
  });
  expect(await usdcOf(dao)).toBe(200n * USD);

  // ── 2. the DAO votes weekly rounds in; the vote can't switch them on ──────────────────────────────
  await founder.getByTestId("contributor-open-project").click();
  await refresh(founder, "Funds");
  await expect(founder.getByTestId("rounds-state")).toContainText(
    "This project has no weekly rounds yet.",
    { timeout: 30_000 },
  );
  await refresh(founder, "Decisions");
  await founder.getByTestId("decision-new").click();
  await founder.getByTestId("decision-kind-rounds").click();
  await expect(founder.getByTestId("decision-draft-title")).toHaveText(
    "Start weekly rounds in 30 days",
    { timeout: 30_000 },
  );
  await founder.getByTestId("decision-draft-submit").click();
  await expect(founder.getByTestId("decision-opened")).toBeVisible({
    timeout: 60_000,
  });
  // A vote on the Shares takes the full vote: two days' review and twelve hours' hold.
  await carryOut(founder, 175_000, 90_000);
  // `pendingExitExchange()` names the rounds.
  expect(wordAddress(await call(shares, "0x6cb21d83"))).toBe(
    ROUNDS.toLowerCase(),
  );
  await refresh(founder, "Funds");
  await expect(founder.getByTestId("rounds-state")).toContainText(
    "A vote started weekly rounds. They can be switched on from",
    { timeout: 30_000 },
  );
  await expect(founder.getByTestId("rounds-switch-on")).toHaveCount(0);

  // ── 3. 30 days later a newcomer switches them on and opens this week's round ────────────────────
  await pass(30 * 86_400);
  const buyer = await context.newPage();
  await open(buyer, NEWCOMER, projectPath("treasury"), NEWCOMER_NSEC);
  await buyer.getByTestId("rounds-switch-on").click();
  await expect(buyer.getByTestId("rounds-state")).toContainText(
    "never below what leaving pays",
    { timeout: 60_000 },
  );
  await buyer.getByTestId("rounds-open").click();
  await expect(buyer.getByTestId("rounds-round-status")).toContainText(
    "Taking offers and bids until",
    { timeout: 60_000 },
  );
  await expect(buyer.getByTestId("rounds-round")).toContainText(
    "Floor at opening: 1 USDC a Share",
  );
  // No funding terms yet, so leaving charges no fee.
  await expect(buyer.getByTestId("rounds-leaving")).toHaveText(
    "Leaving now pays about 1 USDC a Share.",
  );
  await expect(buyer.getByTestId("rounds-last-trade")).toHaveText(
    "No trades yet.",
  );
  const firstRound = BigInt(await call(ROUNDS, `0x61f6b445${addressArg(dao)}`));

  // ── 4. the founder offers 50 Shares at 1 USDC or more; two buyers bid for 30 each at up to 1.30 ────
  await refresh(founder, "Funds");
  await founder.getByTestId("rounds-offer-open").click({ timeout: 30_000 });
  await founder.getByTestId("rounds-offer-amount").fill("201");
  await founder.getByTestId("rounds-offer-price").fill("1");
  await expect(founder.getByTestId("rounds-offer-plan-problem")).toHaveText(
    "You can offer up to 200 Shares.",
  );
  await founder.getByTestId("rounds-offer-amount").fill("50");
  await expect(founder.getByTestId("rounds-offer-plan")).toContainText(
    "you keep 1 USDC a Share after the treasury's cut",
  );
  await expect(founder.getByTestId("rounds-offer-plan")).toContainText(
    "Leaving now pays about 1 USDC a Share.",
  );
  await founder.getByTestId("rounds-offer-submit").click();
  await expect(founder.getByTestId("rounds-my-sell")).toHaveText(
    "You offer 50 Shares at 1 USDC or more.",
    { timeout: 60_000 },
  );
  expect(await sharesOf(FOUNDER_WALLET)).toBe(150n * E18);

  await refresh(buyer, "Funds");
  await buyer.getByTestId("rounds-bid-open").click({ timeout: 30_000 });
  await buyer.getByTestId("rounds-bid-amount").fill("30");
  await buyer.getByTestId("rounds-bid-price").fill("0.9");
  await expect(buyer.getByTestId("rounds-bid-plan-problem")).toHaveText(
    "Bid at least 1 USDC a Share: what leaving pays.",
  );
  await buyer.getByTestId("rounds-bid-price").fill("1.30");
  await expect(buyer.getByTestId("rounds-bid-plan")).toContainText(
    "This bid holds 39 USDC until the round settles.",
  );
  await buyer.getByTestId("rounds-bid-submit").click();
  await expect(buyer.getByTestId("rounds-my-bid")).toHaveText(
    "You bid for 30 Shares at up to 1.3 USDC.",
    { timeout: 60_000 },
  );

  const second = await context.newPage();
  await open(second, SECOND, projectPath("treasury"), SECOND_NSEC);
  await second.getByTestId("rounds-bid-open").click({ timeout: 30_000 });
  await second.getByTestId("rounds-bid-amount").fill("30");
  await second.getByTestId("rounds-bid-price").fill("1.3");
  await second.getByTestId("rounds-bid-submit").click();
  await expect(second.getByTestId("rounds-clearing")).toHaveText(
    "If bidding ended now: 50 Shares at 1.3 USDC each.",
    { timeout: 60_000 },
  );
  await expect(second.getByTestId("rounds-row")).toHaveCount(2);
  // While a round takes bids, the next one is not announced yet.
  await expect(second.getByTestId("rounds")).not.toContainText(
    "Next round from",
  );
  if (process.env.E2E_SHOTS) {
    await second
      .getByTestId("rounds")
      .screenshot({ path: `${process.env.E2E_SHOTS}/rounds-bidding.png` });
  }

  // ── 5. bidding ends; the newcomer settles it; everyone collects ───────────────────────────────
  await pass(3 * 86_400);
  await refresh(buyer, "Funds");
  await expect(buyer.getByTestId("rounds-round-status")).toContainText(
    "Bidding is over. Anyone can settle it until",
    { timeout: 30_000 },
  );
  await buyer.getByTestId("rounds-settle").click();
  await expect(buyer.getByTestId("rounds-clearing")).toHaveText(
    "50 Shares at 1.3 USDC each changed hands.",
    { timeout: 60_000 },
  );
  await expect(buyer.getByTestId("rounds-my-bid")).toContainText(
    "Bought: 25 Shares, for 32.5 USDC.",
  );
  // The trade is dated by when bidding closed, not by when it was settled.
  const firstTrade = `Last trade: 50 Shares at 1.3 USDC each, round ${firstRound} (${dayOf(await closesAtOf(firstRound))}).`;
  await expect(buyer.getByTestId("rounds-last-trade")).toHaveText(firstTrade);

  const founderMoney = await usdcOf(FOUNDER_WALLET);
  await refresh(founder, "Funds");
  await expect(founder.getByTestId("rounds-my-sell")).toContainText(
    "Sold: 50 Shares, for 62 USDC after the cut.",
    { timeout: 30_000 },
  );
  await founder.getByTestId("rounds-collect").click();
  await expect(founder.getByTestId("rounds-my-sell")).toContainText(
    "Collected.",
    { timeout: 60_000 },
  );
  expect(await usdcOf(FOUNDER_WALLET)).toBe(founderMoney + 62n * USD);
  expect(await usdcOf(dao)).toBe(203n * USD);

  const buyerMoney = await usdcOf(NEWCOMER);
  await buyer.getByTestId("rounds-collect").click();
  await expect(buyer.getByTestId("rounds-my-bid")).toContainText("Collected.", {
    timeout: 60_000,
  });
  expect(await sharesOf(NEWCOMER)).toBe(25n * E18);
  // 39 held, 32.50 paid: 6.50 comes back.
  expect(await usdcOf(NEWCOMER)).toBe(buyerMoney + 6_500_000n);

  await refresh(second, "Funds");
  await second.getByTestId("rounds-collect").click({ timeout: 30_000 });
  await expect(second.getByTestId("rounds-my-bid")).toContainText(
    "Collected.",
    { timeout: 60_000 },
  );
  expect(await sharesOf(SECOND)).toBe(25n * E18);
  expect(await sharesOf(ROUNDS)).toBe(0n);
  await expect(second.getByTestId("rounds-collect")).toHaveCount(0);
  if (process.env.E2E_SHOTS) {
    await second
      .getByTestId("rounds")
      .screenshot({ path: `${process.env.E2E_SHOTS}/rounds-settled.png` });
  }
  // The next round can open a week after this one did.
  await expect(second.getByTestId("rounds")).toContainText("Next round from");

  // ── 6. the DAO publishes funding terms: Loot for buyers, at most 100 new units ever (D133) ────────────
  // More money in the treasury first, so leaving pays 1.50 a unit (300 USDC, 200 units).
  await sendTx({
    from: FOUNDER_WALLET,
    to: CURRENCY,
    data: `0xa9059cbb${addressArg(dao)}${amountArg(97n * USD)}`,
  });
  expect(await usdcOf(dao)).toBe(300n * USD);
  await refresh(founder, "Funds");
  await expect(
    founder.getByTestId("funding").getByTestId("funding-state"),
  ).toContainText("This project sells no new shares.", { timeout: 30_000 });
  await refresh(founder, "Decisions");
  await founder.getByTestId("decision-new").click();
  await founder.getByTestId("decision-kind-funding").click();
  await founder
    .getByTestId("funding-cap-input")
    .fill("100", { timeout: 30_000 });
  await expect(founder.getByTestId("decision-draft-title")).toHaveText(
    "Set a funding limit of 100 new non-voting shares",
  );
  await founder.getByTestId("decision-draft-submit").click();
  await expect(founder.getByTestId("decision-opened")).toBeVisible({
    timeout: 60_000,
  });
  await carryOut(founder, 175_000, 90_000, 150);
  await refresh(founder, "Funds");
  const funding = founder.getByTestId("funding");
  await expect(funding.getByTestId("funding-state")).toContainText(
    "Funding terms were published. Sales can start from",
    { timeout: 30_000 },
  );
  await expect(funding.getByTestId("funding-instrument")).toHaveText(
    "Buyers get non-voting shares, with no vote",
  );
  // The form's default exit fee: 2%, not charged during the notice.
  await expect(funding.getByTestId("funding-exit-fee")).toHaveText(
    "Exit fee 2%",
  );

  // ── 7. 30 days later, a vote opens a sale: 40 new units at 1.65 or more, for 60 days ────────────
  await pass(30 * 86_400);
  await refresh(founder, "Decisions");
  await founder.getByTestId("decision-new").click();
  await founder.getByTestId("decision-kind-funding").click();
  await founder.getByTestId("funding-quantity-input").fill("40", {
    timeout: 30_000,
  });
  await founder.getByTestId("funding-price-input").fill("1.65");
  await founder.getByTestId("funding-days-input").fill("60");
  await expect(founder.getByTestId("decision-draft-title")).toHaveText(
    "Sell up to 40 new shares for the project",
  );
  await founder.getByTestId("decision-draft-submit").click();
  await expect(founder.getByTestId("decision-opened")).toBeVisible({
    timeout: 60_000,
  });
  await carryOut(founder, 175_000, 90_000, 150);

  // ── 8. a funding round: the newcomer opens it and bids; the second buyer too ────────────────────
  await refresh(buyer, "Funds");
  const buyerFunding = buyer.getByTestId("funding");
  await expect(buyerFunding.getByTestId("funding-state")).toContainText(
    "On sale for the project: 40 new non-voting shares at 1.65 USDC each or more",
    { timeout: 30_000 },
  );
  await expect(
    buyerFunding.getByTestId("funding-before-you-buy"),
  ).toContainText("no yearly limit");
  await expect(
    buyerFunding.getByTestId("funding-before-you-buy"),
  ).toContainText("Leaving keeps 2% of what it pays in the treasury");
  await buyerFunding.getByTestId("funding-open-round").click();
  await expect(buyerFunding.getByTestId("rounds-round-status")).toContainText(
    "Taking offers and bids until",
    { timeout: 60_000 },
  );
  await buyerFunding.getByTestId("rounds-bid-open").click();
  await buyerFunding.getByTestId("rounds-bid-amount").fill("30");
  await buyerFunding.getByTestId("rounds-bid-price").fill("1.80");
  await expect(buyerFunding.getByTestId("rounds-bid-plan")).toContainText(
    "This bid holds 54 USDC until the round settles.",
  );
  await buyerFunding.getByTestId("rounds-bid-submit").click();
  await expect(buyerFunding.getByTestId("rounds-my-bid")).toHaveText(
    "You bid for 30 new non-voting shares at up to 1.8 USDC.",
    { timeout: 60_000 },
  );
  await refresh(second, "Funds");
  const secondFunding = second.getByTestId("funding");
  await secondFunding.getByTestId("rounds-bid-open").click({ timeout: 30_000 });
  await secondFunding.getByTestId("rounds-bid-amount").fill("30");
  await secondFunding.getByTestId("rounds-bid-price").fill("1.65");
  await secondFunding.getByTestId("rounds-bid-submit").click();
  await expect(secondFunding.getByTestId("rounds-clearing")).toHaveText(
    "If bidding ended now: 40 new non-voting shares at 1.65 USDC each.",
    { timeout: 60_000 },
  );
  // The round holds the whole sale, and it is still on sale until the round settles.
  await expect(secondFunding.getByTestId("funding-state")).toContainText(
    "On sale for the project: 40 new non-voting shares at 1.65 USDC each or more",
  );
  if (process.env.E2E_SHOTS) {
    await secondFunding.screenshot({
      path: `${process.env.E2E_SHOTS}/funding-bidding.png`,
    });
  }

  // ── 9. settled at 1.65: the newcomer gets 30 Loot, the second buyer the 10 left; 66 USDC to the treasury ──
  await pass(3 * 86_400);
  await refresh(buyer, "Funds");
  await buyer
    .getByTestId("funding")
    .getByTestId("rounds-settle")
    .click({ timeout: 30_000 });
  await expect(
    buyer.getByTestId("funding").getByTestId("rounds-clearing"),
  ).toHaveText(
    "40 new non-voting shares at 1.65 USDC each were sold for the project.",
    { timeout: 60_000 },
  );
  // Settling created the 40 units and paid the treasury, before anyone collects.
  expect(await usdcOf(dao)).toBe(366n * USD);
  const loot = wordAddress(await call(dao, "0x9b7b2ab0"));
  const lootOf = async (holder: string) =>
    BigInt(await call(loot, `0x70a08231${addressArg(holder)}`));
  const newcomerMoney = await usdcOf(NEWCOMER);
  await buyer.getByTestId("funding").getByTestId("rounds-collect").click();
  await expect(
    buyer.getByTestId("funding").getByTestId("rounds-my-bid"),
  ).toContainText("Collected.", { timeout: 60_000 });
  expect(await lootOf(NEWCOMER)).toBe(30n * E18);
  // 54 held, 49.50 paid: 4.50 comes back.
  expect(await usdcOf(NEWCOMER)).toBe(newcomerMoney + 4_500_000n);
  await refresh(second, "Funds");
  await second
    .getByTestId("funding")
    .getByTestId("rounds-collect")
    .click({ timeout: 30_000 });
  await expect(
    second.getByTestId("funding").getByTestId("rounds-my-bid"),
  ).toContainText("Collected.", { timeout: 60_000 });
  expect(await lootOf(SECOND)).toBe(10n * E18);
  expect(await usdcOf(dao)).toBe(366n * USD);
  await refresh(second, "Funds");
  await expect(
    second.getByTestId("funding").getByTestId("funding-sold"),
  ).toHaveText("40 sold of a current funding limit of 100", {
    timeout: 30_000,
  });
  if (process.env.E2E_SHOTS) {
    await second.getByTestId("funding").screenshot({
      path: `${process.env.E2E_SHOTS}/funding-settled.png`,
    });
  }

  // ── 10. the newcomer leaves with their 25 Shares: past the notice, the terms' 2% stays in the treasury ──
  const supplyOf = async (token: string) =>
    BigInt(await call(token, "0x18160ddd"));
  const guard = wordAddress(await call(shares, "0x36bc529d"));
  const lockedTotal = /^0x0{40}$/.test(guard)
    ? 0n
    : BigInt(await call(guard, "0x56891412"));
  const canLeave =
    (await supplyOf(shares)) +
    (await supplyOf(loot)) -
    (await sharesOf(dao)) -
    (await lootOf(dao)) -
    lockedTotal;
  const whole = (366n * USD * 25n * E18) / canLeave;
  const owed = whole - (whole * 200n) / 10_000n;
  const beforeExit = await usdcOf(NEWCOMER);
  await refresh(buyer, "Funds");
  await expect(buyer.getByTestId("ragequit-exit-fee")).toContainText(
    "exit fee of 2%",
    { timeout: 30_000 },
  );
  await buyer.getByTestId("ragequit-exit").click();
  await buyer.getByTestId("ragequit-run").click();
  await expect(buyer.getByTestId("ragequit-done")).toBeVisible({
    timeout: 90_000,
  });
  expect(await usdcOf(NEWCOMER)).toBe(beforeExit + owed);
  expect(await usdcOf(dao)).toBe(366n * USD - owed);
  expect(await sharesOf(NEWCOMER)).toBe(0n);

  // ── 11. another token lands in the treasury: a holder stops sales over it from the Funding card (D136) ──
  const artifact = JSON.parse(
    readFileSync(
      resolve(
        process.cwd(),
        "../contracts/out/TreasuryMandate.t.sol/MandateCurrency.json",
      ),
      "utf8",
    ),
  ) as { bytecode: { object: string } };
  const deployed = await sendTx({
    from: FOUNDER_WALLET,
    data: artifact.bytecode.object,
  });
  if (!deployed.contractAddress) {
    throw new Error("the deploy did not create a contract");
  }
  const other = deployed.contractAddress.toLowerCase();
  await sendTx({
    from: FOUNDER_WALLET,
    to: other,
    data: `0x40c10f19${addressArg(dao)}${amountArg(1000n * E18)}`,
  });
  await refresh(second, "Funds");
  const secondCard = second.getByTestId("funding");
  await secondCard.getByTestId("funding-flag").click({ timeout: 30_000 });
  await secondCard.getByTestId("funding-flag-input").fill(other);
  await secondCard.getByTestId("funding-flag-submit").click();
  await expect(secondCard.getByTestId("funding-watched")).toContainText(other, {
    timeout: 60_000,
  });

  // ── 12. a second holders' round trades nothing: round one's trade stays, with its date (D147) ────────────
  const rounds = second.getByTestId("rounds");
  await rounds.getByTestId("rounds-open").click({ timeout: 30_000 });
  await expect(rounds.getByTestId("rounds-round-status")).toContainText(
    "Taking offers and bids until",
    { timeout: 60_000 },
  );
  const secondRound = BigInt(
    await call(ROUNDS, `0x61f6b445${addressArg(dao)}`),
  );
  expect(secondRound).toBeGreaterThan(firstRound);
  await pass(3 * 86_400);
  await refresh(second, "Funds");
  await rounds.getByTestId("rounds-settle").click({ timeout: 30_000 });
  await expect(rounds.getByTestId("rounds-clearing")).toHaveText(
    "Nothing traded: everyone takes back theirs.",
    { timeout: 60_000 },
  );
  await expect(rounds.getByTestId("rounds-last-trade")).toHaveText(firstTrade);
  const history = rounds.getByTestId("rounds-history-row");
  await expect(history).toHaveCount(2);
  await expect(history.nth(0)).toHaveText(
    `${dayOf(await closesAtOf(secondRound))}Nothing traded`,
  );
  await expect(history.nth(1)).toHaveText(
    `${dayOf(await closesAtOf(firstRound))}1.3 USDC50 Shares`,
  );
  // The terms' 2% exit fee is past its notice: what leaving pays is the floor now, less 2%.
  const floorNow = BigInt(await call(ROUNDS, `0xc2bc92b9${addressArg(dao)}`));
  const leaving = `Leaving now pays about ${usdcText(floorNow - (floorNow * 200n) / 10_000n)} a Share, after the 2% exit fee.`;
  await expect(rounds.getByTestId("rounds-leaving")).toHaveText(leaving);
  if (process.env.E2E_SHOTS) {
    await rounds.screenshot({
      path: `${process.env.E2E_SHOTS}/rounds-history.png`,
    });
  }
  await second.getByRole("tab", { name: "Overview" }).click();
  await expect(second.getByTestId("dao-leaving-now")).toHaveText(leaving, {
    timeout: 30_000,
  });
});
