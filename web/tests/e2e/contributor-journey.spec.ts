import { expect, test, type Page } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";

import { installAnvilWallet } from "../helpers/anvil-wallet";

/**
 * A contributor project from start to award, entirely from pages, against a REAL local chain: no command line.
 *
 * Opt-in: `scripts/web-contributor-e2e.sh` boots the chain (with the contributor kit) and builds the app for it, then
 * runs this spec; `--sepolia-fork` runs it on a fork of Sepolia, built the way a hosted Sepolia build is. The founder
 * starts the project on the Start page: the form refuses the founder limits (D79) before anything is sent; then one
 * transaction makes its DAO with no sale, its first work budget and first project, and locks its Shares; then it is
 * published. Work starts at once, with no vote:
 * everything after is done in pages, each as the wallet of the person whose job it is. What is stubbed: the relay (it
 * keeps what pages publish and hands it to the others) and the wallets (`window.ethereum` forwarding to Anvil's
 * unlocked accounts).
 *
 * When the build names a matched-exit exchange (N5), the first journey ends with a sale between members: the DAO votes
 * the exchange in, 30 days later a newcomer switches it on, the contributor offers some of the Shares they earned at a
 * price they choose, and the newcomer buys them; the money goes to the contributor and the treasury is untouched.
 *
 * The second journey has several people earn (D84): two first projects at Start, a newcomer with no Shares suggests
 * work and asks for 5% of the project, the founder puts it to a vote filled in from the suggestion, and both people's
 * claims are taken on in their own projects, reviewed, paid and awarded by vote.
 */

const ANVIL_URL = process.env.E2E_ANVIL_URL ?? "";
const KIT = process.env.E2E_KIT ?? "";
/** The bounty contract on work areas (N1); without one the journey skips the bounty steps. */
const BOUNTY = process.env.E2E_BOUNTY ?? "";
/** The matched-exit exchange (N5); without one the journey skips the sales between members. */
const MATCHED_EXIT = process.env.E2E_MATCHED_EXIT ?? "";
/** The payout module factory (N10); without one the journey skips payouts. */
const PAYOUTS = process.env.E2E_PAYOUTS ?? "";
/** Remix bonds (N12) and the test CREATE faucet; without them the journey skips the bond. */
const REMIX_BONDS = process.env.E2E_REMIX_BONDS ?? "";
const CREATE_FAUCET = process.env.E2E_CREATE_FAUCET ?? "";
const REVIEWER1 = process.env.E2E_REVIEWER1 ?? "";
const REVIEWER2 = process.env.E2E_REVIEWER2 ?? "";
const CONTRIBUTOR = process.env.E2E_CONTRIBUTOR ?? "";
/** Someone with no Shares who suggests work and names a price (D84). */
const NEWCOMER = process.env.E2E_MANAGER ?? "";
const FOUNDER_WALLET =
  process.env.E2E_FOUNDER ?? "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const NSEC = "33".repeat(32);
const FOUNDER = getPublicKey(
  Uint8Array.from(NSEC.match(/.{2}/g) ?? [], (b) => Number.parseInt(b, 16)),
);
const NEWCOMER_NSEC = "44".repeat(32);
const CHECK = "docs merged and reviewed";
/** `ContributorProjectLaunched(address,address,address,bytes32,uint256)`. */
const LAUNCHED =
  "0x7f4eb55556e4a4d7639e36b6ec8b0e6d4ab4fcfff92dd9c201bed8e870716583";
const E18 = 10n ** 18n;

test.skip(
  !ANVIL_URL || !KIT || !CONTRIBUTOR,
  "set E2E_ANVIL_URL, E2E_KIT and E2E_CONTRIBUTOR (scripts/web-contributor-e2e.sh does)",
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

async function call(to: string, data: string): Promise<string> {
  return String(await rpc("eth_call", [{ to, data }, "latest"]));
}

const addressArg = (address: string) =>
  address.slice(2).toLowerCase().padStart(64, "0");
const wordAddress = (hex: string) => `0x${hex.slice(-40)}`;

/** Let time pass on the chain, the way waiting would. */
async function pass(seconds: number) {
  await rpc("anvil_increaseTime", [seconds]);
  await rpc("anvil_mine", ["0x1"]);
}

/** The kit's launch events from `block` on. */
async function launchedSince(block: bigint) {
  return (
    (await rpc("eth_getLogs", [
      {
        address: KIT,
        fromBlock: `0x${block.toString(16)}`,
        toBlock: "latest",
      },
    ])) as { topics: string[]; data: string }[]
  ).filter((log) => log.topics[0] === LAUNCHED);
}

/** Set once the first journey published Docs Commons, which invites projects built on it: the second must then use it. */
let docsCommonsPublished = false;

/** Set by a test: the stub server refuses work areas' words until it is cleared. */
let refuseWorkAreaWords = false;

/** Everything the pages publish, served back to every page that asks for its kind (the launch record, the evidence). */
const published: { id: string; kind: number }[] = [];

async function open(
  page: Page,
  wallet: string | null,
  path: string,
  nsec = NSEC,
) {
  await page.routeWebSocket(/127\.0\.0\.1:4173/, (ws) => {
    ws.onMessage((message) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(message));
      } catch {
        return;
      }
      if (!Array.isArray(parsed)) return;
      if (parsed[0] === "EVENT") {
        const event = parsed[1] as {
          id: string;
          kind: number;
          content?: string;
        };
        // While a test says so, the server refuses a work area's words (a failed publish to recover from).
        if (
          refuseWorkAreaWords &&
          event.kind === 47003 &&
          (event.content ?? "").includes('"workArea"')
        ) {
          ws.send(JSON.stringify(["OK", event.id, false, "blocked: not now"]));
          return;
        }
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
  if (wallet) await installAnvilWallet(page, wallet, { rpcUrl: ANVIL_URL });
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

const projectPath = (tab: string, slug = "docs-commons") =>
  `/launchpad/${slug}?author=${FOUNDER}&tab=${tab}`;

/** Re-read the page after the chain's clock moved. */
async function refresh(
  page: Page,
  tab: "Overview" | "Decisions" | "Work" | "Funds",
) {
  await page.reload();
  await page.getByRole("tab", { name: tab }).click();
}

/** Back the newest decision, let its review pass, start its wait, let that pass, run it: each press the founder's. */
async function carryOut(page: Page, toApprove: number, toWait: number) {
  const card = page.getByTestId("decision-card").first();
  await expect(card.getByTestId("decision-status")).toHaveText(
    "Collecting support",
    { timeout: 30_000 },
  );
  await card.getByTestId("decision-vote-for").click();
  await expect(card.getByTestId("decision-support")).toContainText(
    "Backing 200",
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

test("a contributor project is started from the page, work is claimed the same day, and the award shows on its contributions", async ({
  context,
}) => {
  // A fork reads state it has not seen yet from a public node, so it can be slower than a local chain.
  test.setTimeout(Number(process.env.E2E_TIMEOUT_MS ?? 600_000));

  // ── 1. the founder starts it: one transaction makes the DAO, its budget and first project; then it is published ──
  const founder = await context.newPage();
  await open(founder, FOUNDER_WALLET, "/start");
  await founder.getByTestId("start-go-contributor").click();
  await expect(founder.getByTestId("contributor-no-raise")).toContainText(
    "Starts without a token sale",
  );
  // Every network this journey runs on is a test network: Shares earned on it stay there.
  await expect(founder.getByTestId("contributor-test-records")).toContainText(
    "Shares earned here are test records: they will not move to a real network automatically.",
    { timeout: 20_000 },
  );
  await founder.getByTestId("contributor-name").fill("Docs Commons");
  await founder
    .getByTestId("contributor-pitch")
    .fill("Open docs for everyone, written by the people who use them.");
  await founder.getByTestId("contributor-founder-shares").fill("200");
  // Three times the founder's 200: the founder starts with at most a third of the first budget (D79).
  await founder.getByTestId("contributor-budget-shares").fill("600");
  await founder.getByTestId("contributor-project-cap").fill("40");
  await founder
    .getByTestId("contributor-reviewers")
    .fill(`${REVIEWER1}\n${REVIEWER2}`);
  await founder.getByTestId("contributor-project-name").fill("docs");
  await founder.getByTestId("contributor-project-check").fill(CHECK);
  // Others may build on Docs Commons (N11): the second journey's project does.
  await founder.getByTestId("contributor-remix-invited").check();
  await founder
    .getByTestId("contributor-remix-asks")
    .fill("Credit Docs Commons on your page.");
  docsCommonsPublished = true;
  await expect(founder.getByTestId("contributor-gate")).toHaveCount(0, {
    timeout: 20_000,
  });

  // The founder limits (D79), refused in the form before the wallet is asked: one Share above a third of the budget,
  // then the founder on the review panel. The kit refuses both too (the script checks it on the same chain).
  const refusedFrom = BigInt(String(await rpc("eth_blockNumber")));
  await founder.getByTestId("contributor-founder-shares").fill("201");
  await founder.getByTestId("contributor-submit").click();
  await expect(founder.getByTestId("contributor-problem")).toContainText(
    "Start with at most a third of the Shares the first budget can award",
  );
  await founder.getByTestId("contributor-founder-shares").fill("200");
  await founder
    .getByTestId("contributor-reviewers")
    .fill(`${REVIEWER1}\n${FOUNDER_WALLET}`);
  await founder.getByTestId("contributor-submit").click();
  await expect(founder.getByTestId("contributor-problem")).toContainText(
    "You cannot review the first budget's work yourself",
  );
  await founder
    .getByTestId("contributor-reviewers")
    .fill(`${REVIEWER1}\n${REVIEWER2}`);
  await expect(founder.getByTestId("contributor-problem")).toHaveCount(0);
  await expect(founder.getByTestId("contributor-run")).toHaveCount(0);
  expect(BigInt(String(await rpc("eth_blockNumber")))).toBe(refusedFrom);

  const blockBefore = BigInt(String(await rpc("eth_blockNumber")));
  await founder.getByTestId("contributor-submit").click();
  await expect(founder.getByTestId("contributor-done")).toBeVisible({
    timeout: 120_000,
  });
  // One wallet prompt: the whole project is one transaction.
  const sent = BigInt(String(await rpc("eth_blockNumber"))) - blockBefore;
  expect(sent).toBe(1n);

  // The chain agrees: the kit made one project for this founder, the founder holds its only Shares, nothing is for
  // sale, and the Shares cannot be sent between wallets.
  const launched = await launchedSince(blockBefore);
  expect(launched).toHaveLength(1);
  expect(wordAddress(launched[0].topics[1])).toBe(FOUNDER_WALLET.toLowerCase());
  const dao = wordAddress(launched[0].topics[2]);
  const shares = wordAddress(await call(dao, "0x03314efa"));
  const sharesOf = async (holder: string) =>
    BigInt(await call(shares, `0x70a08231${addressArg(holder)}`));
  expect(await sharesOf(FOUNDER_WALLET)).toBe(200n * E18);
  expect(BigInt(await call(shares, "0x18160ddd"))).toBe(200n * E18);
  const record = published.find((e) => e.kind === 37001) as
    | { content?: string }
    | undefined;
  const currency = (
    JSON.parse(record?.content ?? "{}") as { currency?: string }
  ).currency;
  expect(currency).toMatch(/^0x[0-9a-fA-F]{40}$/);
  // `sales(currency)`: no price, so nothing can be bought from the DAO.
  expect(
    BigInt(
      (await call(dao, `0xc6b9f06a${addressArg(currency as string)}`)).slice(
        0,
        66,
      ),
    ),
  ).toBe(0n);
  // `transfer(reviewer, 1)` from the founder is refused: the Shares are locked.
  await expect(
    rpc("eth_call", [
      {
        from: FOUNDER_WALLET,
        to: shares,
        data: `0xa9059cbb${addressArg(REVIEWER1)}${1n.toString(16).padStart(64, "0")}`,
      },
      "latest",
    ]),
  ).rejects.toThrow();

  // ── 2. the same day, with no vote: a contributor files a claim that asks for no money ──────────────
  await founder.getByTestId("contributor-open-project").click();
  await expect(founder.getByTestId("contributor-badge")).toHaveText(
    "Contributor project",
    { timeout: 30_000 },
  );
  // The header says what it is and, read from the Shares themselves, that they cannot be traded yet.
  await expect(founder.getByTestId("contributor-note")).toHaveText(
    "No token sale",
    { timeout: 30_000 },
  );
  await expect(founder.getByTestId("contributor-issuance")).toHaveText(
    "New Shares only for reviewed work",
    { timeout: 30_000 },
  );
  await expect(founder.getByTestId("contributor-transfers")).toHaveText(
    "Shares can't be sold",
    { timeout: 30_000 },
  );
  const contributor = await context.newPage();
  await open(contributor, CONTRIBUTOR, projectPath("work"));
  await expect(contributor.getByTestId("work-projects")).toContainText("docs", {
    timeout: 30_000,
  });
  // Nobody told them the words: the project's record published them at launch, and the chain's hash vouches for them.
  await submitFromWaysToHelp(
    contributor,
    "docs",
    CHECK,
    "write-docs",
    "https://example.com/pr/1",
  );
  // Their own work, waiting on someone else, is said on the project's page.
  await refresh(contributor, "Overview");
  await expect(contributor.getByTestId("dao-waiting")).toContainText(
    "Your “Write docs” is waiting for a work area's manager to accept it for review.",
    { timeout: 30_000 },
  );

  // Funds (D111): the DAO, checked against the kit's own launch event, what it holds, and the way to leave.
  await refresh(founder, "Funds");
  await expect(founder.getByTestId("contributor-funds-eth")).toBeVisible({
    timeout: 30_000,
  });
  await expect(founder.getByTestId("contributor-funds-unchecked")).toHaveCount(
    0,
  );
  await expect(founder.getByTestId("ragequit-panel")).toContainText(
    "Leave and take your share",
  );

  // ── 2b. outside money behind the work area (N1): the founder puts 25 behind "docs" before anyone is approved ──
  const usdcOf = async (holder: string) =>
    BigInt(await call(currency as string, `0x70a08231${addressArg(holder)}`));
  const docsArea = (page: Page) =>
    // The area's card wherever it is: under Open work while it takes work, under its budget once it does not.
    page.getByTestId("work-tab").locator('[data-area="docs"]');
  const contributorMoney = await usdcOf(CONTRIBUTOR);
  if (BOUNTY) {
    await refresh(founder, "Work");
    await docsArea(founder).getByTestId("work-bounty-open").click();
    await docsArea(founder).getByTestId("work-bounty-amount").fill("25");
    await docsArea(founder).getByTestId("work-bounty-submit").click();
    await expect(
      docsArea(founder).getByTestId("work-bounty-held"),
    ).toContainText("25", { timeout: 60_000 });
    await expect(
      docsArea(founder).getByTestId("work-bounty-status"),
    ).toContainText("Takes money until");
    expect(await usdcOf(BOUNTY)).toBe(25n * 10n ** 6n);
    // While it takes money, people add to it rather than start a second one.
    await expect(
      docsArea(founder).getByTestId("work-bounty-add"),
    ).toBeVisible();
    await expect(docsArea(founder).getByTestId("work-bounty-open")).toHaveCount(
      0,
    );
    if (process.env.E2E_SHOTS) {
      await docsArea(founder).screenshot({
        path: `${process.env.E2E_SHOTS}/bounty-open.png`,
      });
    }
    // Will it get done? (N3) The founder forecasts before anyone's work is approved.
    const forecast = docsArea(founder).getByTestId("forecast-panel");
    await forecast.getByTestId("forecast-percent").fill("70");
    await forecast
      .getByTestId("forecast-reason")
      .fill("Two people asked for the docs work already.");
    await forecast.getByTestId("forecast-submit").click();
    await expect(forecast.getByTestId("forecast-summary")).toHaveText(
      "Middle forecast: 70% · 1 person",
      { timeout: 30_000 },
    );
    // Money on hand (N4): the outside money shows on the front page; a project this young has no pace yet.
    await refresh(founder, "Overview");
    const runway = founder.getByTestId("dao-runway");
    await expect(runway.getByTestId("runway-outside")).toContainText("25", {
      timeout: 30_000,
    });
    await expect(runway.getByTestId("runway-pace")).toHaveText(
      "Not enough history yet: it started under three months ago.",
    );
    // Nothing was paid out: the money set aside is Shares, and outside money is not the project's spending.
    await expect(runway.getByTestId("runway-spent")).toHaveText(
      /^Paid out\s*0 d?USDC\s*0 d?USDC in the last three months$/,
    );
    if (process.env.E2E_SHOTS) {
      await runway.screenshot({
        path: `${process.env.E2E_SHOTS}/runway.png`,
      });
    }
  }

  // ── 3. the founder (the first project's manager) takes it on, two reviewers approve, it is finished ──
  // "Needs you" names the submission, and its button opens that claim on the Work tab.
  await refresh(founder, "Overview");
  const accept = founder
    .getByTestId("dao-attention")
    .filter({ hasText: "submitted “Write docs”" });
  await expect(accept).toContainText(
    "Accept it so the reviewers can judge it.",
    {
      timeout: 30_000,
    },
  );
  await accept.getByRole("button", { name: "Accept for review" }).click();
  await expect(founder.getByRole("tab", { name: "Work" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await founder.getByTestId("work-bind").click();
  await expect(founder.getByTestId("work-claim-next")).toContainText(
    "0 of 2 approvals",
    { timeout: 60_000 },
  );
  for (const account of [REVIEWER1, REVIEWER2]) {
    const reviewer = await context.newPage();
    await open(reviewer, account, projectPath("work"));
    await reviewer.getByTestId("work-approve").click();
    await expect(reviewer.getByTestId("work-claim-next")).not.toContainText(
      "0 of 2 approvals",
      { timeout: 60_000 },
    );
  }
  await refresh(founder, "Work");
  await founder.getByTestId("work-settle").click();
  await expect(founder.getByTestId("work-claim-status")).toContainText(
    "Approved",
    { timeout: 60_000 },
  );
  await pass(700_000);
  await refresh(contributor, "Work");
  await contributor.getByTestId("work-payout").click();
  // It asked for no money, so it finishes rather than pays.
  await expect(contributor.getByTestId("work-claim-status")).toContainText(
    "Finished",
    { timeout: 60_000 },
  );
  // No claim here can ask for money, so neither line says it did not.
  await expect(contributor.getByTestId("work-claim-status")).not.toContainText(
    "money",
  );
  await expect(contributor.getByTestId("work-claim-paid")).toContainText(
    "Finished",
    { timeout: 30_000 },
  );
  await expect(contributor.getByTestId("work-claim-paid")).not.toContainText(
    "money",
  );
  expect(await sharesOf(CONTRIBUTOR)).toBe(0n);

  // ── 3b. the bounty pays the approved work once its wait is over; anyone can press it, here the founder ──
  if (BOUNTY) {
    await refresh(founder, "Work");
    await docsArea(founder).getByTestId("work-bounty-pay").click();
    await expect(
      docsArea(founder).getByTestId("work-bounty-status"),
    ).toContainText("Paid 25", { timeout: 60_000 });
    expect(await usdcOf(CONTRIBUTOR)).toBe(contributorMoney + 25n * 10n ** 6n);
    expect(await usdcOf(BOUNTY)).toBe(0n);
    await expect(
      docsArea(founder)
        .getByTestId("forecast-panel")
        .getByTestId("forecast-outcome"),
    ).toHaveText("It got done. The middle forecast was 70%.");
    if (process.env.E2E_SHOTS) {
      await docsArea(founder).screenshot({
        path: `${process.env.E2E_SHOTS}/bounty-paid.png`,
      });
    }
  }

  // ── 4. the award is still the project's vote ────────────────────────────────────────────────────
  await refresh(founder, "Decisions");
  await founder.getByTestId("decision-new").click();
  await founder.getByTestId("decision-kind-award").click();
  await expect(founder.getByTestId("award-claim")).toBeVisible({
    timeout: 30_000,
  });
  await founder.getByTestId("award-shares").fill("25");
  await founder.getByTestId("decision-draft-submit").click();
  await expect(founder.getByTestId("decision-opened")).toBeVisible({
    timeout: 60_000,
  });
  await carryOut(founder, 90_000, 90_000);
  expect(await sharesOf(CONTRIBUTOR)).toBe(25n * E18);

  // ── 5. anyone, with no wallet, reads who earned what, for which work ────────────────────────────
  const reader = await context.newPage();
  await open(reader, null, projectPath("contributions"));
  const person = reader.getByTestId("contribution-person");
  await expect(person).toHaveCount(1, { timeout: 30_000 });
  await expect(person.getByTestId("contribution-person-name")).toContainText(
    CONTRIBUTOR.slice(2, 6),
    { ignoreCase: true },
  );
  // No name: the account is the label, shown once (with a name, it shows beside it, D111).
  await expect(person.getByTestId("contribution-person-account")).toHaveCount(
    0,
  );
  await expect(person.getByTestId("contribution-person-earned")).toHaveText(
    "25 Shares awarded",
  );
  // Read from the chain now: the Shares really reached them, and what they hold is beside what they were awarded.
  await expect(
    person.getByTestId("contribution-award-unconfirmed"),
  ).toHaveCount(0);
  await expect(person.getByTestId("contribution-person-held")).toHaveText(
    "Holds 25 now (11.1% of all Shares now).",
  );
  await expect(person.getByTestId("contribution-award-title")).toHaveText(
    "25 Shares for Write docs in the work area Docs",
  );
  // The story behind it: when it ran, how the review went, the transaction, and what they delivered in their own
  // words, shown because it hashes to what the claim committed to.
  const story = person.getByTestId("contribution-award-story");
  await expect(story).toContainText("Awarded ", { timeout: 30_000 });
  // Who approved it, by name or short account (D144), both reviewers of the two.
  await expect(story).toContainText("approved by ");
  await expect(story).toContainText(/approved by [^,]+, [^ ]+/);
  // The local chain has no public transaction page, so the story shows no transaction id.
  await expect(story.getByTestId("tx-link")).toHaveCount(0);
  // Evidence that is only a link is shown as the link, not quoted (D108).
  await expect(
    story.getByTestId("contribution-award-evidence"),
  ).not.toContainText("In their words");
  await expect(
    story.getByRole("link", { name: "Open what they delivered" }),
  ).toHaveAttribute("href", "https://example.com/pr/1");
  await expect(reader.getByTestId("contributions-earned")).toHaveText("25");
  // The founder's starting Shares, from the token's own mint at launch.
  await expect(reader.getByTestId("contributions-starting")).toHaveText("200");
  await expect(reader.getByTestId("contributions-test-records")).toContainText(
    "Shares earned here are test records",
  );
  if (process.env.E2E_SHOTS) {
    await reader
      .getByTestId("contributions-tab")
      .screenshot({ path: `${process.env.E2E_SHOTS}/contributions.png` });
  }

  // ── 6. a bounty nobody earns gives everyone their money back (N1) ─────────────────────────────────
  if (BOUNTY) {
    const founderMoney = await usdcOf(FOUNDER_WALLET);
    await refresh(founder, "Work");
    await docsArea(founder).getByTestId("work-bounty-open").click();
    await docsArea(founder).getByTestId("work-bounty-amount").fill("10");
    await docsArea(founder).getByTestId("work-bounty-submit").click();
    const second = docsArea(founder).getByTestId("work-bounty").last();
    await expect(second.getByTestId("work-bounty-status")).toContainText(
      "Takes money until",
      { timeout: 60_000 },
    );
    expect(await usdcOf(FOUNDER_WALLET)).toBe(founderMoney - 10n * 10n ** 6n);
    // The form's default deadline is the end of the day thirty days ahead; refunds open seven plus fourteen days after.
    await pass(53 * 86_400);
    await refresh(founder, "Work");
    const lapsed = docsArea(founder).getByTestId("work-bounty").last();
    await expect(lapsed.getByTestId("work-bounty-status")).toContainText(
      "No work was approved in time.",
      { timeout: 30_000 },
    );
    if (process.env.E2E_SHOTS) {
      await docsArea(founder).screenshot({
        path: `${process.env.E2E_SHOTS}/bounty-refunds.png`,
      });
    }
    await lapsed.getByTestId("work-bounty-refund").click();
    await expect(lapsed.getByTestId("work-bounty-refund")).toHaveCount(0, {
      timeout: 60_000,
    });
    expect(await usdcOf(FOUNDER_WALLET)).toBe(founderMoney);
  }

  // ── 7. a member who wants out sells to someone who wants in (N5) ────────────────────────────────
  if (MATCHED_EXIT) {
    const pendingExchange = async () =>
      wordAddress(await call(shares, "0x6cb21d83"));
    await refresh(founder, "Funds");
    await expect(founder.getByTestId("exit-sales-state")).toContainText(
      "Members can't sell Shares to each other here yet.",
      { timeout: 30_000 },
    );
    // The DAO votes the exchange in; the vote can't switch it on.
    await refresh(founder, "Decisions");
    await founder.getByTestId("decision-new").click();
    await founder.getByTestId("decision-kind-sales").click();
    await expect(founder.getByTestId("decision-draft-title")).toHaveText(
      "Allow sales between members in 30 days",
      { timeout: 30_000 },
    );
    await founder.getByTestId("decision-draft-submit").click();
    await expect(founder.getByTestId("decision-opened")).toBeVisible({
      timeout: 60_000,
    });
    // A vote on the Shares takes the full vote: two days' review and twelve hours' hold.
    await carryOut(founder, 175_000, 90_000);
    expect(await pendingExchange()).toBe(MATCHED_EXIT.toLowerCase());
    await refresh(founder, "Funds");
    await expect(founder.getByTestId("exit-sales-state")).toContainText(
      "They can start on",
      { timeout: 30_000 },
    );
    await expect(founder.getByTestId("exit-sales-switch-on")).toHaveCount(0);

    // 30 days later anyone can switch it on: here a newcomer with money and no Shares.
    await pass(30 * 86_400);
    const buyer = await context.newPage();
    await open(buyer, NEWCOMER, projectPath("treasury"), NEWCOMER_NSEC);
    await buyer.getByTestId("exit-sales-switch-on").click();
    await expect(buyer.getByTestId("exit-sales-state")).toContainText(
      "The money goes to the seller, not the project.",
      { timeout: 60_000 },
    );
    await expect(buyer.getByTestId("exit-sales-none")).toBeVisible();

    // The contributor offers 10 of the 25 Shares they earned at 2 USDC each. They keep them until someone buys.
    await refresh(contributor, "Funds");
    // The treasury holds no USDC here, and the page says so rather than "0 per Share".
    await expect(contributor.getByTestId("exit-sales-leaving")).toHaveText(
      "Leaving pays no USDC right now.",
      { timeout: 30_000 },
    );
    await contributor.getByTestId("exit-sales-sell").click();
    await contributor.getByTestId("exit-offer-amount").fill("26");
    await contributor.getByTestId("exit-offer-price").fill("2");
    await contributor.getByTestId("exit-offer-publish").click();
    await expect(contributor.getByTestId("exit-offer-problem")).toContainText(
      "You can sell up to 25 Shares.",
    );
    await contributor.getByTestId("exit-offer-amount").fill("10");
    await expect(contributor.getByTestId("exit-offer-total")).toHaveText(
      "Buyers pay 20 USDC in all, to you.",
    );
    await contributor.getByTestId("exit-offer-publish").click();
    await expect(contributor.getByTestId("exit-sales-offer")).toHaveCount(1, {
      timeout: 60_000,
    });
    await expect(contributor.getByTestId("exit-sales-offer")).toContainText(
      "10 Shares for 20 USDC (2 USDC each), from you",
    );
    expect(await sharesOf(CONTRIBUTOR)).toBe(25n * E18);
    if (process.env.E2E_SHOTS) {
      await contributor
        .getByTestId("exit-sales")
        .screenshot({ path: `${process.env.E2E_SHOTS}/exit-sales-offer.png` });
    }

    // The newcomer buys it: the money goes to the contributor, the Shares to the newcomer, the treasury is untouched.
    const treasury = await usdcOf(dao);
    const sellerMoney = await usdcOf(CONTRIBUTOR);
    const buyerMoney = await usdcOf(NEWCOMER);
    await refresh(buyer, "Funds");
    await buyer.getByTestId("exit-sales-buy").click();
    await expect(buyer.getByTestId("exit-sales-none")).toBeVisible({
      timeout: 60_000,
    });
    expect(await sharesOf(NEWCOMER)).toBe(10n * E18);
    expect(await sharesOf(CONTRIBUTOR)).toBe(15n * E18);
    expect(await usdcOf(CONTRIBUTOR)).toBe(sellerMoney + 20_000_000n);
    expect(await usdcOf(NEWCOMER)).toBe(buyerMoney - 20_000_000n);
    expect(await usdcOf(dao)).toBe(treasury);
    // Everything else stays locked: the newcomer can't send the Shares on themselves.
    await expect(
      rpc("eth_call", [
        {
          from: NEWCOMER,
          to: shares,
          data: `0xa9059cbb${addressArg(FOUNDER_WALLET)}${1n.toString(16).padStart(64, "0")}`,
        },
        "latest",
      ]),
    ).rejects.toThrow();
  }

  // ── 8. holders are paid a share of revenue (N10) ──────────────────────────────────────────────────
  if (PAYOUTS) {
    await refresh(founder, "Funds");
    await expect(founder.getByTestId("payouts-none")).toBeVisible({
      timeout: 30_000,
    });
    await refresh(founder, "Decisions");
    await founder.getByTestId("decision-new").click();
    await founder.getByTestId("decision-kind-payouts").click();
    await expect(founder.getByTestId("decision-draft-title")).toHaveText(
      "Pay holders 50% of revenue",
      { timeout: 30_000 },
    );
    await founder.getByTestId("decision-draft-submit").click();
    await expect(founder.getByTestId("decision-opened")).toBeVisible({
      timeout: 60_000,
    });
    // It runs on the DAO itself: the full vote.
    await carryOut(founder, 175_000, 90_000);
    const revenueAddress = wordAddress(await call(dao, "0xa247bc32"));
    expect(revenueAddress).not.toBe(`0x${"0".repeat(40)}`);
    // A customer pays the project 100 USDC at its revenue address.
    await rpc("eth_sendTransaction", [
      {
        from: FOUNDER_WALLET,
        to: currency,
        data: `0xa9059cbb${addressArg(revenueAddress)}${100_000_000n.toString(16).padStart(64, "0")}`,
      },
    ]);
    await refresh(founder, "Funds");
    await expect(founder.getByTestId("payouts-waiting")).toContainText(
      "100 USDC of revenue is waiting to be split.",
      { timeout: 30_000 },
    );
    const treasuryBefore = await usdcOf(dao);
    await founder.getByTestId("payouts-distribute").click();
    await expect(founder.getByTestId("payouts-waiting")).toHaveCount(0, {
      timeout: 60_000,
    });
    expect(await usdcOf(dao)).toBe(treasuryBefore + 50_000_000n);
    // Half of it is shared by every Share outside the DAO, by how many each holds.
    const supply = BigInt(await call(shares, "0x18160ddd"));
    const counting = supply - (await sharesOf(dao));
    const due = (50_000_000n * (await sharesOf(CONTRIBUTOR))) / counting;
    await refresh(contributor, "Funds");
    await expect(contributor.getByTestId("payouts-owed")).toContainText(
      "You can collect",
      { timeout: 30_000 },
    );
    const before = await usdcOf(CONTRIBUTOR);
    await contributor.getByTestId("payouts-collect").click();
    await expect(contributor.getByTestId("payouts-collect")).toHaveCount(0, {
      timeout: 60_000,
    });
    const got = (await usdcOf(CONTRIBUTOR)) - before;
    expect(got === due || got === due - 1n).toBe(true);
  }
});

/** A claim's row on the Work tab, by the name it was filed under. */
const claimCard = (page: Page, name: string) =>
  page.getByTestId("work-claim").filter({ hasText: name });

/**
 * Submit work from Ways to help: the work area shows its words (read from what was published and checked against the
 * chain), and its button opens the submit form with them filled in, so only the name and the evidence are typed.
 */
async function submitFromWaysToHelp(
  page: Page,
  area: string,
  words: string,
  name: string,
  evidence: string,
) {
  const way = page.locator(`[data-testid="way-to-help"][data-area="${area}"]`);
  await expect(way.getByTestId("way-to-help-words")).toHaveText(words, {
    timeout: 30_000,
  });
  await way.getByTestId("way-to-help-submit").click();
  await expect(page.getByTestId("work-claim-check")).toHaveValue(words);
  await expect(page.getByTestId("work-claim-check-note")).toContainText(
    "These are the words",
  );
  await page.getByTestId("work-claim-name").fill(name);
  await page.getByTestId("work-claim-evidence").fill(evidence);
  await page.getByTestId("work-claim-submit").click();
  await expect(page.getByTestId("work-claim-filed")).toBeVisible({
    timeout: 90_000,
  });
}

/** Open an award for one paid claim, chosen by its name, and carry the vote out. */
async function award(page: Page, claim: string, shares: string) {
  await refresh(page, "Decisions");
  await page.getByTestId("decision-new").click();
  await page.getByTestId("decision-kind-award").click();
  const select = page.getByTestId("award-claim");
  await expect(select).toBeVisible({ timeout: 30_000 });
  const value = await select
    .locator("option", { hasText: claim })
    .getAttribute("value");
  await select.selectOption(value ?? "");
  await page.getByTestId("award-shares").fill(shares);
  await page.getByTestId("decision-draft-submit").click();
  await expect(page.getByTestId("decision-opened")).toBeVisible({
    timeout: 60_000,
  });
  await carryOut(page, 90_000, 90_000);
}

test("several people earn in one contributor project: two first projects, and a newcomer's suggestion with a % ask is put to a vote", async ({
  context,
}) => {
  // Longer than the first journey: three votes and two claims (and a fork is slower still, as above).
  test.setTimeout(Number(process.env.E2E_TIMEOUT_MS ?? 600_000) * 1.5);
  // A board on this server for the suggestion to be posted on.
  published.push({
    id: "b0".repeat(32),
    kind: 39000,
    pubkey: "b".repeat(64),
    created_at: 100,
    tags: [
      ["d", "5b0a7d1e-0000-4000-8000-000000000001"],
      ["name", "ideas"],
      ["public"],
      ["t", "forum"],
    ],
    content: "",
    sig: "sig",
  } as { id: string; kind: number });
  const GUIDE = "the guide's pages are merged and reviewed";
  const EXAMPLES = "every example runs and is reviewed";
  const SPANISH = "the guide is in Spanish, merged and reviewed";
  const path = (tab: string) => projectPath(tab, "field-guide");

  // ── 1. the founder starts it with two first projects, in one transaction ─────────────────────────
  const founder = await context.newPage();
  await open(founder, FOUNDER_WALLET, "/start/contributor");
  await founder.getByTestId("contributor-name").fill("Field Guide");
  await founder
    .getByTestId("contributor-pitch")
    .fill(
      "A field guide to the city's trees, written by the people who walk it.",
    );
  await founder.getByTestId("contributor-founder-shares").fill("200");
  await founder.getByTestId("contributor-budget-shares").fill("900");
  await founder.getByTestId("contributor-project-cap").fill("60");
  await founder
    .getByTestId("contributor-reviewers")
    .fill(`${REVIEWER1}\n${REVIEWER2}`);
  await founder.getByTestId("contributor-project-name").fill("guide");
  await founder.getByTestId("contributor-project-shares-0").fill("40");
  await founder.getByTestId("contributor-project-check").fill(GUIDE);
  await founder.getByTestId("contributor-project-add").click();
  await founder.getByTestId("contributor-project-name-1").fill("examples");
  await founder.getByTestId("contributor-project-shares-1").fill("30");
  await founder.getByTestId("contributor-project-check-1").fill(EXAMPLES);
  // Built on Docs Commons (N11), whenever the first journey made it in this run: wait for the list to have it.
  const builtOn = docsCommonsPublished;
  if (builtOn) {
    await expect(
      founder
        .getByTestId("contributor-built-on")
        .locator("option", { hasText: "Docs Commons" }),
    ).toHaveCount(1, { timeout: 30_000 });
    await founder
      .getByTestId("contributor-built-on")
      .selectOption({ label: "Docs Commons" });
    await expect(founder.getByTestId("contributor-built-on-fit")).toHaveText(
      "Docs Commons invites projects built on it, and asks: Credit Docs Commons on your page.",
    );
  }
  await expect(founder.getByTestId("contributor-gate")).toHaveCount(0, {
    timeout: 20_000,
  });
  const blockBefore = BigInt(String(await rpc("eth_blockNumber")));
  await founder.getByTestId("contributor-submit").click();
  await expect(founder.getByTestId("contributor-done")).toBeVisible({
    timeout: 120_000,
  });
  expect(BigInt(String(await rpc("eth_blockNumber"))) - blockBefore).toBe(1n);
  const launched = await launchedSince(blockBefore);
  expect(launched).toHaveLength(1);
  // The event's data is (salt, projects): both first projects were made.
  expect(BigInt(`0x${launched[0].data.slice(66, 130)}`)).toBe(2n);
  const dao = wordAddress(launched[0].topics[2]);
  const shares = wordAddress(await call(dao, "0x03314efa"));
  const sharesOf = async (holder: string) =>
    BigInt(await call(shares, `0x70a08231${addressArg(holder)}`));

  await founder.getByTestId("contributor-open-project").click();
  if (builtOn) {
    // The founder takes test CREATE first, to post a bond for Docs Commons (N12).
    if (REMIX_BONDS && CREATE_FAUCET) {
      await rpc("eth_sendTransaction", [
        { from: FOUNDER_WALLET, to: CREATE_FAUCET, data: "0x9f678cca" },
      ]);
    }
    // Both pages say where it comes from: here, and on Docs Commons.
    await founder.getByRole("tab", { name: "Overview" }).click();
    const remix = founder.getByTestId("remix-card");
    await expect(remix.getByTestId("remix-built-on")).toHaveText(
      "Built on Docs Commons.",
      { timeout: 30_000 },
    );
    await expect(remix.getByTestId("remix-terms")).toHaveText(
      "This project doesn't invite others to build on it.",
    );
    if (REMIX_BONDS && CREATE_FAUCET) {
      await remix.getByTestId("remix-bond-amount").fill("500");
      await remix.getByTestId("remix-bond-days").fill("90");
      await remix.getByTestId("remix-bond-post").click();
      await expect(remix.getByTestId("remix-bond-line")).toContainText(
        "This project posted a bond of 500 CREATE for Docs Commons, held until",
        { timeout: 60_000 },
      );
    }
    await remix.getByRole("link", { name: "Docs Commons" }).click();
    await expect(
      founder.getByTestId("remix-card").getByTestId("remix-children"),
    ).toHaveText("Built on this: Field Guide.", { timeout: 30_000 });
    await expect(
      founder.getByTestId("remix-card").getByTestId("remix-terms"),
    ).toHaveText(
      "Others may build on this project. It asks: Credit Docs Commons on your page.",
    );
    await founder.goto(path("overview"));
  }
  await founder.getByRole("tab", { name: "Work" }).click();
  await expect(founder.getByTestId("work-projects")).toContainText("guide", {
    timeout: 30_000,
  });
  await expect(founder.getByTestId("work-projects")).toContainText("examples");

  // ── 2. a contributor claims work in the first project the same day ───────────────────────────────
  const contributor = await context.newPage();
  await open(contributor, CONTRIBUTOR, path("work"));
  await expect(contributor.getByTestId("work-projects")).toContainText(
    "guide",
    { timeout: 30_000 },
  );
  await submitFromWaysToHelp(
    contributor,
    "guide",
    GUIDE,
    "write-guide",
    "https://example.com/pr/11",
  );

  // ── 3. a newcomer with no Shares suggests work and asks for 5% of the project ─────────────────────
  const newcomer = await context.newPage();
  await open(newcomer, NEWCOMER, path("work"), NEWCOMER_NSEC);
  await newcomer.getByTestId("suggest-work").click();
  await newcomer
    .getByTestId("suggest-title")
    .fill("Translate the guide to Spanish");
  await newcomer
    .getByTestId("suggest-body")
    .fill("Half the people on our walks read Spanish first.");
  await newcomer.getByTestId("suggest-name").fill("guide-es");
  await newcomer.getByTestId("suggest-check").fill(SPANISH);
  await newcomer.getByTestId("suggest-amount").fill("5");
  // 5% once added to the 200 that exist: 11 Shares (rounded up), which is 5.2% of 211.
  await expect(newcomer.getByTestId("suggest-ask-preview")).toContainText(
    "11 Shares: 5.2% of the project once they are added to the 200 that exist now",
    { timeout: 30_000 },
  );
  await newcomer.getByTestId("suggest-submit").click();
  // Posted first (the server has it), then read back on the page.
  await expect
    .poll(
      () =>
        published.some(
          (e) =>
            e.kind === 45001 &&
            (e as unknown as { tags: string[][] }).tags.some(
              (t) => t[0] === "project" && t[1] === "guide-es",
            ),
        ),
      { timeout: 30_000 },
    )
    .toBe(true);
  const suggestion = newcomer.locator(
    '[data-testid^="work-proposal-"][data-status]',
  );
  await expect(suggestion).toHaveCount(1, { timeout: 30_000 });
  await expect(suggestion.getByTestId("work-proposal-ask")).toHaveText(
    "11 Shares (5.2%)",
  );
  const post = published.find(
    (e) =>
      e.kind === 45001 &&
      (e as unknown as { tags: string[][] }).tags.some(
        (t) => t[0] === "project" && t[1] === "guide-es",
      ),
  ) as unknown as { pubkey: string; tags: string[][] } | undefined;
  expect(post?.tags).toContainEqual(["ask", "11"]);
  expect(post?.pubkey).not.toBe(FOUNDER);

  // ── 4. the founder, a holder, puts it to a vote, filled in from the suggestion; the vote passes ──────
  await refresh(founder, "Work");
  const toSponsor = founder.locator(
    '[data-testid^="work-proposal-"][data-status="suggested"]',
  );
  await expect(toSponsor).toHaveCount(1, { timeout: 30_000 });
  await toSponsor.getByTestId("work-proposal-sponsor").click();
  // The form waits for the work budgets to be read (slower on a fork, which reads from a public node).
  await expect(founder.getByTestId("decision-from-suggestion")).toContainText(
    "“guide-es” for 11 Shares",
    { timeout: 60_000 },
  );
  await expect(founder.getByTestId("project-name")).toHaveValue("guide-es");
  await expect(founder.getByTestId("project-shares")).toHaveValue("11");
  await expect(founder.getByTestId("project-check")).toHaveValue(SPANISH);
  // The server refuses the words the first time: the vote is open, but its words are not yet published.
  refuseWorkAreaWords = true;
  await founder.getByTestId("decision-draft-submit").click();
  await expect(founder.getByTestId("decision-opened")).toBeVisible({
    timeout: 60_000,
  });
  await expect(founder.getByTestId("pending-words-item")).toContainText(
    "The words for the work area “guide-es” are not published yet",
    { timeout: 30_000 },
  );
  // The job outlives the page: after a reload it is still there to retry, and retrying does not open the vote again.
  await refresh(founder, "Decisions");
  await expect(founder.getByTestId("pending-words-item")).toHaveCount(1, {
    timeout: 30_000,
  });
  await expect(founder.getByTestId("decision-card").first()).toBeVisible({
    timeout: 30_000,
  });
  const decisionsBefore = await founder.getByTestId("decision-card").count();
  refuseWorkAreaWords = false;
  await founder.getByTestId("pending-words-publish").click();
  await expect(founder.getByTestId("pending-words")).toHaveCount(0, {
    timeout: 30_000,
  });
  await expect(founder.getByTestId("decision-card")).toHaveCount(
    decisionsBefore,
  );
  // The chain keeps only the hash of the work area's words: they are published beside the vote, as an update.
  await expect
    .poll(() =>
      published.some((e) => {
        const event = e as unknown as { kind: number; content: string };
        if (event.kind !== 47003) return false;
        const body = JSON.parse(event.content) as {
          workArea?: { check?: string };
        };
        return body.workArea?.check === SPANISH;
      }),
    )
    .toBe(true);
  await expect(founder.getByTestId("decision-words-unpublished")).toHaveCount(
    0,
  );
  // The newcomer holds no Shares yet: told so, with no vote buttons to press.
  await refresh(newcomer, "Decisions");
  await expect(
    newcomer.getByTestId("decision-vote-summary").first(),
  ).toHaveText("You hold no Shares, so you cannot vote on this.", {
    timeout: 30_000,
  });
  await expect(newcomer.getByTestId("decision-vote-for").first()).toBeHidden();
  await carryOut(founder, 90_000, 90_000);
  await refresh(founder, "Work");
  await expect(founder.getByTestId("work-projects")).toContainText("guide-es", {
    timeout: 30_000,
  });
  await expect(founder.getByTestId("work-proposal-approved")).toBeVisible();

  // ── 5. the newcomer claims work in the project they suggested ────────────────────────────────────
  await refresh(newcomer, "Work");
  await expect(newcomer.getByTestId("work-proposal-approved")).toBeVisible({
    timeout: 30_000,
  });
  // The work area's words came with its vote (and the suggestion): Ways to help shows them, checked against the chain.
  await submitFromWaysToHelp(
    newcomer,
    "guide-es",
    SPANISH,
    "translate-es",
    "https://example.com/pr/12",
  );

  // ── 6. the founder takes each claim on in its own project; both reviewers approve both ────────────
  await refresh(founder, "Work");
  // Work areas read by title: the launch's own area by its short name made readable ("guide" reads "Guide"), the one
  // approved from a suggestion by that suggestion's title (D146).
  for (const [claim, project] of [
    ["write-guide", "Guide"],
    ["translate-es", "Translate the guide to Spanish"],
  ] as const) {
    const card = claimCard(founder, claim);
    await card
      .getByRole("button", {
        name: `Accept for review in ${project}`,
        exact: true,
      })
      .click();
    await expect(card.getByTestId("work-claim-next")).toContainText(
      "0 of 2 approvals",
      { timeout: 60_000 },
    );
  }
  for (const account of [REVIEWER1, REVIEWER2]) {
    const reviewer = await context.newPage();
    await open(reviewer, account, path("work"));
    for (const claim of ["write-guide", "translate-es"]) {
      const card = claimCard(reviewer, claim);
      await card.getByTestId("work-approve").click();
      await expect(card.getByTestId("work-approve")).toHaveCount(0, {
        timeout: 60_000,
      });
    }
    await reviewer.close();
  }
  await refresh(founder, "Work");
  for (const claim of ["write-guide", "translate-es"]) {
    const card = claimCard(founder, claim);
    await card.getByTestId("work-settle").click();
    await expect(card.getByTestId("work-claim-status")).toContainText(
      "Approved",
      { timeout: 60_000 },
    );
  }
  await pass(700_000);
  for (const [page, claim] of [
    [contributor, "write-guide"],
    [newcomer, "translate-es"],
  ] as const) {
    await refresh(page, "Work");
    const card = claimCard(page, claim);
    await card.getByTestId("work-payout").click();
    await expect(card.getByTestId("work-claim-status")).toContainText(
      "Finished",
      {
        timeout: 60_000,
      },
    );
  }

  // ── 7. each award is its own vote ───────────────────────────────────────────────────────────────
  // Work reads by title in the award picker ("write-guide" reads "Write guide").
  await award(founder, "Write guide", "40");
  await award(founder, "Translate es", "11");
  expect(await sharesOf(CONTRIBUTOR)).toBe(40n * E18);
  expect(await sharesOf(NEWCOMER)).toBe(11n * E18);
  expect(BigInt(await call(shares, "0x18160ddd"))).toBe(251n * E18);

  // ── 8. anyone reads who earned what, for which work ─────────────────────────────────────────────
  const reader = await context.newPage();
  await open(reader, null, path("contributions"));
  await expect(reader.getByTestId("contribution-person")).toHaveCount(2, {
    timeout: 30_000,
  });
  const person = (address: string) =>
    reader
      .getByTestId("contribution-person")
      .filter({ hasText: address.slice(2, 6) });
  await expect(
    person(CONTRIBUTOR).getByTestId("contribution-person-earned"),
  ).toHaveText("40 Shares awarded");
  await expect(
    person(CONTRIBUTOR).getByTestId("contribution-person-held"),
  ).toHaveText("Holds 40 now (15.9% of all Shares now).");
  await expect(
    person(CONTRIBUTOR).getByTestId("contribution-award-title"),
  ).toHaveText("40 Shares for Write guide in the work area Guide");
  await expect(
    person(CONTRIBUTOR).getByTestId("contribution-award-evidence"),
  ).toContainText("Open what they delivered", {
    timeout: 30_000,
  });
  await expect(
    person(NEWCOMER).getByTestId("contribution-person-earned"),
  ).toHaveText("11 Shares awarded");
  await expect(
    person(NEWCOMER).getByTestId("contribution-person-held"),
  ).toHaveText("Holds 11 now (4.4% of all Shares now).");
  await expect(
    person(NEWCOMER).getByTestId("contribution-award-title"),
  ).toHaveText(
    "11 Shares for Translate es in the work area Translate the guide to Spanish",
  );
  await expect(
    person(NEWCOMER).getByTestId("contribution-award-evidence"),
  ).toContainText("Open what they delivered");
  await expect(reader.getByTestId("contributions-earned")).toHaveText("51");
  await expect(reader.getByTestId("contributions-unconfirmed")).toHaveCount(0);
  await expect(reader.getByTestId("contributions-starting")).toHaveText("200");
});
