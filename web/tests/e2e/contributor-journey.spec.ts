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
 * The second journey has several people earn (D84): two first projects at Start, a newcomer with no Shares suggests
 * work and asks for 5% of the project, the founder puts it to a vote filled in from the suggestion, and both people's
 * claims are taken on in their own projects, reviewed, paid and awarded by vote.
 */

const ANVIL_URL = process.env.E2E_ANVIL_URL ?? "";
const KIT = process.env.E2E_KIT ?? "";
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
async function refresh(page: Page, tab: "Overview" | "Decisions" | "Work") {
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
    "Waiting to run",
    { timeout: 30_000 },
  );
  await pass(toWait);
  await refresh(page, "Decisions");
  const ready = page.getByTestId("decision-card").first();
  await expect(ready.getByTestId("decision-status")).toHaveText(
    "Ready to run",
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
    "No token sale at setup. New Shares come only from awards for reviewed work.",
  );
  await expect(founder.getByTestId("contributor-transfers")).toHaveText(
    "Shares are locked: they cannot be sent between wallets.",
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
    "Your “write-docs” is waiting for a work area's manager to accept it for review.",
    { timeout: 30_000 },
  );

  // ── 3. the founder (the first project's manager) takes it on, two reviewers approve, it is finished ──
  // "Needs you" names the submission, and its button opens that claim on the Work tab.
  await refresh(founder, "Overview");
  const accept = founder
    .getByTestId("dao-attention")
    .filter({ hasText: "submitted “write-docs”" });
  await expect(accept).toContainText(
    "Accept it for review in one of your work areas.",
    { timeout: 30_000 },
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
  expect(await sharesOf(CONTRIBUTOR)).toBe(0n);

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
    "25 Shares for write-docs in the work area docs",
  );
  // The story behind it: when it ran, how the review went, the transaction, and what they delivered in their own
  // words, shown because it hashes to what the claim committed to.
  const story = person.getByTestId("contribution-award-story");
  await expect(story).toContainText("Awarded ", { timeout: 30_000 });
  await expect(story).toContainText("approved by 2 of 2 reviewers");
  await expect(story.getByTestId("tx-link")).toBeVisible();
  await expect(story.getByTestId("contribution-award-evidence")).toContainText(
    "In their words: “https://example.com/pr/1”",
  );
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
  await expect(way.getByTestId("way-to-help-words")).toHaveText(
    `Finished looks like: ${words}`,
    { timeout: 30_000 },
  );
  await way.getByTestId("way-to-help-submit").click();
  await expect(page.getByTestId("work-claim-check")).toHaveValue(words);
  await expect(page.getByTestId("work-claim-check-note")).toContainText(
    "exact words, checked against the network",
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
  await founder.getByTestId("decision-draft-submit").click();
  await expect(founder.getByTestId("decision-opened")).toBeVisible({
    timeout: 60_000,
  });
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
  for (const [claim, project] of [
    ["write-guide", "guide"],
    ["translate-es", "guide-es"],
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
  await award(founder, "write-guide", "40");
  await award(founder, "translate-es", "11");
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
  ).toHaveText("40 Shares for write-guide in the work area guide");
  await expect(
    person(CONTRIBUTOR).getByTestId("contribution-award-evidence"),
  ).toContainText("In their words: “https://example.com/pr/11”", {
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
  ).toHaveText("11 Shares for translate-es in the work area guide-es");
  await expect(
    person(NEWCOMER).getByTestId("contribution-award-evidence"),
  ).toContainText("In their words: “https://example.com/pr/12”");
  await expect(reader.getByTestId("contributions-earned")).toHaveText("51");
  await expect(reader.getByTestId("contributions-unconfirmed")).toHaveCount(0);
  await expect(reader.getByTestId("contributions-starting")).toHaveText("200");
});
