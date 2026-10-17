import { expect, test, type Browser, type Page } from "@playwright/test";

import { pointChainAt } from "../helpers/anvil-wallet";
import {
  createKeyWalletProvider,
  installKeyWallet,
  type KeyWallet,
  newKeyWallet,
  walletFromKey,
} from "../helpers/key-wallet";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { decrypt as nip49Decrypt } from "nostr-tools/nip49";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure";
import { wizardToPublish } from "../helpers/wizard";
import { PORT, createCommunity, unique } from "./community-helpers";
import { checksumAddress } from "../../src/features/identity/lib/wallet-proof";

/**
 * A small economy run by several people AT ONCE, in browsers of their own, on a REAL server and a REAL chain
 * (`scripts/web-economy-e2e.sh` boots both).
 *
 * Every person starts from nothing: a brand-new Nostr account made in the app, and a brand-new private-key wallet that
 * signs for itself (their own key, funded from a faucet), not a seeded identity or one of Anvil's well-known accounts.
 * Then the story, in the order a project lives it:
 *
 *   - a founder makes a community, and a labor contributor and a capital contributor find it by its address;
 *   - all three link their wallet to their account in their own profile, with both signatures, at once;
 *   - the founder sets up a sale in the wizard and launches it into its own DAO with one button;
 *   - the capital contributor bids through the bid dialog, the sale ends and graduates, the raise goes to the DAO's
 *     treasury, the founder lets the backer into the backers room, and the backer claims the Shares their money bought;
 *   - the DAO, whose people are the founder and the capital contributor, votes a work budget and a project; the panel is
 *     the capital contributor alone (the founder holds locked team Shares, so the contract refuses them as a reviewer),
 *     and the panel asks a bond;
 *   - the labor contributor files a claim for money, the manager takes it on, the reviewer posts the bond and approves it,
 *     and after the challenge window the labor contributor is paid from the treasury, with their deposit back.
 *
 * What is real: the server and its database, every signed request and WebSocket, the chain and its contracts, every
 * transaction. What is not: the passkey (a passkey account needs a Kernel and a bundler on the chain, which a dev chain
 * does not have; `scripts/web-passkey-wallet-e2e.sh` covers it against a stand-in chain) and the clock (the chain's time
 * is moved forward, for everyone at once, where a person would wait).
 */

const ANVIL_URL = process.env.E2E_ANVIL_URL ?? "";
const CURRENCY = process.env.E2E_CURRENCY ?? "";
const KIT = process.env.E2E_LAUNCH_KIT ?? "";

test.skip(
  !ANVIL_URL || !CURRENCY || !KIT,
  "set E2E_ANVIL_URL, E2E_CURRENCY and E2E_LAUNCH_KIT (scripts/web-economy-e2e.sh does)",
);

async function rpc(method: string, params: unknown[] = []): Promise<unknown> {
  const response = await fetch(ANVIL_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await response.json()) as { result?: unknown; error?: unknown };
  if (body.error) throw new Error(JSON.stringify(body.error));
  return body.result;
}

// Anvil's first public dev key pays the faucet: it is the chain's bank, nobody in the story.
const FAUCET = walletFromKey(
  "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);
const faucet = createKeyWalletProvider(FAUCET, { rpcUrl: ANVIL_URL });
const word = (value: string | bigint) =>
  (typeof value === "bigint" ? value.toString(16) : value.slice(2))
    .toLowerCase()
    .padStart(64, "0");

/**
 * How dollars reach a wallet: `mint` on the dev chain, whose currency has an open `mint`; `storage` on a fork of Sepolia,
 * whose currency is Circle's real USDC and has none, so a balance is written straight into its storage (a mapping at
 * slot 9, which `scripts/web-sepolia-fork-e2e.sh` checks by reading the balance back through the contract).
 */
const FUNDING = process.env.E2E_CURRENCY_FUNDING ?? "mint";

/** Pay a new wallet: gas from the chain's faucet, and dollars (see `FUNDING`). */
async function fund(address: string, dollars: bigint) {
  await rpc("anvil_setBalance", [address, "0x56bc75e2d63100000"]); // 100 ETH
  if (dollars > 0n && FUNDING === "storage") {
    const slot = `0x${bytesToHex(keccak_256(hexToBytes(word(address) + word(9n))))}`;
    await rpc("anvil_setStorageAt", [
      CURRENCY,
      slot,
      `0x${word(dollars * 10n ** 6n)}`,
    ]);
  } else if (dollars > 0n) {
    await faucet.request({
      method: "eth_sendTransaction",
      params: [
        {
          from: FAUCET.address,
          to: CURRENCY,
          data: `0x40c10f19${word(address)}${word(dollars * 10n ** 6n)}`,
        },
      ],
    });
  }
}

interface RelayEvent {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

/**
 * Ask the real server for records, as any client could: a WebSocket of the test's own, signed in with a key of its own
 * (the server asks every reader to prove a key), then one REQ.
 */
async function readRecords(
  host: string,
  filter: Record<string, unknown>,
): Promise<RelayEvent[]> {
  const readerKey = generateSecretKey();
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://${host}`);
    const found: RelayEvent[] = [];
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`no answer from ${host}`));
    }, 15_000);
    socket.onmessage = (message) => {
      const frame = JSON.parse(String(message.data)) as unknown[];
      if (frame[0] === "AUTH") {
        const proof = finalizeEvent(
          {
            kind: 22242,
            created_at: Math.floor(Date.now() / 1000),
            tags: [
              ["relay", `ws://${host}`],
              ["challenge", String(frame[1])],
            ],
            content: "",
          },
          readerKey,
        );
        socket.send(JSON.stringify(["AUTH", proof]));
      } else if (frame[0] === "OK") {
        socket.send(JSON.stringify(["REQ", "q", filter]));
      } else if (frame[0] === "EVENT") {
        found.push(frame[2] as RelayEvent);
      } else if (frame[0] === "EOSE" || frame[0] === "CLOSED") {
        clearTimeout(timer);
        socket.close();
        if (frame[0] === "CLOSED")
          reject(new Error(`the server refused the read: ${String(frame[2])}`));
        else resolve(found);
      }
    };
    socket.onerror = () => reject(new Error(`could not reach ${host}`));
  });
}

async function head(): Promise<number> {
  return Number.parseInt(String(await rpc("eth_blockNumber")), 16);
}

async function callWord(to: string, data: string): Promise<bigint> {
  return BigInt(String(await rpc("eth_call", [{ to, data }, "latest"])));
}
const dollarsOf = (holder: string) =>
  callWord(CURRENCY, `0x70a08231${word(holder)}`);

/** One person: a browser of their own, a brand-new wallet and, once they sign up, a brand-new Nostr account. */
interface Person {
  name: string;
  page: Page;
  wallet: KeyWallet;
  /** Their Nostr public key, once they have an account. */
  pubkey: string;
}

async function arrive(
  browser: Browser,
  name: string,
  dollars: bigint,
): Promise<Person> {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  // A step that cannot be taken says so after a minute, naming what it waited for, not after the whole test budget.
  context.setDefaultTimeout(60_000);
  const page = await context.newPage();
  const wallet = newKeyWallet();
  await fund(wallet.address, dollars);
  await installKeyWallet(page, wallet, {
    rpcUrl: ANVIL_URL,
    display: checksumAddress(wallet.address),
  });
  await pointChainAt(page, ANVIL_URL);

  // Sign up in the app, with nothing: no community to write to yet, no invite, no seeded key.
  await page.goto("/c");
  await page.getByTestId("create-identity-cta").first().click();
  await page.getByTestId("onboarding-name").fill(name);
  await page.getByTestId("onboarding-create").click();
  await expect(page.getByTestId("user-chip")).toBeVisible({ timeout: 30_000 });
  // The key is stored encrypted next to the password that wraps it; the test reads whose it is, and nothing else.
  const [sealed, wrap] = await page.evaluate(() => [
    window.localStorage.getItem("buzz.identity.nsec") ?? "",
    window.localStorage.getItem("buzz.identity.wrap") ?? "",
  ]);
  const pubkey = getPublicKey(nip49Decrypt(sealed, wrap));
  expect(pubkey, "the sign-up made a key").toMatch(/^[0-9a-f]{64}$/);
  return { name, page, wallet, pubkey };
}

/** With `E2E_SHOTS=<dir>`, save the page as it looks now, so a person can read the product off real data. */
async function shot(page: Page, name: string) {
  const dir = process.env.E2E_SHOTS;
  if (!dir) return;
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${dir}/economy-${name}.png`, fullPage: true });
}

const started = Date.now();
function say(what: string) {
  console.log(
    `[${String(Math.round((Date.now() - started) / 1000)).padStart(3)}s] ${what}`,
  );
}

async function mineTo(block: number): Promise<void> {
  const missing = block - (await head());
  if (missing > 0) await rpc("anvil_mine", [`0x${missing.toString(16)}`]);
}

const tag = (event: RelayEvent, name: string) =>
  event.tags.find(([key]) => key === name)?.[1] ?? "";

test("a founder, a labor contributor and a capital contributor, at once", async ({
  browser,
}) => {
  test.setTimeout(Number(process.env.E2E_TIMEOUT_MS ?? 600_000));

  // ── Everyone arrives at once: a browser, an account made in the app, a wallet nobody has held before ──
  const [founder, labor, capital] = await Promise.all([
    arrive(browser, "Frida Founder", 1_000_000n),
    arrive(browser, "Lars Labor", 1_000n),
    arrive(browser, "Cleo Capital", 5_000_000n),
  ]);

  say("everyone has arrived");

  // ── The founder makes a community, and the others find it by its address ─────────────────────────
  const name = unique();
  const host = `${name}.localhost:${PORT}`;
  await createCommunity(founder.page, name);
  say("the founder made the community");
  const join = async (person: Person) => {
    await person.page.goto(`/c/${host}`);
    say(`${person.name} is looking at the community`);
    await person.page.getByRole("button", { name: "Join in browser" }).click();
    await expect(person.page.getByTestId("user-chip")).toBeVisible({
      timeout: 30_000,
    });
  };
  await Promise.all([join(labor), join(capital)]);
  say("the others have joined");

  // ── Each person links their wallet to their account, in their own profile, with both signatures ─────
  // (They do it at once, while the founder is still setting up: the people the DAO's forms offer by name are these.)
  const linkWallet = async (person: Person) => {
    await person.page.goto(`/u/${person.pubkey}`);
    await person.page
      .getByRole("button", { name: "Link payment wallet", exact: true })
      .click();
    const dialog = person.page.getByRole("dialog", {
      name: "Link payment wallet",
    });
    await dialog.getByRole("checkbox").check();
    await dialog
      .getByRole("button", { name: "Sign and publish wallet" })
      .click();
    await expect(person.page.getByTestId("payment-wallet-address")).toHaveText(
      new RegExp(person.wallet.address, "i"),
      { timeout: 60_000 },
    );
    say(`${person.name} linked their wallet`);
  };
  const linking = Promise.all([founder, labor, capital].map(linkWallet));
  await linking;
  // The server holds one verified record per person, each authored by the person's own Nostr key.
  const links = await readRecords(host, { kinds: [37017] });
  expect(links.map((record) => record.pubkey).sort()).toEqual(
    [founder, labor, capital].map((person) => person.pubkey).sort(),
  );
  say("all three wallets are linked");

  // ── The founder sets up a sale in the wizard: the project's own Shares, a window a few blocks away ──
  await founder.page.goto("/launchpad");
  await founder.page
    .getByRole("button", { name: "Set up a sale" })
    .first()
    .click();
  const step = founder.page.getByTestId("wizard-step-token");
  await step.getByRole("textbox", { name: "Name", exact: true }).fill("Nebula");
  await step.getByLabel("Symbol").fill("NEB");
  await step.getByLabel(/supply/i).fill("1000000000");
  await wizardToPublish(founder.page);
  await founder.page
    .getByTestId("launch-advanced")
    .locator("> summary")
    .click();
  const start = (await head()) + 150;
  await founder.page.getByTestId("launch-start-block").fill(String(start));
  await founder.page.getByTestId("launch-end-block").fill(String(start + 200));
  await founder.page
    .getByTestId("launch-claim-block")
    .fill(String(start + 260));
  await founder.page.getByRole("button", { name: /Publish launch/ }).click();
  await expect(founder.page.getByText("Launch published.")).toBeVisible({
    timeout: 30_000,
  });

  say("the launch is published");
  // The server holds the record, and it is a DAO launch on the open sale: pressing through the wizard did not trap it.
  const [record] = await readRecords(host, { kinds: [37001] });
  expect(JSON.parse(record.content).tokenPlan.mode).toBe("dao");
  expect(tag(record, "admission")).toBe("community");

  say("the record checked");
  // ── The founder launches the DAO with one button; the others watch the launch page and see it go live ──
  await founder.page.getByText("Nebula").first().click();
  await founder.page.getByRole("tab", { name: /Manage/ }).click();
  // The team's Shares are held behind milestones, so the launch names who judges them: an outsider, the backer, with
  // a bond. Nobody can swap them for friendlier reviewers afterwards.
  const launchPicker = founder.page.getByTestId("launch-panel-people");
  await expect(
    launchPicker.locator("option", { hasText: capital.name }),
  ).toHaveCount(1, { timeout: 30_000 });
  await launchPicker.selectOption(capital.wallet.address.toLowerCase());
  await founder.page.getByTestId("launch-panel-bond").fill("25");
  await founder.page.getByTestId("dao-launch-start").click();
  await expect(founder.page.getByTestId("dao-launch-status")).toContainText(
    "Your project is live",
    { timeout: 120_000 },
  );
  await shot(founder.page, "1-live");

  say("the DAO is live");
  // The panel was part of the launch: it is listed on the Work tab as the milestone panel, with its bond.
  await founder.page.reload();
  await founder.page.getByRole("tab", { name: "Work" }).click();
  await expect(founder.page.getByTestId("work-milestone-panel")).toBeVisible({
    timeout: 30_000,
  });
  await expect(founder.page.getByTestId("work-bond")).toContainText("25");
  await expect(founder.page.getByTestId("work-reviewers")).toContainText(
    "bond not posted yet",
  );
  // Back to where the sale is run from.
  await founder.page.getByRole("tab", { name: /Manage/ }).click();
  const [launched] = await readRecords(host, { kinds: [37001] });
  const shares = tag(launched, "token");
  const auction = tag(launched, "auction");
  const dao = tag(launched, "treasury");
  for (const address of [shares, auction, dao])
    expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  // The launch started a real sale, so the saved record says it is live: nobody has to remember to flip the label.
  expect(JSON.parse(launched.content).stage).toBe("live");

  // ── The capital contributor backs the launch from their own wallet, through the bid dialog ──────────
  await mineTo(start + 2);
  const raisedBefore = await dollarsOf(dao);
  const walletBefore = await dollarsOf(capital.wallet.address);
  await capital.page.goto("/launchpad");
  await capital.page.getByText("Nebula").first().click();
  await expect(
    capital.page.getByRole("button", { name: "Place bid" }),
  ).toBeVisible({ timeout: 30_000 });
  await shot(capital.page, "1b-backer-sale-page");
  await capital.page.getByRole("button", { name: "Place bid" }).click();
  await capital.page.getByTestId("bid-budget").fill("400000");
  await shot(capital.page, "1c-backer-bid-dialog");
  await expect(capital.page.getByTestId("bid-issues")).toHaveCount(0);
  await capital.page.getByTestId("bid-send").click();
  await expect
    .poll(async () => (await readRecords(host, { kinds: [47002] })).length, {
      timeout: 90_000,
    })
    .toBeGreaterThan(0);
  say("the capital contributor has bid");
  await expect
    .poll(
      async () => walletBefore - (await dollarsOf(capital.wallet.address)),
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0n);

  // ── The sale ends; anyone can graduate it, and the whole raise goes to the DAO's treasury ───────────
  await mineTo(start + 200 + 2);
  await founder.page.getByRole("button", { name: "Re-check" }).click();
  await expect(founder.page.getByTestId("graduation-readiness")).toContainText(
    "ended and raised enough",
    { timeout: 30_000 },
  );
  await founder.page.getByTestId("graduation-execute").click();
  await expect(founder.page.getByTestId("graduation-status")).toContainText(
    "Graduation executed",
    { timeout: 90_000 },
  );
  say("the sale graduated");
  const raised = (await dollarsOf(dao)) - raisedBefore;
  expect(raised).toBeGreaterThanOrEqual(300_000n * 10n ** 6n);

  // ── The founder lets the backer into the backers room, and the backer is named, not a key ────────────
  const daoUrl = `/launchpad/${tag(launched, "d")}?author=${founder.pubkey}`;
  await founder.page.goto(daoUrl);
  await expect(founder.page.getByTestId("launch-chat-admit")).toContainText(
    "Cleo Capital backed this launch and is waiting to join.",
    { timeout: 30_000 },
  );
  await founder.page.getByTestId("launch-chat-admit-button").click();
  await expect(founder.page.getByTestId("launch-chat-admit")).toHaveCount(0, {
    timeout: 30_000,
  });
  await capital.page.goto(daoUrl);
  await expect(
    capital.page.getByTestId("launch-chat-open-backers"),
  ).toBeVisible({ timeout: 30_000 });
  say("the backer is in the backers room");

  // ── Time passes on the chain, and the capital contributor collects the Shares their money bought ──────
  await mineTo(start + 260 + 2);
  say("the chain is past the claim block");
  await capital.page.goto(daoUrl);
  say("the capital contributor is on the launch page");
  await capital.page.getByRole("tab", { name: /My bids/ }).click();
  say("the capital contributor opened My bids");
  // A bid is settled in two steps: exit (which settles what was filled and refunds the rest), then claim.
  const settle = async (button: string) => {
    const offered = capital.page.getByTestId(button);
    // If the step never appears, say what the panel said instead: waiting out the whole test budget tells nothing.
    await offered.waitFor({ timeout: 60_000 }).catch(async () => {
      const page = await capital.page
        .locator("main")
        .innerText()
        .catch(() => "(no page)");
      throw new Error(
        `${button} was never offered. The page said:\n${page.slice(-2500)}`,
      );
    });
    await offered.click();
    await capital.page.getByTestId("mybids-run").click();
    await expect(capital.page.getByTestId("mybids-done")).toBeVisible({
      timeout: 90_000,
    });
    await capital.page.getByTestId("mybids-done").click();
  };
  await settle("mybids-exit");
  say("the capital contributor exited the bid");
  await settle("mybids-claim");
  const cleoShares = await callWord(
    shares,
    `0x70a08231${word(capital.wallet.address)}`,
  );
  expect(cleoShares).toBeGreaterThan(0n);
  say("the capital contributor holds Shares");
  await shot(capital.page, "2-capital-shares");

  // ── The DAO decides, as a DAO does: its people back a decision, time passes, it runs ─────────────────
  const dollars = (n: number) => BigInt(n) * 10n ** 6n;
  const open = async (person: Person, tab: string) => {
    await person.page.goto(daoUrl);
    await person.page.getByRole("tab", { name: tab }).click();
  };
  const pass = async (seconds: number) => {
    await rpc("anvil_increaseTime", [seconds]);
    await rpc("anvil_mine", ["0x1"]);
  };
  /** Both the founder and the capital contributor hold Shares, so both back it; then the waits pass and it runs. */
  const carryOut = async (
    approveAfter: number,
    waitFor: number,
    // What both of them back together: the reviewer's bond (100 Shares, held by the panel) no longer votes once posted.
    together = "Backing 240,000,000",
  ) => {
    await Promise.all(
      [founder, capital].map(async (person) => {
        await open(person, "Decisions");
        const card = person.page.getByTestId("decision-card").first();
        await expect(card.getByTestId("decision-status")).toHaveText(
          "Collecting support",
          { timeout: 30_000 },
        );
        await card.getByTestId("decision-vote-for").click();
        await expect(card.getByTestId("decision-support")).toContainText(
          "Backing",
          { timeout: 30_000 },
        );
      }),
    );
    await open(founder, "Decisions");
    await expect(
      founder.page
        .getByTestId("decision-card")
        .first()
        .getByTestId("decision-support"),
    ).toContainText(together, { timeout: 30_000 });
    await pass(approveAfter);
    await open(founder, "Decisions");
    const approved = founder.page.getByTestId("decision-card").first();
    await expect(approved.getByTestId("decision-status")).toHaveText(
      "Approved",
      { timeout: 30_000 },
    );
    await approved.getByTestId("decision-start-wait").click();
    await expect(approved.getByTestId("decision-status")).toHaveText(
      "Waiting to run",
      { timeout: 30_000 },
    );
    await pass(waitFor);
    await open(founder, "Decisions");
    const ready = founder.page.getByTestId("decision-card").first();
    await expect(ready.getByTestId("decision-status")).toHaveText(
      "Ready to run",
      { timeout: 30_000 },
    );
    await ready.getByTestId("decision-run").click();
    await expect(ready.getByTestId("decision-status")).toHaveText("Done", {
      timeout: 60_000,
    });
  };

  // 1. A work budget that holds money. Its reviewers are picked by name: the people who linked a wallet.
  const treasuryBefore = await dollarsOf(dao);
  await open(founder, "Decisions");
  await founder.page.getByTestId("decision-new").click();
  await founder.page.getByTestId("decision-kind-budget").click();
  await founder.page.getByTestId("budget-money").fill("20000");
  await founder.page.getByTestId("budget-money-cap").fill("10000");
  // The founder holds team Shares a milestone lock holds back, so the contract would refuse them on the panel: the
  // outside backer is the reviewer, and the panel asks them for a real bond.
  const reviewerPicker = founder.page.getByTestId("budget-reviewers-people");
  await expect(
    reviewerPicker.locator("option", { hasText: capital.name }),
  ).toHaveCount(1, { timeout: 30_000 });
  await reviewerPicker.selectOption(capital.wallet.address.toLowerCase());
  await founder.page.getByTestId("budget-bond").fill("100");
  // The bond is paid in the project's own Shares this time: the vote names the token, and says plainly what that means.
  await founder.page.getByTestId("budget-bond-token").selectOption("project");
  await expect(founder.page.getByTestId("budget-bond-warning")).toContainText(
    "worth least when the project struggles",
  );
  await expect(founder.page.getByTestId("decision-draft")).toContainText(
    "1 reviewer, 1 must agree on each claim",
  );
  await expect(founder.page.getByTestId("decision-draft")).toContainText(
    "Each reviewer posts a bond of 100 of the project's own token",
  );
  await founder.page.getByTestId("decision-draft-submit").click();
  await expect(founder.page.getByTestId("decision-opened")).toBeVisible({
    timeout: 60_000,
  });
  say("the founder put a work budget to a vote");
  await carryOut(175_000, 90_000);
  expect(await dollarsOf(dao)).toBe(treasuryBefore - dollars(20_000));
  say("the DAO set aside 20,000 for work");
  await open(founder, "Decisions");
  await shot(founder.page, "3-decisions");

  // 2. A project inside it that may hold money, managed by the founder.
  await open(founder, "Decisions");
  await founder.page.getByTestId("decision-new").click();
  await founder.page.getByTestId("decision-kind-project").click();
  await founder.page.getByTestId("project-name").fill("docs");
  await founder.page
    .getByTestId("project-manager-people")
    .selectOption(founder.wallet.address.toLowerCase());
  await founder.page.getByTestId("project-money").fill("10000");
  await founder.page
    .getByTestId("project-check")
    .fill("docs merged and reviewed");
  await founder.page.getByTestId("decision-draft-submit").click();
  await expect(founder.page.getByTestId("decision-opened")).toBeVisible({
    timeout: 60_000,
  });
  await carryOut(90_000, 90_000);
  say("the DAO approved the project");

  // ── The labor contributor asks to be paid, with a deposit, from their own wallet ─────────────────────
  const laborBefore = await dollarsOf(labor.wallet.address);
  await open(labor, "Work");
  await expect(labor.page.getByTestId("work-projects")).toContainText("docs", {
    timeout: 30_000,
  });
  await labor.page.getByTestId("work-claim-name").fill("write-docs");
  await labor.page
    .getByTestId("work-claim-evidence")
    .fill("https://example.com/pr/1");
  await labor.page
    .getByTestId("work-claim-check")
    .fill("docs merged and reviewed");
  await labor.page
    .getByTestId("work-claim-pay-section")
    .locator("summary")
    .click();
  await labor.page.getByTestId("work-claim-pay").fill("4000");
  await labor.page.getByTestId("work-claim-deposit").fill("50");
  await labor.page.getByTestId("work-claim-submit").click();
  await expect(labor.page.getByTestId("work-claim-filed")).toBeVisible({
    timeout: 90_000,
  });
  expect(laborBefore - (await dollarsOf(labor.wallet.address))).toBe(
    dollars(50),
  );
  say("the labor contributor filed a claim for 4,000");

  // ── The manager takes it on; the reviewer, the capital contributor, posts their bond and approves ────────
  await open(founder, "Work");
  await founder.page.getByTestId("work-bind").click();
  await expect(founder.page.getByTestId("work-claim-next")).toContainText(
    "0 of 1 approvals",
    { timeout: 60_000 },
  );
  await open(capital, "Work");
  // The reviewer is on two panels: the milestone panel the launch named (a 25 USDC bond) and this budget's (100 Shares).
  const budgetCard = capital.page
    .getByTestId("work-mandate")
    .filter({ hasText: "Work budget" });
  await expect(budgetCard.getByTestId("work-bond")).toContainText("100", {
    timeout: 30_000,
  });
  await expect(budgetCard.getByTestId("work-bond")).not.toContainText("USDC");
  // Nothing to judge with until the bond is in; posting it is an approval and then the bond, from their own wallet.
  await expect(budgetCard.getByTestId("work-approve")).toHaveCount(0);
  const capitalBefore = await dollarsOf(capital.wallet.address);
  const sharesOf = async (who: string) =>
    callWord(shares, `0x70a08231${word(who)}`);
  const sharesBefore = await sharesOf(capital.wallet.address);
  await budgetCard.getByTestId("work-post-bond").click();
  await expect(budgetCard.getByTestId("work-bond-owed")).toHaveCount(0, {
    timeout: 90_000,
  });
  // The bond left in Shares, not in dollars.
  expect(sharesBefore - (await sharesOf(capital.wallet.address))).toBe(
    100n * 10n ** 18n,
  );
  expect(await dollarsOf(capital.wallet.address)).toBe(capitalBefore);
  say("the reviewer posted their bond of 100 Shares");
  await shot(capital.page, "5-reviewer-work");
  await budgetCard.getByTestId("work-approve").click();
  await expect(budgetCard.getByTestId("work-claim-next")).not.toContainText(
    "0 of 1 approvals",
    { timeout: 60_000 },
  );
  await open(founder, "Work");
  await founder.page.getByTestId("work-settle").click();
  await expect(founder.page.getByTestId("work-claim-status")).toContainText(
    "Approved",
    { timeout: 60_000 },
  );
  say("the claim was approved");

  // ── After the challenge window, the labor contributor takes the payment; the deposit comes back ─────────
  await pass(700_000);
  await open(labor, "Work");
  await labor.page.getByRole("button", { name: "Refresh work status" }).click();
  await labor.page.getByTestId("work-payout").click();
  await expect(labor.page.getByTestId("work-claim-status")).toContainText(
    "Paid",
    { timeout: 60_000 },
  );
  expect((await dollarsOf(labor.wallet.address)) - laborBefore).toBe(
    dollars(4_000),
  );
  say("the labor contributor was paid 4,000");
  await shot(labor.page, "4-labor-work");

  // ── A claim the DAO doubts is frozen by a vote, then unwound: nothing is paid, and the deposit comes back ──────
  const laborBeforeSecond = await dollarsOf(labor.wallet.address);
  await open(labor, "Work");
  await expect(labor.page.getByTestId("work-projects")).toContainText("docs", {
    timeout: 30_000,
  });
  await labor.page.getByTestId("work-claim-name").fill("extra-docs");
  await labor.page
    .getByTestId("work-claim-evidence")
    .fill("https://example.com/pr/2");
  await labor.page
    .getByTestId("work-claim-check")
    .fill("docs merged and reviewed");
  await labor.page
    .getByTestId("work-claim-pay-section")
    .locator("summary")
    .click();
  await labor.page.getByTestId("work-claim-pay").fill("1000");
  await labor.page.getByTestId("work-claim-deposit").fill("20");
  await labor.page.getByTestId("work-claim-submit").click();
  await expect(labor.page.getByTestId("work-claim-filed")).toBeVisible({
    timeout: 90_000,
  });
  await open(founder, "Work");
  const secondOnFounder = founder.page
    .getByTestId("work-claim")
    .filter({ hasText: "extra-docs" });
  await secondOnFounder.getByTestId("work-bind").click();
  await expect(secondOnFounder.getByTestId("work-claim-next")).toContainText(
    "0 of 1 approvals",
    { timeout: 60_000 },
  );
  await open(capital, "Work");
  const secondOnReviewer = capital.page
    .getByTestId("work-mandate")
    .filter({ hasText: "Work budget" })
    .getByTestId("work-claim")
    .filter({ hasText: "extra-docs" });
  await secondOnReviewer.getByTestId("work-approve").click();
  await expect(
    secondOnReviewer.getByTestId("work-claim-next"),
  ).not.toContainText("0 of 1 approvals", { timeout: 60_000 });
  await open(founder, "Work");
  await secondOnFounder.getByTestId("work-settle").click();
  await expect(secondOnFounder.getByTestId("work-claim-status")).toContainText(
    "Approved",
    { timeout: 60_000 },
  );
  say("a second claim was approved, inside its challenge window");

  // Doubting a claim starts on its own card: "Put a freeze to a vote" opens the form with that claim chosen.
  await open(founder, "Work");
  await founder.page
    .getByTestId("work-claim")
    .filter({ hasText: "extra-docs" })
    .getByTestId("work-challenge")
    .click();
  await expect(founder.page.getByTestId("decision-draft-title")).toContainText(
    "Freeze the claim “extra-docs”",
    { timeout: 30_000 },
  );
  await founder.page.getByTestId("decision-draft-submit").click();
  await expect(founder.page.getByTestId("decision-opened")).toBeVisible({
    timeout: 60_000,
  });
  await carryOut(175_000, 90_000, "Backing 239,999,900");
  await open(labor, "Work");
  const secondOnLabor = labor.page
    .getByTestId("work-claim")
    .filter({ hasText: "extra-docs" });
  await expect(secondOnLabor.getByTestId("work-claim-status")).toContainText(
    "Frozen",
    { timeout: 60_000 },
  );
  // Nothing is payable for a frozen claim, even to its contributor.
  await expect(secondOnLabor.getByTestId("work-payout")).toHaveCount(0);
  say("the DAO froze the claim by a vote");

  await open(founder, "Decisions");
  await founder.page.getByTestId("decision-new").click();
  await founder.page.getByTestId("decision-kind-unwind").click();
  await expect(founder.page.getByTestId("decision-draft-title")).toContainText(
    "Unwind the frozen claim “extra-docs”",
    { timeout: 30_000 },
  );
  await founder.page.getByTestId("decision-draft-submit").click();
  await expect(founder.page.getByTestId("decision-opened")).toBeVisible({
    timeout: 60_000,
  });
  await carryOut(175_000, 90_000, "Backing 239,999,900");
  await open(labor, "Work");
  await expect(
    labor.page
      .getByTestId("work-claim")
      .filter({ hasText: "extra-docs" })
      .getByTestId("work-claim-status"),
  ).toContainText("Recovered", { timeout: 60_000 });
  // The deposit is back and nothing was paid: the contributor is where they were before the claim.
  expect(await dollarsOf(labor.wallet.address)).toBe(laborBeforeSecond);
  say("the DAO unwound it: the deposit is back and nothing was paid");

  // ── The DAO takes part of the careless reviewer's bond, then closes the budget and gets its unused money back ─
  const daoSharesBefore = await sharesOf(dao);
  await open(founder, "Decisions");
  await founder.page.getByTestId("decision-new").click();
  await founder.page.getByTestId("decision-kind-slash").click();
  await founder.page.getByTestId("slash-amount").fill("40");
  await expect(founder.page.getByTestId("decision-draft-title")).toContainText(
    "Take 40 ",
    { timeout: 30_000 },
  );
  // No more than the reviewer holds can be taken.
  await founder.page.getByTestId("slash-amount").fill("400");
  await expect(
    founder.page.getByTestId("decision-draft-problem"),
  ).toContainText("holds only 100");
  await founder.page.getByTestId("slash-amount").fill("40");
  await founder.page.getByTestId("decision-draft-submit").click();
  await expect(founder.page.getByTestId("decision-opened")).toBeVisible({
    timeout: 60_000,
  });
  await carryOut(175_000, 90_000, "Backing 239,999,900");
  expect((await sharesOf(dao)) - daoSharesBefore).toBe(40n * 10n ** 18n);
  await open(capital, "Work");
  await expect(
    capital.page
      .getByTestId("work-mandate")
      .filter({ hasText: "Work budget" })
      .getByTestId("work-bond-return"),
  ).toContainText("Your bond here: 60", { timeout: 60_000 });
  say("the DAO took 40 Shares of the reviewer's bond");

  const treasuryBeforeClose = await dollarsOf(dao);
  await open(founder, "Decisions");
  await founder.page.getByTestId("decision-new").click();
  await founder.page.getByTestId("decision-kind-close").click();
  await expect(founder.page.getByTestId("decision-draft-title")).toHaveText(
    "Close the work budget",
    { timeout: 30_000 },
  );
  await founder.page.getByTestId("decision-draft-submit").click();
  await expect(founder.page.getByTestId("decision-opened")).toBeVisible({
    timeout: 60_000,
  });
  await carryOut(175_000, 90_000, "Backing 239,999,900");
  // Of the 20,000 set aside, 4,000 was paid to the claim; the rest (the recovered claim's 1,000 included) comes back.
  expect((await dollarsOf(dao)) - treasuryBeforeClose).toBe(dollars(16_000));
  await open(founder, "Work");
  await expect(
    founder.page
      .getByTestId("work-mandate")
      .filter({ hasText: "Work budget" })
      .first(),
  ).toContainText("Closed", { timeout: 60_000 });
  say("the DAO closed the budget and took back 16,000");

  // ── What everyone is left holding, on the chain and on the server ───────────────────────────────────
  expect(await dollarsOf(dao)).toBe(
    treasuryBefore - dollars(4_000), // 20,000 went into the work budget, 4,000 of it to the claim; the rest came back
  );
  expect(cleoShares).toBeGreaterThan(0n);
  expect(await dollarsOf(capital.wallet.address)).toBeLessThanOrEqual(
    dollars(5_000_000) - dollars(399_999),
  );
  // Each person has a profile in the community under their own name, and a verified link from their own key.
  const everyone = [founder, labor, capital];
  const profiles = await readRecords(host, {
    kinds: [0],
    authors: everyone.map((person) => person.pubkey),
  });
  expect(
    profiles.map((event) => JSON.parse(event.content).name as string).sort(),
  ).toEqual(everyone.map((person) => person.name).sort());
  const bids = await readRecords(host, { kinds: [47002] });
  expect(bids.map((event) => event.pubkey)).toEqual([capital.pubkey]);
  // The DAO's front page tells the same story: all of it went through a reviewed budget, none paid out directly.
  await open(founder, "Overview");
  await shot(founder.page, "6-overview");
  await expect(founder.page.getByTestId("dao-spending-reviewed")).toContainText(
    "4,000 USDC, of which 4,000 USDC has been paid to claims the reviewers approved",
    { timeout: 30_000 },
  );
  await expect(founder.page.getByTestId("dao-spending-direct")).toContainText(
    "0 USDC",
  );
  await expect(founder.page.getByTestId("dao-spending-headline")).toContainText(
    "went through reviewed work budgets",
  );
  for (const [tab, name] of [
    ["Work", "7-work"],
    ["Track record", "8-record"],
    ["Treasury", "9-treasury"],
    ["Decisions", "10-decisions"],
    ["Manage", "11-manage"],
  ] as const) {
    await open(founder, tab);
    await shot(founder.page, name);
  }
  await founder.page.goto("/portfolio");
  await shot(founder.page, "12-portfolio");

  // ── A backer leaves: what the screen says they take back is what the chain pays them ──────────────────
  // The DAO's own Shares (the reserve and the slashed bond) are not counted when the treasury is split, so the share
  // is the backer's Shares over everything outstanding except the DAO's.
  const outstanding = await callWord(shares, "0x18160ddd");
  const heldByDao = await sharesOf(dao);
  const toGiveUp = await sharesOf(capital.wallet.address);
  const treasuryNow = await dollarsOf(dao);
  const owed = (treasuryNow * toGiveUp) / (outstanding - heldByDao);
  expect(owed).toBeGreaterThan(0n);
  const capitalBeforeExit = await dollarsOf(capital.wallet.address);
  await open(capital, "Treasury");
  // If the preview never appears, say what the panel said instead of just timing out.
  await capital.page
    .getByTestId("ragequit-shares")
    .waitFor({ timeout: 60_000 })
    .catch(async () => {
      const panel = await capital.page
        .getByTestId("ragequit-panel")
        .innerText()
        .catch(() => "(no panel)");
      throw new Error(
        `The exit preview never showed the backer's Shares. The panel said:\n${panel}`,
      );
    });
  await expect(
    capital.page.getByTestId("ragequit-claim-row").last(),
  ).toContainText((owed / 10n ** 6n).toLocaleString("en-US"), {
    timeout: 30_000,
  });
  await shot(capital.page, "13-leave-preview");
  await capital.page.getByTestId("ragequit-exit").click();
  await capital.page.getByTestId("ragequit-run").click();
  await expect(capital.page.getByTestId("ragequit-done")).toBeVisible({
    timeout: 90_000,
  });
  expect((await dollarsOf(capital.wallet.address)) - capitalBeforeExit).toBe(
    owed,
  );
  expect(await sharesOf(capital.wallet.address)).toBe(0n);
  say("the backer left with exactly the share the screen showed");
  // The same pages on a phone, with real data (only when screenshots are being saved).
  if (process.env.E2E_SHOTS) {
    await founder.page.setViewportSize({ width: 390, height: 844 });
    for (const [tab, name] of [
      ["Overview", "p1-overview"],
      ["Decisions", "p2-decisions"],
      ["Work", "p3-work"],
      ["Treasury", "p4-treasury"],
    ] as const) {
      await open(founder, tab);
      await shot(founder.page, `phone-${name}`);
    }
  }
  say("the books agree");
});
