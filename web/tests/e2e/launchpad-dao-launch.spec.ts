import { expect, test, type Page } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";
import { installAnvilWallet } from "../helpers/anvil-wallet";
import { wizardToPublish } from "../helpers/wizard";

/**
 * Launch a project into its own DAO from the browser, against a REAL local chain.
 *
 * Opt-in: needs the world `scripts/web-dao-launch-e2e.sh` builds (a dev chain with the Summoner, the CCA factory,
 * Permit2, the dev USDC and the DaoLaunchKit, and a web build that names that kit). Skipped without it:
 *
 *   scripts/web-dao-launch-e2e.sh
 *
 * What is real: the chain, the contracts (forge-built), every transaction, the team's milestone lock, the auction and its
 * graduation. What is stubbed: the relay (an in-memory mock that stores what the page publishes) and the wallet
 * (`window.ethereum` forwarding to Anvil's unlocked accounts).
 */

const ANVIL_URL = process.env.E2E_ANVIL_URL ?? "";
const CURRENCY = process.env.E2E_CURRENCY ?? "";
const KIT = process.env.E2E_LAUNCH_KIT ?? "";
// Anvil's first dev account: the founder, and the wallet that holds (and votes with) the team's Shares.
const FOUNDER_WALLET = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
// Anvil's second dev account: the backer.
const BACKER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const FOUNDER_NSEC = "22".repeat(32);
const FOUNDER = getPublicKey(
  Uint8Array.from(FOUNDER_NSEC.match(/.{2}/g) ?? [], (b) =>
    Number.parseInt(b, 16),
  ),
);
const WAD = 10n ** 18n;
// 600,000,000 sold of 800,000,000: the standard 75% sale and 25% team, none kept by the DAO (D75).
const SALE = 600_000_000n * WAD;
const TEAM = 200_000_000n * WAD;
const DAO_OWN = 0n;

test.skip(
  !ANVIL_URL || !CURRENCY || !KIT,
  "set E2E_ANVIL_URL, E2E_CURRENCY and E2E_LAUNCH_KIT (scripts/web-dao-launch-e2e.sh does)",
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

const word = (value: string | bigint) =>
  (typeof value === "bigint" ? value.toString(16) : value.slice(2))
    .toLowerCase()
    .padStart(64, "0");

async function callWord(
  to: string,
  data: string,
  from?: string,
): Promise<bigint> {
  return BigInt(String(await rpc("eth_call", [{ from, to, data }, "latest"])));
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

async function waitMined(hash: string): Promise<void> {
  for (let i = 0; i < 60; i++) {
    if (await rpc("eth_getTransactionReceipt", [hash])) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`transaction ${hash} was not mined`);
}

/** The terms of a 600M-Share sale in the dev USDC: $0.0005 a Share, so the whole tranche is the $300,000 target (D74). */
const TERMS = {
  floorPrice: "39614081257000",
  tickSpacing: "79228162514",
  requiredRaised: "299999999998",
};

/** Each test launches its own project: a launch id is one DAO, so two tests cannot share one. */
let launches = 0;
function launchRecord(startBlock: number): StoredEvent {
  const id = `nebula-${Date.now().toString(36)}-${++launches}`;
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
        supply: "600000000",
      },
      allocation: {
        sale: 75,
        team: 25,
        treasury: 0,
        liquidity: 0,
        milestones: 0,
        community: 0,
      },
      // The team's Shares are theirs from the first block, but locked behind these two milestones.
      unlocks: {
        mode: "milestones",
        allocationPct: 25,
        milestones: [
          {
            claim: "m1",
            label: "alpha shipped",
            percent: 50,
            verifier: "founder",
          },
          {
            claim: "m2",
            label: "mainnet live",
            percent: 50,
            verifier: "founder",
          },
        ],
        months: null,
      },
    }),
    sig: "sig",
  };
}

/** A tiny relay: serves the record, and serves back whatever the page republishes. */
async function mockRelay(
  page: Page,
  initial: StoredEvent,
  options: { failRecordWrites?: () => boolean } = {},
) {
  let current: StoredEvent = initial;
  const published: StoredEvent[] = [];
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
        const event = parsed[1] as StoredEvent;
        if (event.kind === 37001 && options.failRecordWrites?.()) {
          ws.send(
            JSON.stringify(["OK", event.id, false, "error: server is busy"]),
          );
          return;
        }
        published.push(event);
        if (event.kind === 37001) current = event;
        ws.send(JSON.stringify(["OK", event.id, true, ""]));
        return;
      }
      if (parsed[0] !== "REQ") return;
      const [, subId, filter] = parsed as [
        string,
        string,
        { kinds?: number[] },
      ];
      const kinds = filter.kinds ?? [];
      if (kinds.includes(37001)) {
        ws.send(JSON.stringify(["EVENT", subId, current]));
      }
      if (kinds.includes(47005)) {
        for (const e of published.filter((p) => p.kind === 47005)) {
          ws.send(JSON.stringify(["EVENT", subId, e]));
        }
      }
      ws.send(JSON.stringify(["EOSE", subId]));
    });
  });
  return { published, current: () => current };
}

async function openManage(page: Page) {
  await page.addInitScript(
    ([nsec, rpcUrl]) => {
      window.localStorage.setItem("buzz.identity.nsec", nsec);
      window.localStorage.setItem("buzz.launchpad.rpc", rpcUrl);
    },
    [FOUNDER_NSEC, ANVIL_URL],
  );
  await page.goto("/launchpad");
  await page.getByText("Nebula DAO").click();
  await page.getByRole("tab", { name: /Manage/ }).click();
}

// Anvil's third and fourth dev accounts: outsiders who judge the team's milestones.
const JUDGES = [
  "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  "0x90F79bf6EB2c4f870365E785982E1f101E9b4226",
];

const REVIEWER_TERMS =
  "Each agreed to answer within 7 days. Unpaid, with no stake in the project.";

/**
 * The launch names who judges the team's milestones, says they agreed and how they will work; without them the button
 * stays off.
 */
async function namePanel(page: Page, reviewers: string[] = JUDGES) {
  // Holders judging the milestones is the default; these launches name a panel of reviewers instead.
  await page.getByTestId("launch-review-panel").check();
  await page.getByTestId("launch-panel-reviewers").fill(reviewers.join("\n"));
  await page.getByTestId("launch-panel-terms").fill(REVIEWER_TERMS);
  await page.getByTestId("launch-panel-agreed").check();
}

const tag = (event: StoredEvent, name: string) =>
  event.tags.find(([k]) => k === name)?.[1] ?? "";

test("the founder launches a project into its own DAO with one button, and the page saves it", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const startBlock = (await head()) + 500;
  const relay = await mockRelay(page, launchRecord(startBlock));
  await installAnvilWallet(page, FOUNDER_WALLET, { rpcUrl: ANVIL_URL });
  await openManage(page);

  const panel = page.getByTestId("dao-launch-panel");
  await expect(panel).toBeVisible({ timeout: 15_000 });
  // The old two-step path is not offered for this launch.
  await expect(page.getByTestId("auction-deploy-panel")).toHaveCount(0);
  // Holders judging the milestones is the default and needs nothing from the founder; naming a panel instead means the launch
  // cannot go until it says who judges them.
  await expect(page.getByTestId("launch-review-challenge")).toBeChecked();
  await expect(page.getByTestId("dao-launch-start")).toBeEnabled();
  await page.getByTestId("launch-review-panel").check();
  await expect(page.getByTestId("dao-launch-gate")).toContainText(
    "Name who judges the milestones.",
  );
  await expect(page.getByTestId("dao-launch-start")).toBeDisabled();
  // Naming the reviewers is not enough: the founder says they asked them, and how they will work, before backers read it.
  await page.getByTestId("launch-panel-reviewers").fill(JUDGES.join("\n"));
  await expect(page.getByTestId("launch-panel-problem")).toContainText(
    "asked each reviewer",
  );
  await page.getByTestId("launch-panel-agreed").check();
  await expect(page.getByTestId("launch-panel-problem")).toContainText(
    "how your reviewers will work",
  );
  await expect(page.getByTestId("dao-launch-start")).toBeDisabled();
  // A team member cannot judge the team's milestones: said before anything is sent.
  await namePanel(page, [FOUNDER_WALLET, JUDGES[0]]);
  await expect(page.getByTestId("dao-launch-gate")).toContainText(
    "A team member cannot judge the team's milestones",
  );
  await expect(page.getByTestId("dao-launch-start")).toBeDisabled();
  await namePanel(page);
  await expect(page.getByTestId("dao-launch-gate")).toHaveCount(0);
  // The founder is told what happens if the reviewers cannot be reached, and warned when none could be missing.
  await expect(page.getByTestId("launch-panel-continuity")).toContainText(
    "the locked Shares stay locked",
  );
  await expect(page.getByTestId("launch-panel-no-spare")).toContainText(
    "Every reviewer must agree",
  );
  await namePanel(page, [
    ...JUDGES,
    "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65",
  ]);
  await expect(page.getByTestId("launch-panel-no-spare")).toHaveCount(0);
  await namePanel(page);
  // The founder is told, in plain words, where each part of the supply goes.
  const summary = page.getByTestId("dao-launch-summary");
  await expect(summary).toContainText("200,000,000 Shares");
  await expect(summary).toContainText("0 Shares (they never vote)");
  await expect(summary).toContainText("100% locked until its milestones");

  if (process.env.E2E_SHOTS) {
    await panel.screenshot({ path: `${process.env.E2E_SHOTS}/before.png` });
  }
  await page.getByTestId("dao-launch-start").click();
  await expect(page.getByTestId("dao-launch-status")).toContainText(
    "Your project is live",
    { timeout: 120_000 },
  );
  await expect(page.getByTestId("dao-launch-failure")).toHaveCount(0);
  if (process.env.E2E_SHOTS) {
    await panel.screenshot({ path: `${process.env.E2E_SHOTS}/after.png` });
  }
  for (const step of ["send", "link", "publish"]) {
    await expect(page.getByTestId(`dao-launch-step-${step}`)).toContainText(
      "Done",
    );
  }

  // The record now names the DAO's Shares, the sale and the DAO as treasury, and keeps what the founder said about how the
  // reviewers will work, so backers can read it.
  const record = relay.current();
  expect(JSON.parse(record.content).reviewerTerms).toBe(REVIEWER_TERMS);
  const shares = tag(record, "token");
  const auction = tag(record, "auction");
  const dao = tag(record, "treasury");
  for (const address of [shares, auction, dao]) {
    expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  }

  // A receipt, bound to the transaction, tells everyone where the DAO is, without
  // marking the launch graduated.
  const receipt = relay.published.find(
    (e) => e.kind === 47005 && tag(e, "kind") === "dao-launch",
  );
  expect(receipt).toBeTruthy();
  const payload = JSON.parse(receipt?.content ?? "{}");
  expect(payload.dao).toBe(dao.toLowerCase());
  expect(tag(receipt as StoredEvent, "tx")).toMatch(/^0x[0-9a-f]{64}$/);
  const lock = payload.lock as string;
  expect(lock).toMatch(/^0x[0-9a-f]{40}$/);
  expect(payload.milestones).toHaveLength(2);
  // The receipt says who judges them, and the chain agrees: the DAO's own factory names the launch's panel.
  expect(payload.panel.reviewers).toEqual(JUDGES.map((j) => j.toLowerCase()));
  expect(payload.panel.quorum).toBe(2);
  const addressOf = (value: bigint) =>
    `0x${value.toString(16).padStart(40, "0")}`;
  const policy = await callWord(dao, "0x6f533638"); // votingWeight()
  const factory = await callWord(addressOf(policy), "0xb04b7bdb"); // mandateFactory()
  const panelMandate = await callWord(
    addressOf(factory),
    `0x17362283${word(dao)}`, // milestoneMandate(dao)
  );
  expect(panelMandate).not.toBe(0n);

  // The chain agrees. The sale holds the sale tranche, the founder holds the whole
  // team allocation (and so votes with it), the DAO holds its own part.
  expect(await balanceOf(shares, auction)).toBe(SALE);
  expect(await balanceOf(shares, FOUNDER_WALLET)).toBe(TEAM);
  expect(await balanceOf(shares, dao)).toBe(DAO_OWN);

  // ...but none of it can leave until a milestone is reached: the lock says all of it is held back,
  // and the Shares refuse a transfer.
  const lockedOf = (holder: string) =>
    callWord(lock, `0xa5f1e282${word(holder)}`);
  expect(await lockedOf(FOUNDER_WALLET)).toBe(TEAM);
  await expect(
    callWord(shares, `0xa9059cbb${word(BACKER)}${word(1n)}`, FOUNDER_WALLET),
  ).rejects.toThrow();

  // The DAO is the payee: nothing the founder signs can move the raise.
  const executor = payload.executor as string;
  expect(await callWord(executor, "0x61d027b3")).toBe(BigInt(dao));

  // Launching a second time is not offered, and reloading does not lose the result.
  await page.reload();
  await page.getByText("Nebula DAO").click();
  await page.getByRole("tab", { name: /Manage/ }).click();
  await expect(page.getByTestId("graduation-panel")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTestId("dao-launch-panel")).toHaveCount(0);
});

test("a server that refuses the record after the DAO exists is retried without sending the money step again", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const startBlock = (await head()) + 500;
  let refuse = true;
  const relay = await mockRelay(page, launchRecord(startBlock), {
    failRecordWrites: () => refuse,
  });
  await installAnvilWallet(page, FOUNDER_WALLET, { rpcUrl: ANVIL_URL });
  await openManage(page);

  await namePanel(page);
  await page.getByTestId("dao-launch-start").click();
  const failure = page.getByTestId("dao-launch-failure");
  await expect(failure).toBeVisible({ timeout: 120_000 });
  await expect(failure).toContainText("never sends the money twice");
  // The DAO exists; the page says the step to retry is saving, not launching.
  await expect(page.getByTestId("dao-launch-step-send")).toContainText("Done");
  await expect(page.getByTestId("dao-launch-start")).toHaveCount(0);
  const blockAfterLaunch = await head();

  refuse = false;
  await page.getByTestId("dao-launch-finish").click();
  await expect(page.getByTestId("dao-launch-status")).toContainText(
    "Your project is live",
    { timeout: 60_000 },
  );
  // Nothing was sent to the chain by the retry.
  expect(await head()).toBe(blockAfterLaunch);
  expect(tag(relay.current(), "auction")).toMatch(/^0x[0-9a-fA-F]{40}$/);
});

test("a reload between the DAO and the record offers to finish saving, never a second launch", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const startBlock = (await head()) + 500;
  let refuse = true;
  const relay = await mockRelay(page, launchRecord(startBlock), {
    failRecordWrites: () => refuse,
  });
  await installAnvilWallet(page, FOUNDER_WALLET, { rpcUrl: ANVIL_URL });
  await openManage(page);
  await namePanel(page);
  await page.getByTestId("dao-launch-start").click();
  await expect(page.getByTestId("dao-launch-failure")).toBeVisible({
    timeout: 120_000,
  });
  const blockAfterLaunch = await head();

  // The founder closes the tab and comes back.
  refuse = false;
  await page.reload();
  await page.getByText("Nebula DAO").click();
  await page.getByRole("tab", { name: /Manage/ }).click();
  await expect(page.getByTestId("dao-launch-resume-note")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTestId("dao-launch-start")).toHaveCount(0);
  await page.getByTestId("dao-launch-finish").click();
  await expect(page.getByTestId("dao-launch-status")).toContainText(
    "Your project is live",
    { timeout: 60_000 },
  );
  expect(await head()).toBe(blockAfterLaunch);
  expect(tag(relay.current(), "treasury")).toMatch(/^0x[0-9a-fA-F]{40}$/);
});

test("a browser that forgot the launch finds its DAO on the chain instead of making a second one", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const startBlock = (await head()) + 500;
  let refuse = true;
  const record = launchRecord(startBlock);
  const relay = await mockRelay(page, record, {
    failRecordWrites: () => refuse,
  });
  await installAnvilWallet(page, FOUNDER_WALLET, { rpcUrl: ANVIL_URL });
  await openManage(page);
  await namePanel(page);
  await page.getByTestId("dao-launch-start").click();
  await expect(page.getByTestId("dao-launch-failure")).toBeVisible({
    timeout: 120_000,
  });
  const blockAfterLaunch = await head();

  // Another device: the page has no memory of the transaction.
  refuse = false;
  await page.evaluate(() => {
    for (const key of Object.keys(window.localStorage)) {
      if (key.includes("graduation-tx:dao-launch:")) {
        window.localStorage.removeItem(key);
      }
    }
  });
  await page.reload();
  await page.getByText("Nebula DAO").click();
  await page.getByRole("tab", { name: /Manage/ }).click();
  await expect(page.getByTestId("dao-launch-resume-note")).toHaveCount(0);
  await namePanel(page);
  await page.getByTestId("dao-launch-start").click();
  await expect(page.getByTestId("dao-launch-status")).toContainText(
    "Your project is live",
    { timeout: 60_000 },
  );
  // The wallet was never asked: the same DAO was found and saved.
  expect(await head()).toBe(blockAfterLaunch);
  const saved = relay.current();
  const dao = tag(saved, "treasury");
  expect(dao).toMatch(/^0x[0-9a-fA-F]{40}$/);
  const receipt = relay.published.find(
    (e) => e.kind === 47005 && tag(e, "kind") === "dao-launch",
  );
  expect(JSON.parse(receipt?.content ?? "{}").dao).toBe(dao.toLowerCase());
});

test("a new launch defaults to the project's own Shares on a network that has a launch kit", async ({
  page,
}) => {
  await mockRelay(page, launchRecord((await head()) + 500));
  await page.addInitScript(
    ([nsec, rpcUrl]) => {
      window.localStorage.setItem("buzz.identity.nsec", nsec);
      window.localStorage.setItem("buzz.launchpad.rpc", rpcUrl);
    },
    [FOUNDER_NSEC, ANVIL_URL],
  );
  await page.goto("/launchpad");
  await page.getByRole("button", { name: "Set up a sale" }).first().click();
  await page.getByTestId("launch-advanced").locator("> summary").click();
  await expect(page.getByTestId("token-mode-dao")).toBeVisible({
    timeout: 15_000,
  });
  await expect(
    page.getByRole("button", { name: "Project Shares" }),
  ).toHaveAttribute("aria-pressed", "true");
  // This build names a kit for this network, so there is nothing to warn about.
  await expect(page.getByTestId("dao-kit-missing")).toHaveCount(0);
  // The older paths are one click away.
  await page.getByRole("button", { name: "Mint new" }).click();
  await expect(page.getByTestId("token-mode-dao")).toHaveCount(0);
});

test("a launch made in the wizard, as published, launches into its DAO", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const relay = await mockRelay(page, launchRecord((await head()) + 500));
  await installAnvilWallet(page, FOUNDER_WALLET, { rpcUrl: ANVIL_URL });
  await page.addInitScript(
    ([nsec, rpcUrl]) => {
      window.localStorage.setItem("buzz.identity.nsec", nsec);
      window.localStorage.setItem("buzz.launchpad.rpc", rpcUrl);
    },
    [FOUNDER_NSEC, ANVIL_URL],
  );
  await page.goto("/launchpad");
  await page.getByRole("button", { name: "Set up a sale" }).first().click();
  await wizardToPublish(page);
  await page.getByRole("button", { name: /Publish launch/ }).click();

  // The record the wizard published says the project sells its own Shares.
  await expect
    .poll(() => JSON.parse(relay.current().content).tokenPlan?.mode, {
      timeout: 30_000,
    })
    .toBe("dao");
  const published = relay.current();
  expect(tag(published, "token")).toBe("");

  await page.goto(
    `/launchpad/${tag(published, "d")}?author=${published.pubkey}`,
  );
  await page.getByRole("tab", { name: /Manage/ }).click();
  await expect(page.getByTestId("dao-launch-panel")).toBeVisible({
    timeout: 15_000,
  });
  await namePanel(page);
  await expect(page.getByTestId("dao-launch-gate")).toHaveCount(0);
  await page.getByTestId("dao-launch-start").click();
  await expect(page.getByTestId("dao-launch-status")).toContainText(
    "Your project is live",
    { timeout: 120_000 },
  );
  const launched = relay.current();
  const dao = tag(launched, "treasury");
  expect(dao).toMatch(/^0x[0-9a-fA-F]{40}$/);
  // The wizard's allocation (the standard 75% sale, 25% team, none kept by the DAO, D75) came out as Shares.
  const shares = tag(launched, "token");
  const total = await callWord(shares, "0x18160ddd");
  expect(await balanceOf(shares, tag(launched, "auction"))).toBe((total * 3n) / 4n);
  expect(await balanceOf(shares, dao)).toBe(0n);
  // The team's 25% is in the founder's wallet from the first block (it votes), held back by the milestone lock.
  expect(await balanceOf(shares, FOUNDER_WALLET)).toBe(total / 4n);
});

test("with no wallet in the browser the launch is off, and nothing is sent", async ({
  page,
}) => {
  const startBlock = (await head()) + 500;
  await mockRelay(page, launchRecord(startBlock));
  await page.addInitScript(
    ([nsec, rpcUrl]) => {
      window.localStorage.setItem("buzz.identity.nsec", nsec);
      window.localStorage.setItem("buzz.launchpad.rpc", rpcUrl);
    },
    [FOUNDER_NSEC, ANVIL_URL],
  );
  const before = await head();
  await page.goto("/launchpad");
  await page.getByText("Nebula DAO").click();
  await page.getByRole("tab", { name: /Manage/ }).click();
  await expect(page.getByTestId("dao-launch-panel")).toBeVisible({
    timeout: 15_000,
  });
  // No wallet in this browser: the button is off and the page says why.
  await expect(page.getByTestId("dao-launch-start")).toBeDisabled();
  expect(await head()).toBe(before);
});

test("backers bid, the sale ends, and graduation pays the whole raise to the DAO", async ({
  page,
  context,
}) => {
  test.setTimeout(300_000);
  // The backer holds 1,000,000 of the sale currency (the dev chain funded them).
  expect(await balanceOf(CURRENCY, BACKER)).toBeGreaterThan(
    400_000n * 10n ** 6n,
  );
  const startBlock = (await head()) + 500;
  const endBlock = startBlock + 200;
  const relay = await mockRelay(page, launchRecord(startBlock));
  await installAnvilWallet(page, FOUNDER_WALLET, { rpcUrl: ANVIL_URL });
  await openManage(page);

  await namePanel(page);
  await page.getByTestId("dao-launch-start").click();
  await expect(page.getByTestId("dao-launch-status")).toContainText(
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
  const executor = JSON.parse(receipt?.content ?? "{}").executor as string;

  // ── A backer bids through the real bid dialog ──────────────────────────────
  await mineTo(startBlock + 2);
  const backerPage = await context.newPage();
  const backerRelay = await mockRelay(backerPage, launched);
  await installAnvilWallet(backerPage, BACKER, { rpcUrl: ANVIL_URL });
  await backerPage.addInitScript(
    ([rpcUrl]) => window.localStorage.setItem("buzz.launchpad.rpc", rpcUrl),
    [ANVIL_URL],
  );
  await backerPage.goto("/launchpad");
  await backerPage.getByText("Nebula DAO").click();
  await backerPage.getByRole("button", { name: "Place bid" }).click();
  await backerPage.getByTestId("bid-budget").fill("400000");
  await expect(backerPage.getByTestId("bid-issues")).toHaveCount(0);
  await backerPage.getByTestId("bid-send").click();
  await expect
    .poll(() => backerRelay.published.find((e) => e.kind === 47002), {
      timeout: 60_000,
    })
    .toBeTruthy();
  const bidTx = String(
    JSON.parse(
      backerRelay.published.find((e) => e.kind === 47002)?.content ?? "{}",
    ).tx,
  );
  await waitMined(bidTx);

  // ── The sale ends; anyone executes the graduation ─────────────────────────
  await mineTo(endBlock + 2);
  const daoMoneyBefore = await balanceOf(CURRENCY, dao);
  await page.getByRole("button", { name: "Re-check" }).click();
  await expect(page.getByTestId("graduation-readiness")).toContainText(
    "ended and raised enough",
    { timeout: 30_000 },
  );
  await page.getByTestId("graduation-execute").click();
  await expect(page.getByTestId("graduation-status")).toContainText(
    "Graduation executed",
    { timeout: 90_000 },
  );
  await expect(page.getByTestId("graduation-failure")).toHaveCount(0);

  // ── The chain: the whole raise is the DAO's; the founder's wallet got nothing ─
  const g = String(
    await rpc("eth_call", [
      { to: executor, data: `0x62e3857f${word(auction)}` },
      "latest",
    ]),
  );
  const words = g.slice(2).match(/.{64}/g) ?? [];
  const w = (i: number) => BigInt(`0x${words[i] ?? "0"}`);
  const raised = w(2);
  expect(raised).toBeGreaterThanOrEqual(300_000n * 10n ** 6n);
  expect(w(3)).toBe(0n); // no reserve is held back
  expect(w(4)).toBe(raised); // the treasury share is everything
  expect(w(7)).toBe(1n); // executed
  expect((await balanceOf(CURRENCY, dao)) - daoMoneyBefore).toBe(raised);
  expect(await balanceOf(CURRENCY, executor)).toBe(0n);
  // Unsold Shares went to the DAO too, never to a wallet: the founder still holds only the team allocation.
  expect(await balanceOf(shares, executor)).toBe(0n);
  expect(await balanceOf(shares, FOUNDER_WALLET)).toBe(TEAM);
  await backerPage.close();
});
