import { readFile } from "node:fs/promises";

import {
  type Browser,
  type BrowserContext,
  type CDPSession,
  expect,
  type Page,
  test,
} from "@playwright/test";

import { installAnvilWallet } from "../helpers/anvil-wallet";
import {
  installStandInBundler,
  type StandInBundler,
} from "../helpers/stand-in-bundler";

/**
 * A contributor project with no browser wallet and no test ETH (D139): the founder and the contributor sign up with a
 * passkey and act from their passkey accounts, whose fees a paymaster covers, as testers on the hosted Sepolia site will.
 * Run on a local fork of Sepolia, built the way the hosted image is (only the settings its Dockerfile takes), by
 * scripts/web-passkey-contributor-e2e.sh. The passkey account contracts are Sepolia's own; a stand-in bundler and an
 * accept-all paymaster stand in for the hosted service (`tests/helpers/stand-in-bundler.ts`). The two reviewers keep
 * browser wallets, so the journey also shows both kinds of account working on one project.
 *
 * The founder starts the project from their passkey account (it holds their starting Shares), links the account to their
 * name with one prompt, and accepts the contributor's work for review; the contributor submits it and marks it finished
 * from theirs; the reviewers approve; the founder opens the award and votes it through; and the 25 Shares arrive in the
 * contributor's passkey account. No one but the reviewers ever has a wallet.
 */

const ANVIL_URL = process.env.E2E_ANVIL_URL ?? "";
const KIT = process.env.E2E_KIT ?? "";
const PAYMASTER = process.env.E2E_PAYMASTER ?? "";
const SUBMITTER = process.env.E2E_SUBMITTER ?? "";
const REVIEWER1 = process.env.E2E_REVIEWER1 ?? "";
const REVIEWER2 = process.env.E2E_REVIEWER2 ?? "";
const CHECK = "docs merged and reviewed";
/** `ContributorProjectLaunched(address,address,address,bytes32,uint256)`. */
const LAUNCHED =
  "0x7f4eb55556e4a4d7639e36b6ec8b0e6d4ab4fcfff92dd9c201bed8e870716583";
const E18 = 10n ** 18n;
const REVIEWER_NSECS = ["55".repeat(32), "66".repeat(32)];

test.skip(
  !ANVIL_URL || !KIT || !PAYMASTER || !SUBMITTER,
  "run by scripts/web-passkey-contributor-e2e.sh, which sets E2E_ANVIL_URL, E2E_KIT, E2E_PAYMASTER and E2E_SUBMITTER",
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

const call = async (to: string, data: string) =>
  String(await rpc("eth_call", [{ to, data }, "latest"]));
const addressArg = (address: string) =>
  address.slice(2).toLowerCase().padStart(64, "0");
const wordAddress = (hex: string) => `0x${hex.slice(-40)}`;

async function pass(seconds: number) {
  await rpc("anvil_increaseTime", [seconds]);
  await rpc("anvil_mine", ["0x1"]);
}

/** Everything the pages publish, served back to every page that asks for its kind. */
const published: { id: string; kind: number }[] = [];

async function stubRelay(page: Page) {
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
}

/**
 * A person who signs up with a passkey, in a browser of their own (passkeys and their accounts live in one browser's
 * storage), on `localhost` because browsers refuse passkeys on a bare address. Returns the page, signed up.
 */
async function passkeyBrowser(
  browser: Browser,
  bundler: StandInBundler,
  wallet?: string,
): Promise<{
  context: BrowserContext;
  page: Page;
  cdp: CDPSession;
  authenticatorId: string;
}> {
  const context = await browser.newContext({
    baseURL: "http://localhost:4173",
  });
  const page = await context.newPage();
  await stubRelay(page);
  await installStandInBundler(
    page,
    { rpcUrl: ANVIL_URL, paymaster: PAYMASTER, submitter: SUBMITTER },
    bundler,
  );
  if (wallet) await installAnvilWallet(page, wallet, { rpcUrl: ANVIL_URL });
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send(
    "WebAuthn.addVirtualAuthenticator",
    {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
        hasPrf: true,
      },
    },
  );
  await page.addInitScript((rpcUrl) => {
    window.localStorage.setItem("buzz.relayUrl", "ws://127.0.0.1:4173");
    window.localStorage.setItem("buzz.launchpad.rpc", rpcUrl);
  }, ANVIL_URL);
  return { context, page, cdp, authenticatorId };
}

/** A person who signs up with a passkey (and, with `wallet`, also has a browser wallet). */
async function passkeyPerson(
  browser: Browser,
  bundler: StandInBundler,
  name: string,
  wallet?: string,
) {
  const person = await passkeyBrowser(browser, bundler, wallet);
  const { page } = person;
  await page.goto("/");
  await page.getByTestId("create-identity-cta").first().click();
  await page.getByTestId("onboarding-name").fill(name);
  await page.getByTestId("onboarding-passkey").click();
  await expect
    .poll(() =>
      page.evaluate(() => window.localStorage.getItem("buzz.passkey.r1")),
    )
    .toMatch(/^0x?[0-9a-f]+$/i);
  return person;
}

/** A reviewer with an ordinary browser wallet (one of anvil's accounts). */
async function walletPerson(
  browser: Browser,
  wallet: string,
  nsec: string,
): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await stubRelay(page);
  await installAnvilWallet(page, wallet, { rpcUrl: ANVIL_URL });
  await page.addInitScript(
    ([nsec, rpcUrl]) => {
      window.localStorage.setItem("buzz.identity.nsec", nsec);
      window.localStorage.setItem("buzz.identity.backedUp", "1");
      window.localStorage.setItem("buzz.launchpad.rpc", rpcUrl);
    },
    [nsec, ANVIL_URL],
  );
  return page;
}

async function refresh(
  page: Page,
  tab: "Overview" | "Decisions" | "Work" | "Funds",
) {
  await page.reload();
  await page.getByRole("tab", { name: tab }).click();
}

test("a founder and a contributor with no wallet start a project, do the work and award it, from passkey accounts", async ({
  browser,
}) => {
  test.setTimeout(Number(process.env.E2E_TIMEOUT_MS ?? 900_000));
  const bundler: StandInBundler = { sent: [] };

  // ── 1. the founder signs up with a passkey and starts the project from the passkey account ────────────────────
  const founderDevice = await passkeyPerson(browser, bundler, "Ada Founder");
  let founder = founderDevice.page;
  const founderKey = (await founder.evaluate(() =>
    window.localStorage.getItem("buzz.passkey.pubkey"),
  )) as string;
  await founder.goto("/start");
  await founder.getByTestId("start-go-contributor").click();
  // The account that acts is the passkey account: no wallet asked for, the fees covered.
  await expect(founder.getByTestId("contributor-account-wallet")).toContainText(
    "passkey; fees are covered on the test network",
    { timeout: 30_000 },
  );
  await founder.getByTestId("contributor-name").fill("Docs Commons");
  await founder
    .getByTestId("contributor-pitch")
    .fill("Open docs for everyone, written by the people who use them.");
  await founder.getByTestId("contributor-founder-shares").fill("200");
  await founder.getByTestId("contributor-budget-shares").fill("600");
  await founder.getByTestId("contributor-project-cap").fill("40");
  await founder
    .getByTestId("contributor-reviewers")
    .fill(`${REVIEWER1}\n${REVIEWER2}`);
  await founder.getByTestId("contributor-project-name").fill("docs");
  await founder.getByTestId("contributor-project-check").fill(CHECK);
  await expect(founder.getByTestId("contributor-gate")).toHaveCount(0, {
    timeout: 30_000,
  });
  const blockBefore = BigInt(String(await rpc("eth_blockNumber")));
  await founder.getByTestId("contributor-submit").click();
  await expect(founder.getByTestId("contributor-done")).toBeVisible({
    timeout: 180_000,
  });
  // One operation made the account and the project together.
  expect(bundler.sent).toHaveLength(1);
  expect(bundler.sent[0].success).toBe(true);

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
  // The founder is the passkey account: a contract (deployed by that first operation), not a wallet.
  const founderAccount = wordAddress(launched[0].topics[1]);
  expect(
    String(await rpc("eth_getCode", [founderAccount, "latest"])).length,
  ).toBeGreaterThan(2);
  const dao = wordAddress(launched[0].topics[2]);
  const shares = wordAddress(await call(dao, "0x03314efa"));
  const sharesOf = async (holder: string) =>
    BigInt(await call(shares, `0x70a08231${addressArg(holder)}`));
  expect(await sharesOf(founderAccount)).toBe(200n * E18);

  // ── 2. one prompt shows the founder's name with the account ──────────────────────────────────────────────────
  await founder.getByTestId("contributor-open-project").click();
  await founder.getByRole("tab", { name: "Work" }).click();
  await founder.getByTestId("work-link-name").click({ timeout: 30_000 });
  // What it means is said, and nothing happens until the box is ticked.
  await expect(founder.getByTestId("work-link-name-confirm")).toBeDisabled();
  await founder.getByTestId("work-link-name-consent").check();
  await founder.getByTestId("work-link-name-confirm").click();
  await expect(founder.getByTestId("work-link-name-done")).toContainText(
    "Your name now shows with this account.",
    { timeout: 60_000 },
  );
  const link = published.find((e) => e.kind === 37017) as
    | { content?: string }
    | undefined;
  const linkBody = JSON.parse(link?.content ?? "{}");
  expect(linkBody.address).toBe(founderAccount);
  // The account's public details go with it, so another device can find the account (and nothing secret does).
  expect(linkBody.passkey.publicKey).toMatch(/^04[0-9a-f]{128}$/);
  expect(Object.keys(linkBody.passkey).sort()).toEqual([
    "credentialId",
    "publicKey",
  ]);
  const projectPath = (tab: string) =>
    `/launchpad/docs-commons?author=${founderKey}&tab=${tab}`;

  // ── 3. a contributor signs up with a passkey and submits work, with no wallet ────────────────────────────────
  const { page: contributor } = await passkeyPerson(
    browser,
    bundler,
    "Bo Contributor",
  );
  await contributor.goto(projectPath("work"));
  await expect(contributor.getByTestId("work-wallet")).toContainText(
    "passkey; fees are covered on the test network",
    { timeout: 30_000 },
  );
  const way = contributor.locator(
    '[data-testid="way-to-help"][data-area="docs"]',
  );
  await expect(way.getByTestId("way-to-help-words")).toHaveText(CHECK, {
    timeout: 30_000,
  });
  await way.getByTestId("way-to-help-submit").click();
  await contributor.getByTestId("work-claim-name").fill("write-docs");
  await contributor
    .getByTestId("work-claim-evidence")
    .fill("https://example.com/pr/1");
  const sentBefore = bundler.sent.length;
  await contributor.getByTestId("work-claim-submit").click();
  await expect(contributor.getByTestId("work-claim-filed")).toBeVisible({
    timeout: 180_000,
  });
  // Submitting and stating the words went as one operation: one passkey prompt, from the contributor's own account.
  expect(bundler.sent.length - sentBefore).toBe(1);
  const contributorAccount = bundler.sent[sentBefore].sender;
  expect(contributorAccount).not.toBe(founderAccount);

  // ── 4. the founder accepts it for review; the reviewers, with wallets, approve; the founder finalizes ──────────
  await refresh(founder, "Work");
  await founder.getByTestId("work-bind").click({ timeout: 30_000 });
  await expect(founder.getByTestId("work-claim-next")).toContainText(
    "0 of 2 approvals",
    { timeout: 120_000 },
  );
  // The first reviewer has only a wallet, and acts with it.
  const reviewer1 = await walletPerson(browser, REVIEWER1, REVIEWER_NSECS[0]);
  await reviewer1.goto(projectPath("work"));
  await expect(reviewer1.getByTestId("work-wallet")).toContainText(
    "Your wallet",
    { timeout: 30_000 },
  );
  await reviewer1.getByTestId("work-approve").click();
  await expect(reviewer1.getByTestId("work-claim-next")).toContainText(
    "1 of 2 approvals",
    { timeout: 60_000 },
  );
  // The second has a passkey too: the passkey account acts by default, the wallet they were named with is one press
  // away, and that choice holds after a reload.
  const { page: reviewer2 } = await passkeyPerson(
    browser,
    bundler,
    "Cy Reviewer",
    REVIEWER2,
  );
  await reviewer2.goto(projectPath("work"));
  await expect(reviewer2.getByTestId("work-wallet")).toContainText(
    "passkey; fees are covered on the test network",
    { timeout: 30_000 },
  );
  await expect(reviewer2.getByTestId("work-approve")).toHaveCount(0);
  await reviewer2.getByTestId("work-use-wallet").click();
  await expect(reviewer2.getByTestId("work-wallet")).toContainText(
    "Your wallet",
  );
  await reviewer2.reload();
  await expect(reviewer2.getByTestId("work-wallet")).toContainText(
    "Your wallet",
    { timeout: 30_000 },
  );
  const sentByReviewers = bundler.sent.length;
  await reviewer2.getByTestId("work-approve").click({ timeout: 30_000 });
  await expect(reviewer2.getByTestId("work-claim-next")).not.toContainText(
    "1 of 2 approvals",
    { timeout: 60_000 },
  );
  expect(bundler.sent.length, "the approval went from the wallet").toBe(
    sentByReviewers,
  );
  await refresh(founder, "Work");
  await founder.getByTestId("work-settle").click();
  await expect(founder.getByTestId("work-claim-status")).toContainText(
    "Approved",
    { timeout: 120_000 },
  );

  // ── 5. after the waiting period the contributor marks it finished, from the passkey account ──────────────────
  await pass(700_000);
  await refresh(contributor, "Work");
  await contributor.getByTestId("work-payout").click({ timeout: 30_000 });
  await expect(contributor.getByTestId("work-claim-status")).toContainText(
    "Finished",
    { timeout: 120_000 },
  );

  // ── 6. on a second device: the founder signs in with the recovery key, their synced passkey is there, and the
  //       passkey account is found again from the name link. From there they open the award and vote it through. ──
  await founder.getByTestId("user-chip").click();
  await founder.getByRole("button", { name: "Sign out", exact: true }).click();
  await founder.getByTestId("signout-save-key").click();
  const downloaded = founder.waitForEvent("download");
  await founder.getByTestId("backup-download").click();
  const recoveryKey = (
    await readFile((await (await downloaded).path()) ?? "", "utf8")
  ).trim();
  expect(recoveryKey).toMatch(/^[0-9a-f]{64}$/);
  const { credentials } = (await founderDevice.cdp.send(
    "WebAuthn.getCredentials",
    { authenticatorId: founderDevice.authenticatorId },
  )) as { credentials: Record<string, unknown>[] };
  expect(credentials).toHaveLength(1);
  const second = await passkeyBrowser(browser, bundler);
  // The passkey arrives the way a synced one does: the same credential, on this device's authenticator.
  await second.cdp.send("WebAuthn.addCredential", {
    authenticatorId: second.authenticatorId,
    credential: credentials[0],
  } as never);
  await second.page.addInitScript(
    ([key, pubkey]) => {
      window.localStorage.setItem("buzz.identity.nsec", key);
      window.localStorage.setItem("buzz.identity.backedUp", pubkey);
    },
    [recoveryKey, founderKey],
  );
  founder = second.page;
  await founder.goto(projectPath("decisions"));
  await expect(founder.getByTestId("decisions-wallet")).toContainText(
    "passkey; fees are covered on the test network",
    { timeout: 60_000 },
  );
  await refresh(founder, "Decisions");
  await founder.getByTestId("decision-new").click();
  await founder.getByTestId("decision-kind-award").click();
  await expect(founder.getByTestId("award-claim")).toBeVisible({
    timeout: 30_000,
  });
  await founder.getByTestId("award-shares").fill("25");
  await founder.getByTestId("decision-draft-submit").click();
  await expect(founder.getByTestId("decision-opened")).toBeVisible({
    timeout: 120_000,
  });
  const card = () => founder.getByTestId("decision-card").first();
  await card().getByTestId("decision-vote-for").click({ timeout: 30_000 });
  await expect(card().getByTestId("decision-support")).toContainText(
    "Backing 200",
    { timeout: 120_000 },
  );
  await pass(90_000);
  await refresh(founder, "Decisions");
  await card().getByTestId("decision-start-wait").click({ timeout: 30_000 });
  await expect(card().getByTestId("decision-status")).toHaveText(
    "Waiting to run",
    { timeout: 120_000 },
  );
  await pass(90_000);
  await refresh(founder, "Decisions");
  await card().getByTestId("decision-run").click({ timeout: 30_000 });
  await expect(card().getByTestId("decision-status")).toHaveText("Done", {
    timeout: 120_000,
  });
  // The claim was the contributor's passkey account's, so that is where the Shares went.
  expect(await sharesOf(contributorAccount)).toBe(25n * E18);
  // Every operation anyone sent landed and succeeded, the paymaster paid for each, and the passkey accounts hold no
  // ETH: nobody needed test ETH.
  expect(bundler.sent.every((op) => op.success === true)).toBe(true);
  expect(
    bundler.sent.every((op) => op.paymaster === PAYMASTER.toLowerCase()),
  ).toBe(true);
  for (const account of [founderAccount, contributorAccount]) {
    expect(
      BigInt(String(await rpc("eth_getBalance", [account, "latest"]))),
    ).toBe(0n);
  }
  // The founder and the contributor each acted only from their passkey account.
  expect(new Set(bundler.sent.map((op) => op.sender))).toEqual(
    new Set([founderAccount, contributorAccount]),
  );
});
