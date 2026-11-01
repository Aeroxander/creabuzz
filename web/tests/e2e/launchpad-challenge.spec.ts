import { expect, test, type Page } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";
import { expectAccessible } from "../helpers/a11y";
import { installAnvilWallet } from "../helpers/anvil-wallet";
import { PREVIEW_ORIGIN } from "./mock-relay";

/**
 * Milestones that unlock unless holders object, on a REAL local chain, in real browsers.
 *
 * Opt-in: needs the world `scripts/web-challenge-e2e.sh` builds (a dev chain with the Summoner, the CCA factory, Permit2, the dev
 * USDC and the DaoLaunchKit, and a web build that names that kit). Skipped without it:
 *
 *   scripts/web-challenge-e2e.sh
 *
 * The story: the founder launches a project whose milestones go to the holders (no panel); two backers buy in and claim their
 * Shares; the founder publishes the first milestone; a backer objects and the backers hold it up, so it is turned down and the
 * founder's bond is forfeited; the founder publishes again, nobody objects, and it unlocks for the team; a backer objects once
 * more inside the month, the backers uphold it, and what is still locked is burned. Every step is a button on the page and a
 * transaction on the chain, and each is checked against the chain.
 */

const ANVIL_URL = process.env.E2E_ANVIL_URL ?? "";
const CURRENCY = process.env.E2E_CURRENCY ?? "";
const KIT = process.env.E2E_LAUNCH_KIT ?? "";
// Anvil's dev accounts: the founder (the team), two backers.
const FOUNDER_WALLET = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const BACKER_ONE = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const BACKER_TWO = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const FOUNDER_NSEC = "22".repeat(32);
const FOUNDER = getPublicKey(
  Uint8Array.from(FOUNDER_NSEC.match(/.{2}/g) ?? [], (b) =>
    Number.parseInt(b, 16),
  ),
);
const WAD = 10n ** 18n;
const DAY = 86_400;
// 30,000,000 sold of 40,000,000: 75% sale, 25% team, none kept by the DAO (the standard split, D75). The whole tranche at
// a cent is the raise target: it sells out or refunds (D74).
const TEAM = 10_000_000n * WAD;
// The bond is 1% of the raise target, and an objector's deposit a tenth of that (both rounded down, as the plan does).
const BOND = (299_999_999_998n * 100n) / 10_000n;
const DEPOSIT = (BOND * 1_000n) / 10_000n;

const WORDS_ONE =
  "A public beta is live at a web address anyone can open, with its source published";
const WORDS_TWO =
  "Version 1.0 is released at the same address, with its documentation published";
const EVIDENCE_ONE =
  "The beta is live at https://beta.example.org and the source is at https://example.org/src.";

test.skip(
  !ANVIL_URL || !CURRENCY || !KIT,
  "set E2E_ANVIL_URL, E2E_CURRENCY and E2E_LAUNCH_KIT (scripts/web-challenge-e2e.sh does)",
);

interface StoredEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

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

// Any nonzero evidence hash: the lock refuses before it ever looks at it.
const EVIDENCE_HASH_FOR_CHECK = "ab".repeat(32);
const word = (value: string | bigint) =>
  (typeof value === "bigint" ? value.toString(16) : value.slice(2))
    .toLowerCase()
    .padStart(64, "0");

async function callWord(to: string, data: string): Promise<bigint> {
  return BigInt(String(await rpc("eth_call", [{ to, data }, "latest"])));
}

const balanceOf = (token: string, holder: string) =>
  callWord(token, `0x70a08231${word(holder)}`);

async function head(): Promise<number> {
  return Number.parseInt(String(await rpc("eth_blockNumber")), 16);
}

async function mineTo(block: number): Promise<void> {
  const missing = block - (await head());
  if (missing > 0) await rpc("anvil_mine", [`0x${missing.toString(16)}`]);
}

/** Let `seconds` pass on the chain's own clock (what the contracts' windows read). */
async function passTime(seconds: number): Promise<void> {
  await rpc("evm_increaseTime", [seconds]);
  await rpc("anvil_mine", ["0x1"]);
}

async function waitMined(hash: string): Promise<void> {
  for (let i = 0; i < 60; i++) {
    if (await rpc("eth_getTransactionReceipt", [hash])) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`transaction ${hash} was not mined`);
}

/** The terms of a 200M-Share sale in the dev USDC: $0.01 a Share, a $300,000 threshold. */
const TERMS = {
  floorPrice: "792281625140000",
  tickSpacing: "79228162514",
  requiredRaised: "299999999998",
};

function launchRecord(startBlock: number): StoredEvent {
  const id = `challenge-${Date.now().toString(36)}`;
  return {
    id: "record-1",
    pubkey: FOUNDER,
    created_at: 100,
    kind: 37001,
    tags: [
      ["d", id],
      ["name", "Nebula DAO"],
      ["t", "dao-launchpad"],
      ["admission", "community"],
      ["chain", "31337"],
    ],
    content: JSON.stringify({
      pitch: "To the stars.",
      stage: "live",
      currency: CURRENCY,
      ...TERMS,
      budget: "50000000000",
      startBlock,
      endBlock: startBlock + 200,
      claimBlock: startBlock + 260,
      tokenPlan: {
        mode: "dao",
        name: "Nebula",
        symbol: "NEB",
        supply: "30000000",
      },
      allocation: {
        sale: 75,
        team: 25,
        treasury: 0,
        liquidity: 0,
        milestones: 0,
        community: 0,
      },
      // The team's Shares are theirs from the first block, but all locked behind these two milestones; as the wizard now
      // records a launch into its own DAO, the plan governs the team's share.
      unlocks: {
        mode: "milestones",
        allocationPct: 25,
        milestones: [
          { claim: "m1", label: WORDS_ONE, percent: 50, verifier: "founder" },
          { claim: "m2", label: WORDS_TWO, percent: 50, verifier: "founder" },
        ],
        months: null,
      },
    }),
    sig: "sig",
  };
}

/** A tiny relay: serves the record and the updates the pages publish (shared by every page of the test). */
interface RelayFilter {
  kinds?: number[];
  limit?: number;
  "#a"?: string[];
}

function makeRelay(initial: StoredEvent) {
  let current: StoredEvent = initial;
  const published: StoredEvent[] = [];
  // Reads the relay refuses, as a busy server does: nothing is lost, the answer just does not come.
  let failing: ((filter: RelayFilter) => boolean) | null = null;
  // Kinds the relay answers with nothing, as if they were older than what a list read reaches.
  let hidden: number[] = [];
  const install = async (page: Page) => {
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
          const event = parsed[1] as StoredEvent;
          published.push(event);
          if (event.kind === 37001) current = event;
          ws.send(JSON.stringify(["OK", event.id, true, ""]));
          return;
        }
        if (parsed[0] !== "REQ") return;
        const [, subId, filter] = parsed as [string, string, RelayFilter];
        const kinds = filter.kinds ?? [];
        if (failing?.(filter)) {
          ws.send(JSON.stringify(["CLOSED", subId, "error: server is busy"]));
          return;
        }
        if (kinds.includes(37001)) {
          ws.send(JSON.stringify(["EVENT", subId, current]));
        }
        for (const kind of [47005, 47003, 47002]) {
          if (!kinds.includes(kind) || hidden.includes(kind)) continue;
          for (const e of published.filter((p) => p.kind === kind)) {
            ws.send(JSON.stringify(["EVENT", subId, e]));
          }
        }
        ws.send(JSON.stringify(["EOSE", subId]));
      });
    });
  };
  return {
    published,
    current: () => current,
    install,
    failReads: (match: ((filter: RelayFilter) => boolean) | null) => {
      failing = match;
    },
    hideKinds: (kinds: number[]) => {
      hidden = kinds;
    },
  };
}

/** With `E2E_SHOTS=<dir>`, save the page as it looks now, so a person can read the screens off real data. */
async function shot(page: Page, name: string) {
  const dir = process.env.E2E_SHOTS;
  if (!dir) return;
  await page.waitForTimeout(500);
  await page.screenshot({
    path: `${dir}/challenge-${name}.png`,
    fullPage: true,
  });
}

const tag = (event: StoredEvent, name: string) =>
  event.tags.find(([k]) => k === name)?.[1] ?? "";

async function personPage(
  context: import("@playwright/test").BrowserContext,
  relay: ReturnType<typeof makeRelay>,
  wallet: string,
  nsec: string,
): Promise<Page> {
  const page = await context.newPage();
  await relay.install(page);
  await installAnvilWallet(page, wallet, { rpcUrl: ANVIL_URL });
  await page.addInitScript(
    ([key, rpcUrl]) => {
      window.localStorage.setItem("buzz.identity.nsec", key);
      window.localStorage.setItem("buzz.launchpad.rpc", rpcUrl);
    },
    [nsec, ANVIL_URL],
  );
  return page;
}

test("a milestone is turned down by the holders, tried again, unlocks when nobody objects, and a late objection burns what is left", async ({
  browser,
}) => {
  test.setTimeout(600_000);
  const context = await browser.newContext();
  const startBlock = (await head()) + 500;
  const relay = makeRelay(launchRecord(startBlock));
  const say = (what: string) => console.log(`[challenge] ${what}`);

  // ── The founder launches, with the holders' objections instead of a panel ────────────────────────────
  const founder = await personPage(
    context,
    relay,
    FOUNDER_WALLET,
    FOUNDER_NSEC,
  );
  await founder.goto("/launchpad");
  await founder.getByText("Nebula DAO").click();
  await founder.getByRole("tab", { name: /Manage/ }).click();
  await expect(founder.getByTestId("dao-launch-panel")).toBeVisible({
    timeout: 15_000,
  });
  // Holders judging the milestones is the default, and asks nothing of the founder but a bond.
  await expect(founder.getByTestId("launch-review-challenge")).toBeChecked();
  await expect(founder.getByTestId("dao-launch-start")).toBeEnabled();
  await shot(founder, "0a-launch-form-default");
  // Choosing named reviewers instead asks for people the founder has not named; going back brings the default back.
  await founder.getByTestId("launch-review-panel").check();
  await expect(founder.getByTestId("dao-launch-start")).toBeDisabled();
  await shot(founder, "0b-launch-form-panel");
  await founder.getByTestId("launch-review-challenge").check();
  await expect(founder.getByTestId("launch-challenge-fields")).toContainText(
    "your team's own Shares do not count",
  );
  await expect(founder.getByTestId("launch-challenge-fields")).toContainText(
    "7 days",
  );
  await expect(founder.getByTestId("dao-launch-gate")).toHaveCount(0);
  await founder.getByTestId("dao-launch-start").click();
  await expect(founder.getByTestId("dao-launch-status")).toContainText(
    "Your project is live",
    { timeout: 120_000 },
  );
  const launched = relay.current();
  const shares = tag(launched, "token");
  const auction = tag(launched, "auction");
  const dao = tag(launched, "treasury");
  const receipt = relay.published.find(
    (e) => e.kind === 47005 && tag(e, "kind") === "dao-launch",
  );
  const payload = JSON.parse(receipt?.content ?? "{}");
  const lock = payload.lock as string;
  expect(lock).toMatch(/^0x[0-9a-f]{40}$/);
  // The receipt says how the milestones are let through, and the chain agrees: a challenge lock, and no panel.
  expect(payload.panel).toBeUndefined();
  expect(payload.challenge.window).toBe(7 * DAY);
  expect(payload.challenge.bond).toBe(BOND.toString());
  expect(payload.challenge.deposit).toBe(DEPOSIT.toString());
  expect(await callWord(lock, "0x0681ca55")).toBe(2n); // milestoneCount()
  const lockedOf = (holder: string) =>
    callWord(lock, `0xa5f1e282${word(holder)}`);
  expect(await lockedOf(FOUNDER_WALLET)).toBe(TEAM);
  say("the founder launched a project whose milestones go to the holders");
  // Before the buyers can claim, the team is told publishing is not open yet and is offered nothing to send.
  await founder.getByRole("tab", { name: /Milestones/ }).click();
  await expect(founder.getByTestId("challenge-publish-note-0")).toContainText(
    "opens when the buyers can claim",
    { timeout: 30_000 },
  );
  await expect(founder.getByTestId("challenge-publish-0")).toHaveCount(0);

  // ── Two backers buy in, the sale ends and graduates, and they collect their Shares ──────────────────
  await mineTo(startBlock + 2);
  const backerOne = await personPage(
    context,
    relay,
    BACKER_ONE,
    "33".repeat(32),
  );
  const backerTwo = await personPage(
    context,
    relay,
    BACKER_TWO,
    "44".repeat(32),
  );
  for (const [page, budget] of [
    [backerOne, "180000"],
    [backerTwo, "120000"],
  ] as const) {
    await page.goto("/launchpad");
    await page.getByText("Nebula DAO").click();
    await page.getByRole("button", { name: "Place bid" }).click();
    await page.getByTestId("bid-budget").fill(budget);
    await expect(page.getByTestId("bid-issues")).toHaveCount(0);
    const before = relay.published.filter((e) => e.kind === 47002).length;
    await page.getByTestId("bid-send").click();
    await expect
      .poll(() => relay.published.filter((e) => e.kind === 47002).length, {
        timeout: 60_000,
      })
      .toBeGreaterThan(before);
    const bidTx = String(
      JSON.parse(
        relay.published.filter((e) => e.kind === 47002).at(-1)?.content ?? "{}",
      ).tx,
    );
    await waitMined(bidTx);
  }
  say("two backers bid");
  await mineTo(startBlock + 200 + 2);
  await founder.getByRole("tab", { name: /Manage/ }).click();
  await founder.getByRole("button", { name: "Re-check" }).click();
  await expect(founder.getByTestId("graduation-readiness")).toContainText(
    "ended and raised enough",
    { timeout: 30_000 },
  );
  await founder.getByTestId("graduation-execute").click();
  await expect(founder.getByTestId("graduation-status")).toContainText(
    "Graduation executed",
    { timeout: 90_000 },
  );
  await mineTo(startBlock + 260 + 2);
  for (const page of [backerOne, backerTwo]) {
    await page.goto("/launchpad");
    await page.getByText("Nebula DAO").click();
    await page.getByRole("tab", { name: /My bids/ }).click();
    const settle = async (button: string) => {
      await page.getByTestId(button).waitFor({ timeout: 60_000 });
      await page.getByTestId(button).click();
      await page.getByTestId("mybids-run").click();
      await expect(page.getByTestId("mybids-done")).toBeVisible({
        timeout: 90_000,
      });
      await page.getByTestId("mybids-done").click();
    };
    await settle("mybids-exit");
    await settle("mybids-claim");
  }
  const oneShares = await balanceOf(shares, BACKER_ONE);
  const twoShares = await balanceOf(shares, BACKER_TWO);
  expect(oneShares).toBeGreaterThan(0n);
  expect(twoShares).toBeGreaterThan(0n);
  say("both backers hold Shares");
  // The holders can leave with their share of the treasury, and the team cannot with its locked Shares: the lock still holds.
  expect(await lockedOf(FOUNDER_WALLET)).toBe(TEAM);

  // ── Everyone sees the same Milestones tab, in plain words ───────────────────────────────────────────
  const openMilestones = async (page: Page) => {
    await page.goto("/launchpad");
    await page.getByText("Nebula DAO").click();
    await page.getByRole("tab", { name: /Milestones/ }).click();
    await expect(page.getByTestId("challenge-milestones")).toBeVisible({
      timeout: 30_000,
    });
  };
  await openMilestones(founder);
  await expect(founder.getByTestId("challenge-rules")).toContainText(
    "any holder can object",
  );
  await expect(founder.getByTestId("challenge-summary")).toContainText(
    "0 of 2 milestones unlocked. 10,000,000 Shares still locked.",
  );
  await expect(founder.getByTestId("challenge-stage-0")).toHaveText(
    "Not published",
  );
  await expect(founder.getByTestId("challenge-milestone-0")).toContainText(
    WORDS_ONE,
  );

  // ── A node that does not answer says nothing about which rule this is ──────────────────────────────
  const flaky = await personPage(context, relay, BACKER_TWO, "44".repeat(32));
  const down = new RegExp(ANVIL_URL.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"));
  await flaky.route(down, (route) =>
    route.fulfill({ status: 503, body: "unavailable" }),
  );
  await flaky.goto("/launchpad");
  await flaky.getByText("Nebula DAO").click();
  // The agreement names no reviewers it cannot know, and the Milestones tab shows no rule's milestones in place of the real ones.
  await expect(flaky.getByTestId("launch-powers-rule")).toContainText(
    "could not be read just now",
    { timeout: 60_000 },
  );
  await expect(flaky.getByTestId("launch-powers-panel")).toHaveCount(0);
  await flaky.getByRole("tab", { name: /Milestones/ }).click();
  await expect(flaky.getByTestId("milestones-rule-unreadable")).toBeVisible({
    timeout: 60_000,
  });
  await expect(flaky.getByTestId("challenge-milestones")).toHaveCount(0);
  await expect(flaky.getByTestId("milestones-reviewer-terms")).toHaveCount(0);
  await flaky.unroute(down);
  await flaky.getByTestId("milestones-rule-retry").click();
  await expect(flaky.getByTestId("challenge-milestones")).toBeVisible({
    timeout: 60_000,
  });
  await flaky.close();
  say("an unreadable lock was shown as unknown, not as a panel");

  await shot(founder, "1-publish-form-team");
  // ── The founder publishes milestone one: the evidence first, then the bond, then the milestone ──────
  const founderUsdcBefore = await balanceOf(CURRENCY, FOUNDER_WALLET);
  await founder.getByTestId("challenge-text-0").fill(EVIDENCE_ONE);
  await founder.getByTestId("challenge-publish-button-0").click();
  await expect(founder.getByTestId("challenge-stage-0")).toHaveText(
    "Open to objections",
    { timeout: 90_000 },
  );
  expect(await balanceOf(CURRENCY, lock)).toBe(BOND);
  expect(founderUsdcBefore - (await balanceOf(CURRENCY, FOUNDER_WALLET))).toBe(
    BOND,
  );
  await expect(
    founder.getByTestId("challenge-evidence-toggle-0"),
  ).toBeVisible();
  // Milestones go in order: the next one is not offered until this one has unlocked.
  await expect(founder.getByTestId("challenge-publish-note-1")).toContainText(
    "Milestones go in order",
  );
  await expect(founder.getByTestId("challenge-publish-1")).toHaveCount(0);
  say("the founder published milestone one and posted a bond");

  // Home tells a holder there is something to read, and the line opens the milestone.
  await backerOne.goto("/");
  await expect(backerOne.getByTestId("home-waiting")).toContainText(
    "Read the evidence",
    { timeout: 60_000 },
  );
  // The line says when the window closes, why it is shown to this person and what happens if they do nothing.
  const why = backerOne.getByTestId("home-waiting-why").first();
  await expect(why).toContainText("Closes");
  await expect(why).toContainText("You hold Shares in this project.");
  await expect(why).toContainText("If nobody objects, the milestone unlocks");
  await backerOne.getByTestId("home-waiting-open").first().click();
  await expect(backerOne.getByTestId("challenge-milestones")).toBeVisible({
    timeout: 30_000,
  });

  // The agreement says the rule this project really has, not a panel's.
  await backerOne.goto("/launchpad");
  await backerOne.getByText("Nebula DAO").click();
  await expect(backerOne.getByTestId("launch-powers-challenge")).toContainText(
    "a milestone nobody objects to unlocks",
    { timeout: 30_000 },
  );
  await expect(backerOne.getByTestId("launch-powers-panel")).toHaveCount(0);
  await expect(backerOne.getByTestId("launch-milestone-rule")).toContainText(
    "holders can object",
    { timeout: 30_000 },
  );

  // A relay that does not answer is not the team failing to publish: the screen says it could not look, and trying again finds it.
  // (Only the read that looks for one launch's evidence fails, and the launch list does not reach the update: it is older than
  // what the list reads, which is the case the dedicated read exists for. The list of launches itself must still load.)
  relay.hideKinds([47003]);
  relay.failReads(
    (filter) =>
      (filter.kinds ?? []).includes(47003) &&
      filter.limit === 500 &&
      filter["#a"]?.length === 1,
  );
  await openMilestones(backerOne);
  await expect(
    backerOne.getByTestId("challenge-evidence-unreadable-0"),
  ).toBeVisible({ timeout: 60_000 });
  await expect(
    backerOne.getByTestId("challenge-evidence-missing-0"),
  ).toHaveCount(0);
  relay.failReads(null);
  relay.hideKinds([]);
  await backerOne
    .getByTestId("challenge-evidence-unreadable-0")
    .getByRole("button", { name: "Try again" })
    .click();
  await expect(
    backerOne.getByTestId("challenge-evidence-toggle-0"),
  ).toBeVisible({ timeout: 60_000 });
  say("a failed read of the evidence said so, and trying again found it");

  // A holder sees it, can read the evidence, and is offered an objection; the founder is not.
  await openMilestones(backerOne);
  await backerOne.getByTestId("challenge-evidence-toggle-0").click();
  await shot(backerOne, "2-waiting-holder");
  await expect(backerOne.getByTestId("challenge-evidence-0")).toContainText(
    "https://beta.example.org",
  );
  await expect(backerOne.getByTestId("challenge-object-0")).toBeVisible();
  await expect(founder.getByTestId("challenge-object-0")).toHaveCount(0);

  // Backer two is already looking at the milestone, and does not touch the page again until the vote has opened.
  await openMilestones(backerTwo);
  await expect(backerTwo.getByTestId("challenge-stage-0")).toHaveText(
    "Open to objections",
  );
  await expect(backerTwo.getByTestId("challenge-freshness")).toContainText(
    "updates on its own",
  );

  // ── Backer one objects; backer two votes with them; the founder cannot vote ──────────────────────────
  const oneUsdcBefore = await balanceOf(CURRENCY, BACKER_ONE);
  await backerOne.getByTestId("challenge-object-0").click();
  await expect(
    backerOne.getByTestId("challenge-object-confirm-0"),
  ).toContainText("turned down");
  await backerOne.getByTestId("challenge-object-send-0").click();
  await expect(backerOne.getByTestId("challenge-stage-0")).toHaveText(
    "Holders are voting",
    { timeout: 90_000 },
  );
  expect(oneUsdcBefore - (await balanceOf(CURRENCY, BACKER_ONE))).toBe(DEPOSIT);
  await expect(backerOne.getByTestId("challenge-tally-0")).toContainText(
    "against",
  );
  say("backer one objected");
  // The page backer two left open follows on its own: the vote appears without a reload.
  await expect(backerTwo.getByTestId("challenge-stage-0")).toHaveText(
    "Holders are voting",
    { timeout: 60_000 },
  );
  await expect(backerTwo.getByTestId("challenge-vote-0")).toBeVisible({
    timeout: 60_000,
  });
  await shot(backerTwo, "3-voting-holder");
  await backerTwo.setViewportSize({ width: 390, height: 844 });
  await shot(backerTwo, "3b-voting-holder-phone");
  await backerTwo.setViewportSize({ width: 1280, height: 720 });
  // The richest state of the page, scanned: a vote is open and this holder can cast one.
  await expectAccessible(backerTwo, "Milestones with a vote open");
  await backerTwo.getByTestId("challenge-vote-reject-0").click();
  await expect(backerTwo.getByTestId("challenge-vote-0")).toHaveCount(0, {
    timeout: 60_000,
  });
  await openMilestones(founder);
  await expect(founder.getByTestId("challenge-vote-0")).toHaveCount(0);
  await expect(founder.getByTestId("challenge-object-0")).toHaveCount(0);

  // ── The vote ends, anyone settles it, and the milestone is turned down ──────────────────────────────
  await passTime(21 * DAY + 60); // half the team's tokens: a 21-day window
  await openMilestones(backerOne);
  await expect(backerOne.getByTestId("challenge-stage-0")).toHaveText(
    "Vote ended",
  );
  const oneAfterObjection = await balanceOf(CURRENCY, BACKER_ONE);
  await backerOne.getByTestId("challenge-resolve-0").click();
  await expect(backerOne.getByTestId("challenge-stage-0")).toHaveText(
    "Turned down",
    { timeout: 90_000 },
  );
  // The objector has the deposit back and half the founder's bond; the DAO the other half.
  expect((await balanceOf(CURRENCY, BACKER_ONE)) - oneAfterObjection).toBe(
    DEPOSIT + BOND / 2n,
  );
  expect(await balanceOf(CURRENCY, lock)).toBe(0n);
  expect(await lockedOf(FOUNDER_WALLET)).toBe(TEAM);
  await expect(backerOne.getByTestId("challenge-headline-0")).toContainText(
    "42 days", // twice the 21 days a milestone holding half the team's tokens waits
  );
  say("the holders turned the milestone down");

  // ── The founder tries again with a longer window; nobody objects; anyone finishes it ───────────────
  await openMilestones(founder);
  await expect(founder.getByTestId("challenge-publish-0")).toBeVisible();
  await founder
    .getByTestId("challenge-text-0")
    .fill(`${EVIDENCE_ONE} Second attempt, with the load test results.`);
  await founder.getByTestId("challenge-publish-button-0").click();
  await expect(founder.getByTestId("challenge-stage-0")).toHaveText(
    "Open to objections",
    { timeout: 90_000 },
  );
  // Backer two watches the second attempt on a page that is not touched again.
  await openMilestones(backerTwo);
  await expect(backerTwo.getByTestId("challenge-stage-0")).toHaveText(
    "Open to objections",
  );
  await passTime(42 * DAY + 60); // the retry waits twice as long
  // A project whose lock cannot be read is said so on Home, never shown as "nothing is waiting": here the node refuses the
  // lock's questions, and the page asks again when told to.
  await founder.route(ANVIL_URL, (route) =>
    route.request().postData()?.includes("0x0681ca55")
      ? route.abort()
      : route.continue(),
  );
  await founder.goto("/");
  await expect(founder.getByTestId("home-waiting-unread")).toContainText(
    "Could not read Nebula DAO just now",
    { timeout: 60_000 },
  );
  await expect(founder.getByTestId("home-waiting-item")).toHaveCount(0);
  await founder.unroute(ANVIL_URL);
  await founder.getByTestId("home-waiting-retry").click();
  await expect(founder.getByTestId("home-waiting-unread")).toHaveCount(0, {
    timeout: 60_000,
  });
  // Home tells the team its milestone is ready to finish.
  await expect(founder.getByTestId("home-waiting")).toContainText(
    "Finish it to unlock your Shares",
    { timeout: 60_000 },
  );
  await expect(founder.getByTestId("home-waiting-why").first()).toContainText(
    "Your Shares stay locked until someone finishes it.",
  );
  await shot(founder, "4-founder-home-waiting");
  // The untouched page notices the window has closed, and offers to finish it, without a reload.
  await expect(backerTwo.getByTestId("challenge-stage-0")).toHaveText(
    "Ready to finish",
    { timeout: 60_000 },
  );
  await backerTwo.getByTestId("challenge-finish-0").click();
  await expect(backerTwo.getByTestId("challenge-stage-0")).toHaveText(
    "Unlocked",
    { timeout: 90_000 },
  );
  expect(await lockedOf(FOUNDER_WALLET)).toBe((TEAM * 50n) / 100n);
  await expect(backerTwo.getByTestId("challenge-summary")).toContainText(
    "1 of 2 milestones unlocked. 5,000,000 Shares still locked.",
  );
  // The retry went through unopposed: the objection that sent the first attempt back is not this attempt's.
  await expect(backerTwo.getByTestId("challenge-headline-0")).toContainText(
    "Nobody objected.",
  );
  await shot(backerTwo, "5-unlocked");
  say("the milestone unlocked and the team's first half is free");
  // Shares never move between wallets while transfers are locked (D77), unlocked or not; the unlocked half can leave
  // with its part of the treasury, and not one Share more.
  await expect(
    rpc("eth_call", [
      {
        from: FOUNDER_WALLET,
        to: shares,
        data: `0xa9059cbb${word(BACKER_ONE)}${word(1n)}`,
      },
      "latest",
    ]),
  ).rejects.toThrow();
  const leave = (amount: bigint) =>
    // ragequit(address[] tokens = [the sale currency], uint256 shares, uint256 loot = 0)
    `0x29f64d1a${word(96n)}${word(amount)}${word(0n)}${word(1n)}${word(CURRENCY)}`;
  await expect(
    rpc("eth_call", [
      { from: FOUNDER_WALLET, to: dao, data: leave((TEAM * 50n) / 100n) },
      "latest",
    ]),
  ).resolves.toBeTruthy();
  await expect(
    rpc("eth_call", [
      { from: FOUNDER_WALLET, to: dao, data: leave((TEAM * 50n) / 100n + 1n) },
      "latest",
    ]),
  ).rejects.toThrow();

  // ── The bond waits out the month: not before ────────────────────────────────────────────────────────
  await openMilestones(founder);
  await expect(founder.getByTestId("challenge-release-0")).toHaveCount(0);
  // The next milestone cannot be published while the one before can still be objected to late: what is still locked has
  // to stay locked behind it. The card says until when, offers no button, and the lock itself refuses it.
  await expect(founder.getByTestId("challenge-publish-note-1")).toContainText(
    "Holders can still object to milestone 1 until",
  );
  await expect(founder.getByTestId("challenge-publish-button-1")).toHaveCount(
    0,
  );
  await expect(
    rpc("eth_call", [
      {
        from: FOUNDER_WALLET,
        to: lock,
        data: `0x2ecea788${word(1n)}${EVIDENCE_HASH_FOR_CHECK}`,
      },
      "latest",
    ]),
  ).rejects.toThrow();
  say(
    "the next milestone cannot be published inside the month for a late objection",
  );

  // ── A late objection, upheld: what is still locked is burned, what unlocked stays ───────────────────
  const supplyBefore = await callWord(shares, "0x18160ddd");
  await openMilestones(backerOne);
  await expect(backerOne.getByTestId("challenge-headline-0")).toContainText(
    "one more objection",
  );
  await backerOne.getByTestId("challenge-object-0").click();
  await expect(
    backerOne.getByTestId("challenge-object-confirm-0"),
  ).toContainText("already unlocked");
  await backerOne.getByTestId("challenge-object-send-0").click();
  await expect(backerOne.getByTestId("challenge-stage-0")).toHaveText(
    "Holders are voting",
    { timeout: 90_000 },
  );
  await openMilestones(backerTwo);
  await backerTwo.getByTestId("challenge-vote-reject-0").click();
  await expect(backerTwo.getByTestId("challenge-vote-0")).toHaveCount(0, {
    timeout: 60_000,
  });
  await passTime(5 * DAY + 60);
  await openMilestones(backerOne);
  await backerOne.getByTestId("challenge-resolve-0").click();
  await expect
    .poll(async () => lockedOf(FOUNDER_WALLET), { timeout: 90_000 })
    .toBe(0n);
  // The 5,000,000 still locked were burned; the 5,000,000 that unlocked are still the founder's.
  expect(supplyBefore - (await callWord(shares, "0x18160ddd"))).toBe(
    (TEAM * 50n) / 100n,
  );
  expect(await balanceOf(shares, FOUNDER_WALLET)).toBe((TEAM * 50n) / 100n);
  say(
    "the late objection was upheld and the remaining locked Shares were burned",
  );
  // The milestone says so afterwards, instead of only "Unlocked".
  await openMilestones(backerTwo);
  await expect(backerTwo.getByTestId("challenge-headline-0")).toContainText(
    "holders upheld it: the team's remaining locked Shares were burned",
  );
  await openMilestones(founder);
  await expect(founder.getByTestId("challenge-summary")).toContainText(
    "0 Shares still locked.",
  );
  await context.close();
  void dao;
  void auction;
});
