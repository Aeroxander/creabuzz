import { expect, test, type Page } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";
import { installAnvilWallet } from "../helpers/anvil-wallet";

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

test.skip(
  !ANVIL_URL || !DAO || !SHARES,
  "set E2E_ANVIL_URL, E2E_DAO and E2E_SHARES (scripts/web-paid-work-e2e.sh does)",
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
    "Waiting to run",
    { timeout: 30_000 },
  );
  await pass(secondsToWait);
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
  await expect(contributor.getByTestId("work-projects")).toContainText("docs", {
    timeout: 30_000,
  });
  const before = await moneyOf(CONTRIBUTOR);
  await contributor.getByTestId("work-claim-name").fill("write-docs");
  await contributor
    .getByTestId("work-claim-evidence")
    .fill("https://example.com/pr/1");
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
  await pass(260_000);
  await refresh(contributor, "Work");
  await contributor.getByTestId("work-payout").click();
  await expect(contributor.getByTestId("work-claim-status")).toContainText(
    "Paid",
    { timeout: 60_000 },
  );
  expect((await moneyOf(CONTRIBUTOR)) - before).toBe(400n * 10n ** 6n);
});
