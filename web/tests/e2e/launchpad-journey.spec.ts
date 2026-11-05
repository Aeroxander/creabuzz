import { expect, test, type Page } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";
import { installAnvilWallet } from "../helpers/anvil-wallet";
import { publishedEvents } from "../helpers/published-events";
import { PREVIEW_ORIGIN } from "./mock-relay";

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
    // The team's pledge of part of what the project earns (D78): shown beside the money that came in.
    revenuePledge: { v: 1, percent: 20, every: "quarter" },
    tokenPlan: {
      mode: "dao",
      name: "Nebula",
      symbol: "NEB",
      supply: "200000000",
    },
  }),
  sig: "sig",
};

const PEOPLE = [
  { name: "Rita Reviewer", pubkey: "a1".repeat(32), wallet: REVIEWER1 },
  { name: "Rob Reviewer", pubkey: "a2".repeat(32), wallet: REVIEWER2 },
  { name: "Mia Manager", pubkey: "a3".repeat(32), wallet: MANAGER },
];

function bindingOf(person: (typeof PEOPLE)[number]) {
  const address = person.wallet.toLowerCase();
  return {
    id: `binding-${person.pubkey.slice(0, 8)}`,
    pubkey: person.pubkey,
    created_at: 100,
    kind: 37017,
    tags: [
      ["d", address],
      ["address", address],
    ],
    content: JSON.stringify({ v: 1, address }),
    sig: "sig",
  };
}

function profileOf(person: (typeof PEOPLE)[number]) {
  return {
    id: `profile-${person.pubkey.slice(0, 8)}`,
    pubkey: person.pubkey,
    created_at: 100,
    kind: 0,
    tags: [],
    content: JSON.stringify({ name: person.name }),
    sig: "sig",
  };
}

/** With `E2E_SHOTS=<dir>`, save the page as it looks now, so a person can read the product off real data. */
async function shot(page: Page, name: string) {
  const dir = process.env.E2E_SHOTS;
  if (!dir) return;
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });
}

async function openAs(page: Page, account: string, tab: "Decisions" | "Work") {
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
      // The people the forms offer by name: three wallets bound to three profiles.
      if (filter.kinds?.includes(37017)) {
        for (const person of PEOPLE) {
          ws.send(JSON.stringify(["EVENT", subId, bindingOf(person)]));
        }
      }
      if (filter.kinds?.includes(0)) {
        for (const person of PEOPLE) {
          ws.send(JSON.stringify(["EVENT", subId, profileOf(person)]));
        }
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

test("a DAO sets aside work, approves a project, pays out a claim and awards Shares, all from the page", async ({
  context,
}) => {
  test.setTimeout(420_000);
  const founder = await context.newPage();
  await openAs(founder, FOUNDER_WALLET, "Decisions");
  await expect(founder.getByTestId("decisions-empty")).toBeVisible({
    timeout: 20_000,
  });
  await shot(founder, "1-decisions-empty");

  // A DAO with nothing set up is offered its first step, and the button goes where it is taken.
  await founder.getByRole("tab", { name: "Overview" }).click();
  await expect(founder.getByTestId("dao-start-work")).toBeVisible({
    timeout: 30_000,
  });
  await founder.getByTestId("dao-start-work").getByRole("button").click();
  await expect(founder.getByTestId("decisions-tab")).toBeVisible();

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
  // Reviewers are picked by name, not typed as addresses.
  const reviewerPicker = founder.getByTestId("budget-reviewers-people");
  await expect(
    reviewerPicker.locator("option", { hasText: "Rita Reviewer" }),
  ).toHaveCount(1, { timeout: 20_000 });
  await reviewerPicker.selectOption(REVIEWER1.toLowerCase());
  await reviewerPicker.selectOption(REVIEWER2.toLowerCase());
  // Picking the same person twice adds nothing.
  await reviewerPicker.selectOption(REVIEWER2.toLowerCase());
  await expect(founder.getByTestId("budget-reviewers")).toHaveValue(
    `${REVIEWER1.toLowerCase()}\n${REVIEWER2.toLowerCase()}`,
  );
  await expect(founder.getByTestId("decision-draft-title")).toHaveText(
    "Set aside a work budget",
  );
  await expect(founder.getByTestId("decision-draft")).toContainText(
    "2 reviewers, 2 must agree on each submission",
  );
  await shot(founder, "2-composer");
  await founder.getByTestId("decision-draft-submit").click();
  await expect(founder.getByTestId("decision-opened")).toContainText(
    "Set aside a work budget",
    {
      timeout: 60_000,
    },
  );
  await shot(founder, "3-decision-opened");

  // The DAO's front page says it needs the founder's vote, and the button goes to where it is cast.
  await founder.getByRole("tab", { name: "Overview" }).click();
  await expect(founder.getByTestId("dao-needs-you")).toContainText(
    "Open for your vote: Set aside a work budget",
    { timeout: 30_000 },
  );
  await expect(founder.getByTestId("dao-summary")).toContainText(
    "1 decision is open",
  );
  await expect(founder.getByTestId("dao-figure-yours")).toContainText(
    "200,000,000 Shares",
  );
  // The card leads with one action now (the rest, if any, sit under `dao-attention`),
  // so the button is found by what it does, not by which list it is in.
  await founder
    .getByTestId("dao-needs-you")
    .getByRole("button", {
      name: "Vote — Open for your vote: Set aside a work budget.",
    })
    .click();
  await expect(founder.getByTestId("decisions-tab")).toBeVisible();
  await carryOut(founder, 175_000, 90_000);

  // ── 2. a project inside it, approved the same way (the lighter vote) ───────────────────
  await refresh(founder, "Decisions");
  await founder.getByTestId("decision-new").click();
  await founder.getByTestId("decision-kind-project").click();
  await expect(founder.getByTestId("project-no-budget")).toHaveCount(0);
  await founder.getByTestId("project-name").fill("docs");
  await founder
    .getByTestId("project-manager-people")
    .selectOption(MANAGER.toLowerCase());
  await expect(founder.getByTestId("project-manager")).toHaveValue(
    MANAGER.toLowerCase(),
  );
  await founder.getByTestId("project-shares").fill("40");
  await founder.getByTestId("project-check").fill(CHECK);
  await expect(founder.getByTestId("decision-draft-title")).toHaveText(
    "Approve the work area “Docs”",
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
  await shot(contributor, "4-work-tab");
  await contributor.getByTestId("work-file-open").click();
  await contributor.getByTestId("work-claim-name").fill("write-docs");
  await contributor
    .getByTestId("work-claim-evidence")
    .fill("https://example.com/pr/1");
  await contributor
    .getByTestId("work-claim-met")
    .fill("Checked it against the work area's words");
  await contributor.getByTestId("work-claim-check").fill(CHECK);
  await contributor.getByTestId("work-claim-submit").click();
  await expect(contributor.getByTestId("work-claim-filed")).toBeVisible({
    timeout: 60_000,
  });

  const manager = await context.newPage();
  await openAs(manager, MANAGER, "Work");
  await shot(manager, "5-claim-to-take-on");
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
  // The chip reads the review's outcome, not the record's enum: once the panel has
  // finished, the claim says "Review complete" and the challenge window opens.
  await expect(manager.getByTestId("work-claim-status")).toContainText(
    "Review complete",
    { timeout: 60_000 },
  );
  await pass(700_000);
  await refresh(contributor, "Work");
  await contributor.getByTestId("work-payout").click();
  // A claim that asked for no money finishes; it is never shown as paid.
  await expect(contributor.getByTestId("work-claim-status")).toContainText(
    "Finished",
    { timeout: 60_000 },
  );
  // The award is the DAO's vote, and the page sends them to where it is made.
  await expect(contributor.getByTestId("work-award-help")).toContainText(
    "judgment call that the project votes on",
  );

  // ── 4. the founder awards Shares for it, in a form, and the contributor ends up holding them ────
  expect(await sharesOf(CONTRIBUTOR)).toBe(0n);
  await refresh(founder, "Decisions");
  await founder.getByTestId("decision-new").click();
  await founder.getByTestId("decision-kind-award").click();
  await expect(founder.getByTestId("award-none")).toHaveCount(0);
  await founder.getByTestId("award-shares").fill("25");
  await expect(founder.getByTestId("decision-draft-title")).toContainText(
    "Award 25 Shares for the submission “Write docs”",
  );
  await founder.getByTestId("decision-draft-submit").click();
  await expect(founder.getByTestId("decision-opened")).toBeVisible({
    timeout: 60_000,
  });
  await carryOut(founder, 90_000, 90_000);
  expect(await sharesOf(CONTRIBUTOR)).toBe(25n * WAD);
  // Everything is done: nothing is waiting, and the three decisions show as done.
  await founder.getByRole("tab", { name: "Overview" }).click();
  await expect(founder.getByTestId("dao-needs-you")).toContainText(
    "Nothing is waiting for you",
    { timeout: 30_000 },
  );
  await expect(founder.getByTestId("dao-latest")).toContainText(
    "Award 25 Shares for the submission “Write docs”",
  );
  for (const tab of ["Overview", "Decisions", "Treasury"] as const) {
    await founder.getByRole("tab", { name: tab }).click();
    await shot(founder, `6-${tab.toLowerCase()}`);
  }

  // ── 5. the year's allowance of new Shares: the award counted against it (D76) ─────────────────────────
  // 800M Shares outside the DAO, the team's 200M still locked: 10% of the 600M that count on exit is 60M a year.
  await refresh(founder, "Work");
  await expect(founder.getByTestId("work-allowance")).toContainText(
    "59,999,975 of this year's 60,000,000 new Shares are left to award",
    { timeout: 30_000 },
  );

  // ── 6. money paid in shows beside the team's pledge, never called revenue (D78) ─────────────────────
  const paid = 1_500n * 10n ** 6n;
  await rpc("eth_sendTransaction", [
    {
      from: FOUNDER_WALLET,
      to: CURRENCY,
      data: `0xa9059cbb${DAO.slice(2).toLowerCase().padStart(64, "0")}${paid.toString(16).padStart(64, "0")}`,
    },
  ]);
  await founder.getByRole("tab", { name: "Overview" }).click();
  await founder.reload();
  const moneyIn = founder.getByTestId("dao-money-in");
  await expect(moneyIn.getByTestId("dao-money-in-headline")).toContainText(
    "Apart from the money raised, 1,500",
    { timeout: 30_000 },
  );
  await expect(moneyIn.getByTestId("dao-money-in-pledge")).toContainText(
    "The team pledges 20% of the project's net receipts, to be paid into the project's money every quarter",
  );
  await expect(moneyIn.getByTestId("dao-money-in-pledge")).toContainText(
    "The contracts do not enforce it.",
  );
  await shot(founder, "7-money-in");

  // ── 7. opening trading: announced by one vote, opened by a second only 30 days later (D77) ──────────
  await refresh(founder, "Decisions");
  await founder.getByTestId("decision-new").click();
  await founder.getByTestId("decision-kind-trading").click();
  await expect(founder.getByTestId("trading-state")).toContainText(
    "Trading is locked",
    { timeout: 30_000 },
  );
  // The bar is the app's policy: nothing is offered until the proposer says they checked it.
  await expect(founder.getByTestId("trading-bar")).toContainText(
    "The contracts check none of this",
  );
  await expect(founder.getByTestId("decision-draft-submit")).toHaveCount(0);
  await founder.getByTestId("trading-bar-checked").check();
  await expect(founder.getByTestId("decision-draft-title")).toContainText(
    "Announce that trading opens in 30 days",
  );
  await founder.getByTestId("decision-draft-submit").click();
  await expect(founder.getByTestId("decision-opened")).toBeVisible({
    timeout: 60_000,
  });
  await carryOut(founder, 175_000, 90_000);
  await founder.getByTestId("decision-new").click();
  await founder.getByTestId("decision-kind-trading").click();
  await expect(founder.getByTestId("trading-state")).toContainText(
    "Trading was announced. It can open from",
    { timeout: 30_000 },
  );
  // Inside the 30 days the only step is to withdraw it.
  await expect(founder.getByTestId("decision-draft-title")).toContainText(
    "Withdraw the announcement",
  );
  await pass(30 * 86_400);
  await refresh(founder, "Decisions");
  await founder.getByTestId("decision-new").click();
  await founder.getByTestId("decision-kind-trading").click();
  await expect(founder.getByTestId("trading-state")).toContainText(
    "A vote can open it now",
    { timeout: 30_000 },
  );
  await founder.getByTestId("trading-bar-checked").check();
  await expect(founder.getByTestId("decision-draft-title")).toHaveText(
    "Open trading",
  );
  await founder.getByTestId("decision-draft-submit").click();
  await expect(founder.getByTestId("decision-opened")).toBeVisible({
    timeout: 60_000,
  });
  await carryOut(founder, 175_000, 90_000);
  await founder.getByTestId("decision-new").click();
  await founder.getByTestId("decision-kind-trading").click();
  await expect(founder.getByTestId("trading-state")).toContainText(
    "Trading is open",
    { timeout: 30_000 },
  );
  // The chain agrees: Shares now move between wallets.
  expect(
    BigInt(
      String(
        await rpc("eth_call", [{ to: SHARES, data: "0x83f1211b" }, "latest"]),
      ),
    ),
  ).toBe(0n);
  await shot(founder, "8-trading-open");
});
