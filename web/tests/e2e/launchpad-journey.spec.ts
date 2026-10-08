import { expect, test, type Page } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";
import { installAnvilWallet } from "../helpers/anvil-wallet";

/**
 * A DAO run entirely from the browser, against a REAL local chain: no command line anywhere.
 *
 * Opt-in: `scripts/web-dao-journey-e2e.sh` builds the world (a project launched into its own DAO through the kit) and
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
const WAD = 10n ** 18n;
const CHECK = "docs merged and reviewed";

test.skip(
  !ANVIL_URL || !DAO || !SHARES,
  "set E2E_ANVIL_URL, E2E_DAO and E2E_SHARES (scripts/web-dao-journey-e2e.sh does)",
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

const sharesOf = async (holder: string) =>
  BigInt(
    String(
      await rpc("eth_call", [
        {
          to: SHARES,
          data: `0x70a08231${holder.slice(2).toLowerCase().padStart(64, "0")}`,
        },
        "latest",
      ]),
    ),
  );

const record = {
  id: "record-journey",
  pubkey: FOUNDER,
  created_at: 100,
  kind: 37001,
  tags: [
    ["d", "nebula-journey"],
    ["name", "Nebula DAO"],
    ["t", "dao-launchpad"],
    ["chain", "31337"],
    ["treasury", DAO],
  ],
  content: JSON.stringify({
    pitch: "A DAO run from the page.",
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
  await page.goto(`/launchpad/nebula-journey?author=${FOUNDER}`);
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

test("a DAO sets aside work, approves a project, pays out a claim and awards Shares, all from the page", async ({
  context,
}) => {
  test.setTimeout(420_000);
  const founder = await context.newPage();
  await openAs(founder, FOUNDER_WALLET, "Decisions");
  await expect(founder.getByTestId("decisions-empty")).toBeVisible({
    timeout: 20_000,
  });

  // ── 1. the founder puts a work budget to a vote, in a form ─────────────────────────────
  await founder.getByTestId("decision-new").click();
  await founder.getByTestId("decision-kind-budget").click();
  // Words that cannot make a budget are refused before anything is sent.
  await founder.getByTestId("budget-shares").fill("100");
  await expect(founder.getByTestId("decision-draft-problem")).toContainText(
    "limit per project",
  );
  await expect(founder.getByTestId("decision-draft-submit")).toHaveCount(0);
  await founder.getByTestId("budget-shares-cap").fill("40");
  await founder
    .getByTestId("budget-reviewers")
    .fill(`${REVIEWER1}\n${REVIEWER2}`);
  await expect(founder.getByTestId("decision-draft-title")).toHaveText(
    "Set aside a work budget",
  );
  await expect(founder.getByTestId("decision-draft")).toContainText(
    "2 reviewers, 2 must agree on each claim",
  );
  await founder.getByTestId("decision-draft-submit").click();
  await expect(founder.getByTestId("decision-opened")).toContainText(
    "Set aside a work budget",
    {
      timeout: 60_000,
    },
  );
  await carryOut(founder, 175_000, 90_000);

  // ── 2. a project inside it, approved the same way (the lighter vote) ───────────────────
  await refresh(founder, "Decisions");
  await founder.getByTestId("decision-new").click();
  await founder.getByTestId("decision-kind-project").click();
  await expect(founder.getByTestId("project-no-budget")).toHaveCount(0);
  await founder.getByTestId("project-name").fill("docs");
  await founder.getByTestId("project-manager").fill(MANAGER);
  await founder.getByTestId("project-shares").fill("40");
  await founder.getByTestId("project-check").fill(CHECK);
  await expect(founder.getByTestId("decision-draft-title")).toHaveText(
    "Approve the project “docs”",
  );
  await expect(founder.getByTestId("decision-draft")).toContainText(
    "lighter vote",
  );
  await founder.getByTestId("decision-draft-submit").click();
  await expect(founder.getByTestId("decision-opened")).toBeVisible({
    timeout: 60_000,
  });
  await carryOut(founder, 90_000, 90_000);

  // ── 3. the contributor's claim goes through its people, each from their own wallet ────
  const contributor = await context.newPage();
  await openAs(contributor, CONTRIBUTOR, "Work");
  await expect(contributor.getByTestId("work-projects")).toContainText("docs", {
    timeout: 30_000,
  });
  await contributor.getByTestId("work-claim-name").fill("write-docs");
  await contributor
    .getByTestId("work-claim-evidence")
    .fill("https://example.com/pr/1");
  await contributor.getByTestId("work-claim-check").fill(CHECK);
  await contributor.getByTestId("work-claim-submit").click();
  await expect(contributor.getByTestId("work-claim-filed")).toBeVisible({
    timeout: 60_000,
  });

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
      {
        timeout: 60_000,
      },
    );
  }
  await refresh(manager, "Work");
  await manager.getByTestId("work-settle").click();
  await expect(manager.getByTestId("work-claim-status")).toContainText(
    "Approved",
    { timeout: 60_000 },
  );
  await pass(260_000);
  await refresh(contributor, "Work");
  await contributor.getByTestId("work-payout").click();
  await expect(contributor.getByTestId("work-claim-status")).toContainText(
    "Paid",
    { timeout: 60_000 },
  );
  // The award is the DAO's vote, and the page sends them to where it is made.
  await expect(contributor.getByTestId("work-award-help")).toContainText(
    "decision the DAO votes on",
  );

  // ── 4. the founder awards Shares for it, in a form, and the contributor ends up holding them ────
  expect(await sharesOf(CONTRIBUTOR)).toBe(0n);
  await refresh(founder, "Decisions");
  await founder.getByTestId("decision-new").click();
  await founder.getByTestId("decision-kind-award").click();
  await expect(founder.getByTestId("award-none")).toHaveCount(0);
  await founder.getByTestId("award-shares").fill("25");
  await expect(founder.getByTestId("decision-draft-title")).toContainText(
    "Award 25 Shares for the claim “write-docs”",
  );
  await founder.getByTestId("decision-draft-submit").click();
  await expect(founder.getByTestId("decision-opened")).toBeVisible({
    timeout: 60_000,
  });
  await carryOut(founder, 90_000, 90_000);
  expect(await sharesOf(CONTRIBUTOR)).toBe(25n * WAD);
});
