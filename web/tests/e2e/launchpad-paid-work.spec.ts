import { expect, test, type Page } from "@playwright/test";
import { finalizeEvent, getPublicKey, type Event } from "nostr-tools/pure";
import { hexToBytes } from "@noble/hashes/utils.js";
import {
  newWalletAttestation,
  resolvePaymentWallet,
  siweMessageHash,
  walletTypedData,
} from "../../src/features/identity/lib/wallet-proof";
import { paymentRecord } from "../helpers/payment-wallet";
import { installAnvilWallet } from "../helpers/anvil-wallet";
import { publishedEvents } from "../helpers/published-events";

/**
 * Paying a contributor money, entirely from the browser, against a REAL local chain: no command line anywhere.
 *
 * Opt-in: `scripts/web-paid-work-e2e.sh` builds the world (a project launched into its own DAO through the kit) and
 * runs this spec. Everything after that is done in pages, each as the wallet of the person whose job it is. What is
 * stubbed: the relay (it only serves the launch record) and the wallets (`window.ethereum` forwarding to Anvil's
 * unlocked accounts).
 */

const ANVIL_URL = process.env.E2E_ANVIL_URL ?? "";
const DAO = process.env.E2E_DAO ?? "";
const SHARES = process.env.E2E_SHARES ?? "";
const CURRENCY = process.env.E2E_CURRENCY ?? "";
const REVIEWER1 = process.env.E2E_REVIEWER1 ?? "";
const REVIEWER2 = process.env.E2E_REVIEWER2 ?? "";
const CONTRIBUTOR = process.env.E2E_CONTRIBUTOR ?? "";
const MANAGER = process.env.E2E_MANAGER ?? "";
const FOUNDER_WALLET = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const NSEC = "22".repeat(32);
const FOUNDER = getPublicKey(
  Uint8Array.from(NSEC.match(/.{2}/g) ?? [], (b) => Number.parseInt(b, 16)),
);
const CHECK = "docs merged and reviewed";
let publicWallets: Event[] = [];

test.skip(
  !ANVIL_URL || !DAO || !SHARES,
  "set E2E_ANVIL_URL, E2E_DAO and E2E_SHARES (scripts/web-paid-work-e2e.sh does)",
);

/** What the pages of one test publish, read back by the others (the reviewers read the contributor's evidence). */
const published = publishedEvents();
test.beforeEach(() => published.clear());

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

/** Let time pass on the chain, the way waiting would. */
async function pass(seconds: number) {
  await rpc("anvil_increaseTime", [seconds]);
  await rpc("anvil_mine", ["0x1"]);
}

const moneyOf = async (holder: string) =>
  BigInt(
    String(
      await rpc("eth_call", [
        {
          to: CURRENCY,
          data: `0x70a08231${holder.slice(2).toLowerCase().padStart(64, "0")}`,
        },
        "latest",
      ]),
    ),
  );

const record = {
  id: "record-paid-work",
  pubkey: FOUNDER,
  created_at: 100,
  kind: 37001,
  tags: [
    ["d", "nebula-paid-work"],
    ["name", "Nebula DAO"],
    ["t", "dao-launchpad"],
    ["chain", "31337"],
    ["treasury", DAO],
  ],
  content: JSON.stringify({
    pitch: "A DAO that pays for work.",
    stage: "graduated",
    currency: CURRENCY || undefined,
    tokenPlan: {
      mode: "dao",
      name: "Nebula",
      symbol: "NEB",
      supply: "200000000",
    },
  }),
  sig: "sig",
};

async function openAs(page: Page, account: string, tab: "Decisions" | "Work") {
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
        published.remember(parsed[1] as { id: string; kind: number });
        ws.send(
          JSON.stringify(["OK", (parsed[1] as { id: string }).id, true, ""]),
        );
        return;
      }
      if (parsed[0] !== "REQ") return;
      const [, subId, filter] = parsed as [
        string,
        string,
        { kinds?: number[] },
      ];
      if (filter.kinds?.includes(37001))
        ws.send(JSON.stringify(["EVENT", subId, record]));
      if (filter.kinds?.includes(37017)) {
        for (const event of publicWallets)
          ws.send(JSON.stringify(["EVENT", subId, event]));
      }
      published.serve(ws, subId, filter.kinds);
      ws.send(JSON.stringify(["EOSE", subId]));
    });
  });
  await installAnvilWallet(page, account, { rpcUrl: ANVIL_URL });
  await page.addInitScript(
    ([nsec, rpcUrl]) => {
      window.localStorage.setItem("buzz.identity.nsec", nsec);
      window.localStorage.setItem("buzz.launchpad.rpc", rpcUrl);
    },
    [NSEC, ANVIL_URL],
  );
  await page.goto(`/launchpad/nebula-paid-work?author=${FOUNDER}`);
  await page.getByRole("tab", { name: tab }).click();
}

/** Re-read the page after the chain's clock moved. */
async function refresh(page: Page, tab: "Decisions" | "Work") {
  await page.reload();
  await page.getByRole("tab", { name: tab }).click();
}

/**
 * Take the newest decision from "collecting support" to "done": back it, let the review and support periods pass, start
 * the wait, let it pass, run it. Each press is the founder's own wallet.
 */
async function carryOut(
  page: Page,
  secondsToApprove: number,
  secondsToWait: number,
) {
  const card = page.getByTestId("decision-card").first();
  await expect(card.getByTestId("decision-status")).toHaveText(
    "Collecting support",
    { timeout: 30_000 },
  );
  await card.getByTestId("decision-vote-for").click();
  await expect(card.getByTestId("decision-support")).toContainText(
    "Backing 200,000,000",
    { timeout: 30_000 },
  );
  await pass(secondsToApprove);
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
  await pass(secondsToWait);
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

test("a DAO pays a contributor money for a claim, with a deposit, all from the page", async ({
  context,
}) => {
  test.setTimeout(420_000);
  const founder = await context.newPage();
  await openAs(founder, FOUNDER_WALLET, "Decisions");
  await expect(founder.getByTestId("decisions-empty")).toBeVisible({
    timeout: 20_000,
  });
  const treasury = await moneyOf(DAO);
  expect(treasury).toBe(10_000n * 10n ** 6n);

  // ── 1. a work budget that holds money: the treasury moves it into the budget when the vote runs ────
  await founder.getByTestId("decision-new").click();
  await founder.getByTestId("decision-kind-budget").click();
  await founder.getByTestId("budget-money").fill("5000");
  await founder.getByTestId("budget-money-cap").fill("1000");
  await founder
    .getByTestId("budget-reviewers")
    .fill(`${REVIEWER1}\n${REVIEWER2}`);
  // The kit locked this DAO's Shares against transfers at birth, so they can never be a reviewer's bond: not offered as
  // "the project's own token", and refused when pasted as "another token" too, read from the chain (D103).
  await founder.getByTestId("budget-bond").fill("10");
  await expect(founder.getByTestId("budget-bond-shares-locked")).toBeVisible({
    timeout: 20_000,
  });
  await expect(
    founder.getByTestId("budget-bond-token").locator("option[value='project']"),
  ).toHaveCount(0);
  await founder.getByTestId("budget-bond-token").selectOption("other");
  await founder.getByTestId("budget-bond-other").fill(SHARES);
  await expect(founder.getByTestId("decision-draft-problem")).toContainText(
    "locked against transfers",
    { timeout: 20_000 },
  );
  await expect(founder.getByTestId("decision-draft-submit")).toHaveCount(0);
  await founder.getByTestId("budget-bond").fill("");
  await expect(founder.getByTestId("decision-draft-title")).toHaveText(
    "Set aside a work budget",
  );
  await expect(founder.getByTestId("decision-draft")).toContainText(
    "Money for work: 5,000 in all, at most 1,000 per project",
  );
  await founder.getByTestId("decision-draft-submit").click();
  await expect(founder.getByTestId("decision-opened")).toBeVisible({
    timeout: 60_000,
  });
  await carryOut(founder, 175_000, 90_000);
  expect(await moneyOf(DAO)).toBe(treasury - 5_000n * 10n ** 6n);

  // ── 2. a project inside it that may hold money ────────────────────────────────────────────
  await refresh(founder, "Decisions");
  await founder.getByTestId("decision-new").click();
  await founder.getByTestId("decision-kind-project").click();
  await founder.getByTestId("project-name").fill("docs");
  await founder.getByTestId("project-manager").fill(MANAGER);
  await founder.getByTestId("project-money").fill("1000");
  await founder.getByTestId("project-check").fill(CHECK);
  await expect(founder.getByTestId("decision-draft")).toContainText(
    "May hold up to 1,000",
  );
  await founder.getByTestId("decision-draft-submit").click();
  await expect(founder.getByTestId("decision-opened")).toBeVisible({
    timeout: 60_000,
  });
  await carryOut(founder, 90_000, 90_000);

  // ── 3. the contributor asks to be paid, with a deposit ─────────────────────────────────────
  const contributor = await context.newPage();
  await openAs(contributor, CONTRIBUTOR, "Work");
  // Opening the form moves the caret to the name on the next frame. A slow device delivers that frame late, after the
  // person has already clicked into another field: what they type must stay where they put it.
  await contributor.evaluate(() => {
    const frame = window.requestAnimationFrame.bind(window);
    const late = (callback: FrameRequestCallback) =>
      window.setTimeout(() => frame(callback), 1_000);
    Object.assign(window, { __frame: frame });
    window.requestAnimationFrame = late as typeof window.requestAnimationFrame;
  });
  await contributor.getByTestId("work-file-open").click();
  await contributor.getByTestId("work-claim-evidence").click();
  await contributor.waitForTimeout(1_500);
  await contributor.keyboard.type("https://example.com/pr/1");
  await expect(contributor.getByTestId("work-claim-evidence")).toHaveValue(
    "https://example.com/pr/1",
  );
  await expect(contributor.getByTestId("work-claim-name")).toHaveValue("");
  await contributor.evaluate(() => {
    const { __frame } = window as unknown as {
      __frame: typeof window.requestAnimationFrame;
    };
    window.requestAnimationFrame = __frame;
  });
  await expect(contributor.getByTestId("work-filing-wallet")).toContainText(
    new RegExp(CONTRIBUTOR, "i"),
  );
  await expect(contributor.getByTestId("work-projects")).toContainText("docs", {
    timeout: 30_000,
  });
  const before = await moneyOf(CONTRIBUTOR);
  await contributor.getByTestId("work-claim-name").fill("write-docs");
  await contributor
    .getByTestId("work-claim-evidence")
    .fill("https://example.com/pr/1");
  await contributor
    .getByTestId("work-claim-met")
    .fill("Checked it against the work area's words");
  await contributor.getByTestId("work-claim-check").fill(CHECK);
  await contributor
    .getByTestId("work-claim-pay-section")
    .locator("summary")
    .click();
  // More than the project can hold is refused before the wallet is asked.
  await contributor.getByTestId("work-claim-pay").fill("5000");
  await contributor.getByTestId("work-claim-submit").click();
  await expect(contributor.getByTestId("work-claim-problem")).toContainText(
    "at most 1,000",
  );
  // A deposit larger than the wallet holds is refused too.
  await contributor.getByTestId("work-claim-pay").fill("400");
  await contributor.getByTestId("work-claim-deposit").fill("999999");
  await contributor.getByTestId("work-claim-submit").click();
  await expect(contributor.getByTestId("work-claim-problem")).toContainText(
    "your wallet holds",
  );
  await contributor.getByTestId("work-claim-deposit").fill("50");
  await contributor.getByTestId("work-claim-submit").click();
  await expect(contributor.getByTestId("work-claim-filed")).toBeVisible({
    timeout: 90_000,
  });
  // The deposit is held while the claim is open.
  expect(before - (await moneyOf(CONTRIBUTOR))).toBe(50n * 10n ** 6n);

  // ── 4. the manager takes it on, which sets the money aside for it; the reviewers approve ─────
  const manager = await context.newPage();
  await openAs(manager, MANAGER, "Work");
  await manager.getByTestId("work-bind").click();
  await expect(manager.getByTestId("work-claim-next")).toContainText(
    "0 of 2 approvals",
    { timeout: 60_000 },
  );
  for (const account of [REVIEWER1, REVIEWER2]) {
    const reviewer = await context.newPage();
    await openAs(reviewer, account, "Work");
    await reviewer.getByTestId("work-approve").click();
    await expect(reviewer.getByTestId("work-claim-next")).not.toContainText(
      "0 of 2 approvals",
      { timeout: 60_000 },
    );
  }
  await refresh(manager, "Work");
  await manager.getByTestId("work-settle").click();
  await expect(manager.getByTestId("work-claim-status")).toContainText(
    "Approved",
    { timeout: 60_000 },
  );

  // ── 5. after the waiting period the contributor takes the payment, and the deposit comes back ─────
  await pass(700_000);
  await contributor
    .getByRole("button", { name: "Refresh", exact: true })
    .click();
  await expect(contributor.getByTestId("work-payment-recipient")).toContainText(
    new RegExp(CONTRIBUTOR, "i"),
  );
  await contributor.getByTestId("work-payout").click();
  await expect(contributor.getByTestId("work-claim-status")).toContainText(
    "Paid",
    { timeout: 60_000 },
  );
  expect((await moneyOf(CONTRIBUTOR)) - before).toBe(400n * 10n ** 6n);
  await expect(contributor.getByTestId("work-payout")).toHaveCount(0);
});

test("a manual treasury payment selects a verified Nostr recipient on the right chain and pays the exact USDC amount", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const key = hexToBytes("44".repeat(32));
  const pubkey = getPublicKey(key);
  const address = CONTRIBUTOR.toLowerCase();
  const now = Math.floor(Date.now() / 1000);
  const proof = newWalletAttestation(address, pubkey, 31337, now, 123);
  proof.signature = String(
    await rpc("eth_signTypedData_v4", [CONTRIBUTOR, walletTypedData(proof)]),
  );
  const template = {
    kind: 37017,
    created_at: now - 10,
    tags: [
      ["d", address],
      ["address", address],
      ["chain", "31337"],
    ],
    content: JSON.stringify({
      v: 1,
      address,
      siweMessageHash: siweMessageHash("local test fixture"),
      attestation: proof,
    }),
  };
  const valid = finalizeEvent({ ...template }, key);
  const forged = finalizeEvent({ ...template }, hexToBytes("55".repeat(32)));
  expect(resolvePaymentWallet([valid], pubkey, now).state).toBe("verified");
  publicWallets = [valid, forged, paymentRecord()]; // The last proof belongs to chain 8453.
  await openAs(page, FOUNDER_WALLET, "Decisions");
  await page.getByTestId("decision-new").click();
  await page.getByTestId("decision-kind-pay").click();
  // A direct payment says plainly that no reviewer is involved, and offers the reviewed way instead.
  await expect(page.getByTestId("decision-pay-warning")).toContainText(
    "No reviewer checks anything before it goes",
  );
  await expect(page.getByTestId("decision-pay-use-budget")).toBeVisible();
  const picker = page.getByTestId("pay-recipient-people");
  await expect(picker.locator("option")).toHaveCount(2); // Placeholder and the one valid recipient.
  await expect(picker.locator(`option[value="${pubkey}"]`)).toBeAttached();

  // Revocation between loading the form and selecting a person is caught by the fresh read.
  const revoked = finalizeEvent(
    {
      ...template,
      created_at: now - 1,
      content: JSON.stringify({
        ...JSON.parse(template.content),
        revoked: true,
      }),
    },
    key,
  );
  publicWallets.push(revoked);
  await picker.selectOption(pubkey);
  await expect(page.getByRole("alert")).toContainText("proof changed");
  await expect(page.getByTestId("pay-recipient")).toHaveValue("");
  publicWallets = [valid, forged, paymentRecord()];
  await refresh(page, "Decisions");
  await page.getByTestId("decision-new").click();
  await page.getByTestId("decision-kind-pay").click();
  await page.getByTestId("pay-recipient-people").selectOption(pubkey);
  await expect(page.getByTestId("pay-recipient")).toHaveValue(
    /0x[0-9a-fA-F]{40}/,
  );
  expect(
    (await page.getByTestId("pay-recipient").inputValue()).toLowerCase(),
  ).toBe(address);
  await page.getByTestId("pay-amount").fill("12.34");
  await expect(page.getByTestId("decision-draft-title")).toHaveText(
    "Pay 12.34 USDC from the treasury",
  );
  await expect(page.getByTestId("decision-draft")).toContainText(address);
  const before = await moneyOf(CONTRIBUTOR);
  const treasury = await moneyOf(DAO);
  await page.getByTestId("decision-draft-submit").click();
  await expect(page.getByTestId("decision-opened")).toBeVisible({
    timeout: 60_000,
  });
  expect(await moneyOf(CONTRIBUTOR)).toBe(before); // Opening the proposal sends no money.
  await carryOut(page, 175_000, 90_000);
  expect((await moneyOf(CONTRIBUTOR)) - before).toBe(12_340_000n);
  expect(treasury - (await moneyOf(DAO))).toBe(12_340_000n);

  // The decision is marked as having had no reviewer, and the DAO's front page counts it apart from the reviewed budget.
  await refresh(page, "Decisions");
  await expect(page.getByTestId("decision-no-review").first()).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole("tab", { name: "Overview" }).click();
  await expect(page.getByTestId("dao-spending-direct")).toContainText(
    "12.34 USDC in 1 payment",
    { timeout: 30_000 },
  );
  await expect(page.getByTestId("dao-spending-reviewed")).toContainText(
    "has been paid for work the reviewers approved",
  );
  await expect(page.getByTestId("dao-spending-headline")).toContainText(
    "paid out directly with no reviewer",
  );
});

test("a form that picks from the work budgets waits for them instead of saying there are none", async ({
  context,
}) => {
  test.setTimeout(120_000);
  const page = await context.newPage();
  // Hold every log read that is not the DAO's own decisions: that is what the work budgets and claims are read from.
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let heldReads = 0;
  await page.route(ANVIL_URL, async (route) => {
    let body: { method?: string; params?: { address?: string }[] } = {};
    try {
      body = JSON.parse(route.request().postData() ?? "{}");
    } catch {
      // Not a JSON-RPC call: let it through.
    }
    const address = body.params?.[0]?.address?.toLowerCase();
    if (body.method === "eth_getLogs" && address !== DAO.toLowerCase()) {
      heldReads += 1;
      await held;
    }
    await route.continue();
  });
  await openAs(page, FOUNDER_WALLET, "Decisions");
  await page.getByTestId("decision-new").click();
  await page.getByTestId("decision-kind-freeze").click();
  await expect(page.getByTestId("decision-reading-work")).toBeVisible({
    timeout: 30_000,
  });
  // Not yet known is not the same as none: the form must not claim there is nothing to freeze.
  await expect(page.getByTestId("freeze-none")).toHaveCount(0);
  expect(heldReads).toBeGreaterThan(0);
  release();
  await expect(page.getByTestId("decision-reading-work")).toHaveCount(0, {
    timeout: 30_000,
  });
  await expect(page.getByTestId("form-freeze")).toBeVisible();
});
