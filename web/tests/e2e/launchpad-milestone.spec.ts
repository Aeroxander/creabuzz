import { expect, test, type Page } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";
import { installAnvilWallet } from "../helpers/anvil-wallet";
import { publishedEvents } from "../helpers/published-events";

/**
 * Unlocking the team's Shares in the browser, against a REAL local chain.
 *
 * Opt-in: `scripts/web-milestone-e2e.sh` builds the world (a project launched into its own DAO through the kit with the
 * founder's Shares locked behind two milestones, and a Paid claim for the first) and runs this spec. What is stubbed:
 * the relay (it only serves the launch record) and the wallet (`window.ethereum` forwarding to Anvil's unlocked
 * accounts).
 */

const ANVIL_URL = process.env.E2E_ANVIL_URL ?? "";
const DAO = process.env.E2E_DAO ?? "";
const LOCK = process.env.E2E_LOCK ?? "";
const SHARES = process.env.E2E_SHARES ?? "";
const STRANGER = process.env.E2E_STRANGER ?? "";
// Anvil's first dev account: the founder, who holds the team's Shares.
const FOUNDER_WALLET = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const NSEC = "22".repeat(32);
const FOUNDER = getPublicKey(
  Uint8Array.from(NSEC.match(/.{2}/g) ?? [], (b) => Number.parseInt(b, 16)),
);
const WAD = 10n ** 18n;
const TEAM = 200_000_000n * WAD;
const SECOND_TRANCHE = 120_000_000n * WAD;

test.skip(
  !ANVIL_URL || !DAO || !LOCK,
  "set E2E_ANVIL_URL, E2E_DAO, E2E_LOCK and E2E_SHARES (scripts/web-milestone-e2e.sh does)",
);

/** What the pages of this test publish, read back by the others (the evidence a reviewer reads). */
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

const word = (value: string) => value.slice(2).toLowerCase().padStart(64, "0");
const lockedOf = async (holder: string) =>
  BigInt(
    String(
      await rpc("eth_call", [
        { to: LOCK, data: `0xa5f1e282${word(holder)}` },
        "latest",
      ]),
    ),
  );

const record = {
  id: "record-milestone",
  pubkey: FOUNDER,
  created_at: 100,
  kind: 37001,
  tags: [
    ["d", "nebula-milestone"],
    ["name", "Nebula DAO"],
    ["t", "dao-launchpad"],
    ["chain", "31337"],
    ["treasury", DAO],
  ],
  content: JSON.stringify({
    pitch: "A team that earns its Shares.",
    stage: "graduated",
    tokenPlan: {
      mode: "dao",
      name: "Nebula",
      symbol: "NEB",
      supply: "200000000",
    },
    unlocks: {
      mode: "milestones",
      allocationPct: 10,
      milestones: [
        {
          claim: "m1",
          label: "alpha shipped",
          percent: 40,
          verifier: "founder",
        },
        {
          claim: "m2",
          label: "mainnet live",
          percent: 60,
          verifier: "founder",
        },
      ],
      months: null,
    },
  }),
  sig: "sig",
};

// The founder bound the first Anvil wallet to their account and gave themselves a name.
const bindingRecord = {
  id: "binding-founder",
  pubkey: FOUNDER,
  created_at: 90,
  kind: 37017,
  tags: [
    ["d", FOUNDER_WALLET.toLowerCase()],
    ["address", FOUNDER_WALLET.toLowerCase()],
  ],
  content: JSON.stringify({ v: 1, address: FOUNDER_WALLET.toLowerCase() }),
  sig: "sig",
};
const profileRecord = {
  id: "profile-founder",
  pubkey: FOUNDER,
  created_at: 80,
  kind: 0,
  tags: [],
  content: JSON.stringify({ display_name: "Fiona Founder" }),
  sig: "sig",
};

/** A tiny relay: serves the launch record, the founder's wallet binding and name, and nothing else. */
async function serveRecord(page: Page) {
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
      if (filter.kinds?.includes(37001)) {
        ws.send(JSON.stringify(["EVENT", subId, record]));
      }
      if (filter.kinds?.includes(37017)) {
        ws.send(JSON.stringify(["EVENT", subId, bindingRecord]));
      }
      if (filter.kinds?.includes(0)) {
        ws.send(JSON.stringify(["EVENT", subId, profileRecord]));
      }
      published.serve(ws, subId, filter.kinds);
      ws.send(JSON.stringify(["EOSE", subId]));
    });
  });
}

/** Open the Work tab as one person's wallet. */
async function openWork(
  page: Page,
  account: string,
  wallet: { rejectSendAt?: number } = {},
) {
  await serveRecord(page);
  await installAnvilWallet(page, account, { rpcUrl: ANVIL_URL, ...wallet });
  await page.addInitScript(
    ([nsec, rpcUrl]) => {
      window.localStorage.setItem("buzz.identity.nsec", nsec);
      window.localStorage.setItem("buzz.launchpad.rpc", rpcUrl);
    },
    [NSEC, ANVIL_URL],
  );
  await page.goto(`/launchpad/nebula-milestone?author=${FOUNDER}`);
  await page.getByRole("tab", { name: "Work" }).click();
  await expect(page.getByTestId("work-tab")).toBeVisible({ timeout: 20_000 });
}

/** Open the portfolio as one person's wallet. */
async function openPortfolio(page: Page, account: string) {
  await serveRecord(page);
  await installAnvilWallet(page, account, { rpcUrl: ANVIL_URL });
  await page.addInitScript(
    ([nsec, rpcUrl]) => {
      window.localStorage.setItem("buzz.identity.nsec", nsec);
      window.localStorage.setItem("buzz.launchpad.rpc", rpcUrl);
    },
    [NSEC, ANVIL_URL],
  );
  await page.goto("/portfolio");
}

/** Open the milestones with no wallet at all: it is the same page for everyone. */
async function openMilestones(page: Page) {
  await serveRecord(page);
  await page.addInitScript((rpcUrl) => {
    window.localStorage.setItem("buzz.launchpad.rpc", rpcUrl);
  }, ANVIL_URL);
  await page.goto(
    `/launchpad/nebula-milestone?author=${FOUNDER}&tab=milestones`,
  );
  await expect(page.getByTestId("milestones-tab")).toBeVisible({
    timeout: 20_000,
  });
}

/** Open the track record with no wallet at all: it is the same page for everyone. */
async function openRecord(page: Page) {
  await serveRecord(page);
  await page.addInitScript((rpcUrl) => {
    window.localStorage.setItem("buzz.launchpad.rpc", rpcUrl);
  }, ANVIL_URL);
  await page.goto(`/launchpad/nebula-milestone?author=${FOUNDER}&tab=record`);
  await expect(page.getByTestId("record-tab")).toBeVisible({ timeout: 20_000 });
}

test("the founder sees what is locked, unlocks the first milestone with one click, and a stranger sees nothing of it", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  expect(await lockedOf(FOUNDER_WALLET)).toBe(TEAM);

  await openWork(page, FOUNDER_WALLET);
  const card = page.getByTestId("locked-shares");
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("locked-shares-total")).toContainText(
    "200,000,000 Shares are still locked",
  );

  // The first milestone has a Paid claim waiting; the second has nothing yet.
  const first = page.getByTestId("locked-shares-milestone-0");
  await expect(first).toContainText("80,000,000 Shares");
  await expect(first).toContainText("alpha shipped");
  const second = page.getByTestId("locked-shares-milestone-1");
  await expect(second).toContainText("120,000,000 Shares");
  await expect(second).toContainText("mainnet live");
  await expect(page.getByTestId("locked-shares-unlock-1")).toHaveCount(0);
  await expect(second).toContainText("Not submitted yet");

  await page.getByTestId("locked-shares-unlock-0").click();
  await expect(page.getByTestId("locked-shares-total")).toContainText(
    "120,000,000 Shares are still locked",
    { timeout: 60_000 },
  );
  await expect(first).toContainText("Unlocked");
  await expect(page.getByTestId("locked-shares-unlock-0")).toHaveCount(0);
  await expect(page.getByTestId("work-failure")).toHaveCount(0);

  // The chain agrees: only the second milestone's part is still held back, and the Shares refuse to move it.
  expect(await lockedOf(FOUNDER_WALLET)).toBe(SECOND_TRANCHE);
  const balance = BigInt(
    String(
      await rpc("eth_call", [
        { to: SHARES, data: `0x70a08231${word(FOUNDER_WALLET)}` },
        "latest",
      ]),
    ),
  );
  expect(balance).toBe(TEAM);

  // Someone with no team Shares has nothing locked, so the card is not shown to them.
  const stranger = await browser.newPage();
  await openWork(stranger, STRANGER);
  await expect(stranger.getByTestId("locked-shares")).toHaveCount(0);
  await stranger.close();

  // The track record is public: someone with no wallet sees the milestone that was reached, the one that was not, and
  // the work behind it with who approved it.
  const reader = await browser.newPage();
  await openRecord(reader);
  await expect(reader.getByTestId("record-promise-summary")).toContainText(
    "1 of 2 milestones reached",
    { timeout: 30_000 },
  );
  // The team member is shown by name, with the address beside it so the name is never the only thing to go on.
  await expect(reader.getByTestId("record-person").first()).toContainText(
    "Fiona Founder (0xf39f…2266)",
  );
  const tranches = reader.getByTestId("record-tranche");
  await expect(tranches).toHaveCount(2);
  await expect(tranches.nth(0)).toContainText("alpha shipped");
  await expect(tranches.nth(0)).toContainText("Reached");
  await expect(tranches.nth(1)).toContainText("mainnet live");
  await expect(tranches.nth(1)).toContainText("Not reached yet");
  const entries = reader.getByTestId("record-entry");
  await expect(entries.filter({ hasText: "filed a claim" })).toHaveCount(1);
  await expect(
    entries.filter({ hasText: "The reviewers approved the claim" }),
  ).toContainText("Approved by");
  await expect(
    entries.filter({ hasText: "reached milestone 1 (alpha shipped)" }),
  ).toHaveCount(1);
  await expect(reader.getByTestId("record-figure-work")).toContainText("1");
  // The milestone panel sets nothing aside and awards nothing: the page says zero of each (the track record's own tests
  // keep "set aside" and "awarded" apart when a project does hold Shares).
  await expect(reader.getByTestId("record-figure-awarded")).toHaveText(
    /awarded for work0\s*0 set aside for projects/,
  );
  if (process.env.E2E_SHOTS) {
    await reader.setViewportSize({ width: 1100, height: 1500 });
    await reader.screenshot({
      path: `${process.env.E2E_SHOTS}/record.png`,
      fullPage: true,
    });
  }
  await reader.close();

  // What the founder holds, and for how long, is on their portfolio: the Shares, how long the holding has lasted, and
  // what is still locked. Someone with no Shares sees none.
  const holder = await browser.newPage();
  await openPortfolio(holder, FOUNDER_WALLET);
  const row = holder.getByTestId("portfolio-holding");
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row).toContainText("Nebula DAO");
  await expect(holder.getByTestId("portfolio-holding-shares")).toContainText(
    "200,000,000",
  );
  await expect(holder.getByTestId("portfolio-holding-age")).toHaveText(
    /(\d+ days|\d+ months|1 day)/,
  );
  await expect(holder.getByTestId("portfolio-holding-locked")).toContainText(
    "120,000,000 of them are locked",
  );
  if (process.env.E2E_SHOTS) {
    await holder.getByTestId("portfolio-holdings").screenshot({
      path: `${process.env.E2E_SHOTS}/holdings.png`,
    });
  }
  await holder.close();

  const nobody = await browser.newPage();
  await openPortfolio(nobody, STRANGER);
  await expect(nobody.getByTestId("portfolio-holdings-empty")).toBeVisible({
    timeout: 30_000,
  });
  await expect(nobody.getByTestId("portfolio-holding")).toHaveCount(0);
  await nobody.close();

  // The second milestone is submitted from its own row: one box for the evidence, one button, and the wallet is asked
  // three times (file it, say which milestone it is for, send it to the panel's reviewers). Words that are not evidence
  // are refused before the wallet is asked.
  await page.getByTestId("milestone-submit-1").click();
  await expect(page.getByTestId("milestone-problem-1")).toBeVisible();

  // A browser that will not keep the draft: nothing is sent, the person is told, and their text stays in the box. (A
  // claim filed whose name and evidence are lost on the next reload cannot be finished or checked.)
  const unsaved = await page.context().newPage();
  await unsaved.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name: string, value: string) {
      if (String(name).startsWith("buzz.launchpad.milestone-submission:")) {
        throw new DOMException("full", "QuotaExceededError");
      }
      return original.call(this, name, value);
    };
  });
  await openWork(unsaved, FOUNDER_WALLET);
  await unsaved
    .getByTestId("milestone-evidence-1")
    .fill("Mainnet is live: https://example.com/mainnet");
  await unsaved.getByTestId("milestone-submit-1").click();
  await expect(unsaved.getByTestId("milestone-problem-1")).toContainText(
    "would not keep a copy",
    { timeout: 30_000 },
  );
  await expect(unsaved.getByTestId("milestone-evidence-1")).toHaveValue(
    "Mainnet is live: https://example.com/mainnet",
  );
  await expect(unsaved.getByTestId("milestone-resume-1")).toHaveCount(0);
  // Nothing was sent: the second milestone is still exactly as locked, and no claim was filed for it.
  expect(await lockedOf(FOUNDER_WALLET)).toBe(SECOND_TRANCHE);
  await expect(unsaved.getByTestId("work-claim")).toHaveCount(1);
  await unsaved.close();

  // The person cancels the second prompt: the claim is filed, the rest is not. (A second page of the same browser: the
  // saved submission is shared, and the wallet that cancels is a one-time thing per page load.)
  const interrupted = await page.context().newPage();
  await openWork(interrupted, FOUNDER_WALLET, { rejectSendAt: 1 });
  await interrupted
    .getByTestId("milestone-evidence-1")
    .fill("Mainnet is live: https://example.com/mainnet");
  await interrupted.getByTestId("milestone-submit-1").click();
  // The page re-reads after each step that landed, so the row may be rebuilt: what survives is the saved submission,
  // and the row says what is left of it.
  await expect(interrupted.getByTestId("milestone-resume-1")).toContainText(
    "Still to do: state which milestone it is for",
    { timeout: 60_000 },
  );
  expect(await lockedOf(FOUNDER_WALLET)).toBe(SECOND_TRANCHE);
  await interrupted.close();

  // A fresh load finds the same submission and offers to finish it, with the text they wrote.
  const resumed = await page.context().newPage();
  await openWork(resumed, FOUNDER_WALLET);
  const resume = resumed.getByTestId("milestone-resume-1");
  await expect(resume).toBeVisible({ timeout: 30_000 });
  await expect(resume).toContainText(
    "Still to do: state which milestone it is for",
  );
  await expect(resume).toContainText("https://example.com/mainnet");
  await expect(resumed.getByTestId("milestone-evidence-1")).toHaveCount(0);
  await resumed.getByTestId("milestone-continue-1").click();
  await expect(resumed.getByTestId("milestone-stage-1")).toContainText(
    "With the reviewers: 0 of 2 approvals",
    { timeout: 90_000 },
  );
  await expect(resumed.getByTestId("milestone-resume-1")).toHaveCount(0);
  await expect(resumed.getByTestId("milestone-submit-1")).toHaveCount(0);
  // It finished the same claim: there is no second one for this milestone on the panel, and the reviewers can read it.
  await expect(resumed.getByTestId("work-claim")).toHaveCount(2);
  await expect(
    resumed
      .getByTestId("work-claim")
      .filter({ hasText: "milestone-2" })
      .getByTestId("work-evidence-text"),
  ).toContainText("https://example.com/mainnet", { timeout: 30_000 });
  // Nothing was put up for a vote, and the Shares are still locked until the reviewers have their say.
  expect(await lockedOf(FOUNDER_WALLET)).toBe(SECOND_TRANCHE);

  // Anyone, with no wallet at all, sees the same story: the first milestone released, the second with the reviewers,
  // the evidence the team submitted, and every reviewer as not having decided yet. It is the backer's view of the
  // agreement, not the team wallet's.
  const watcher = await page.context().newPage();
  await openMilestones(watcher);
  await expect(watcher.getByTestId("milestone-stage-0")).toHaveText(
    "Unlocked",
    { timeout: 30_000 },
  );
  await expect(watcher.getByTestId("milestone-stage-1")).toHaveText(
    "With the reviewers",
  );
  await expect(watcher.getByTestId("milestone-headline-1")).toContainText(
    "0 of 2 approved",
  );
  await watcher.getByTestId("milestone-evidence-toggle-1").click();
  await expect(watcher.getByTestId("milestone-evidence-1")).toContainText(
    "https://example.com/mainnet",
  );
  await expect(watcher.getByTestId("milestone-verdicts-1")).toContainText(
    "has not decided",
  );
  // It says what the lock does not do, so nobody mistakes it for a promise about the treasury.
  await expect(watcher.getByTestId("milestones-limits")).toContainText(
    "Holders can still vote to spend the treasury",
  );
  await expect(watcher.getByTestId("milestones-summary")).toContainText(
    "1 of 2 milestones reached",
  );
});
