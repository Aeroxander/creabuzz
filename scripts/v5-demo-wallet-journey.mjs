// v5-demo-wallet-journey.mjs — drive one agreed reward through the APP, with a
// wallet signing every call, on the local demo world.
//
// Unlike `v5-demo-agreement.mjs` (which drives the chain from the CLI and only
// photographs the result), this one uses the real screens: the manager opens the
// proposal form and sends it, the beneficiary accepts, and the beneficiary
// submits the work — each transaction signed by `window.ethereum` backed by the
// local anvil's unlocked dev accounts.
//
// LOCAL ONLY: loopback app, relay and chain; anvil's public dev keys.
//
// Env: APP_URL, RPC, RELAY_WS, SHOTS, and optionally MANAGER_PK/BENEFICIARY_PK.

import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const APP = process.env.APP_URL ?? "";
const RPC = process.env.RPC ?? "";
const RELAY_WS = process.env.RELAY_WS ?? "ws://127.0.0.1:3030";
const SHOTS = process.env.SHOTS ?? "";
const BUDGET = process.env.BUDGET ?? "";
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+\//.test(APP)) throw new Error("APP_URL must be loopback");
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(RPC)) throw new Error("RPC must be loopback http");
if (!SHOTS) throw new Error("SHOTS is required");
if (!/^0x[0-9a-fA-F]{40}$/.test(BUDGET)) throw new Error("BUDGET must be the work budget address");
mkdirSync(SHOTS, { recursive: true });

const here = path.dirname(new URL(import.meta.url).pathname);
const require = createRequire(path.join(here, "..", "web", "node_modules", "package.json"));
const { chromium } = require("@playwright/test");

const KEY = {
  manager: process.env.MANAGER_PK ?? "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  beneficiary: process.env.BENEFICIARY_PK ?? "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  // The demo kit's panel: anvil accounts 2 and 3.
  reviewerA: process.env.REVIEWER_A_PK ?? "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  reviewerB: process.env.REVIEWER_B_PK ?? "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
};
const offline = (args) => execFileSync("cast", args, { encoding: "utf8" }).trim();
const wsRpc = RPC.replace(/^http/, "ws");
const addressOf = (pk) => offline(["wallet", "address", "--private-key", pk]);
// The app stores its account key NIP-49-encrypted and accepts a legacy plain
// 64-hex value (it re-encrypts on first read). A bech32 `nsec1…` is NOT one of
// the accepted forms, so writing one leaves the app with no identity and every
// Nostr write fails before it reaches the socket.
const nsecOf = (pk) => pk.replace(/^0x/, "");
const QUANTITY = process.env.QUANTITY ?? "3";
let claimRow = null;

const manager = addressOf(KEY.manager);
const beneficiary = addressOf(KEY.beneficiary);

// One browser per role: this host's Chromium runs with --single-process, where a
// second context can bring the whole browser down.
async function runAs(account, pk, fn) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--single-process"],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1400 } });
  await context.addInitScript(
    ({ acct, rpc, relay, nsec }) => {
      Object.defineProperty(window, "ethereum", {
        configurable: true,
        value: {
          request: async ({ method, params }) => {
            if (method === "eth_requestAccounts" || method === "eth_accounts") return [acct];
            const res = await fetch(rpc, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params ?? [] }),
            });
            const body = await res.json();
            if (body.error) throw body.error;
            return body.result;
          },
        },
      });
      localStorage.setItem("buzz.identity.nsec", nsec);
      localStorage.setItem("buzz.relayUrl", relay);
      localStorage.setItem("buzz.launchpad.rpc", rpc);
    },
    { acct: account, rpc: RPC, relay: RELAY_WS, nsec: nsecOf(pk) },
  );
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("pageerror:", String(e).slice(0, 160)));
  try {
    return await fn(page);
  } finally {
    await browser.close();
  }
}

async function openWork(page) {
  await page.goto(APP, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);
  await page.getByRole("tab", { name: "Work" }).click();
  await page.waitForTimeout(6000);
}

/** The card this run owns: the one naming its quantity. */
function cardFor(page) {
  return page
    .getByTestId("agreed-agreement")
    .filter({ hasText: new RegExp(`\\b${QUANTITY} Shares`) })
    .first();
}

async function waitForCardState(page, expected, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    // Scan every card naming this run's quantity: a world that already holds
    // agreements can have more than one, and the first one may be another run's.
    const cards = page.getByTestId("agreed-agreement");
    const count = await cards.count();
    for (let i = 0; i < count; i += 1) {
      const card = cards.nth(i);
      const text = await card.innerText().catch(() => "");
      if (!text.includes(`${QUANTITY} Shares`)) continue;
      last = await card.getByTestId("agreed-state").innerText().catch(() => "");
      if (last.toLowerCase().includes(expected.toLowerCase())) return card;
    }
    await page.waitForTimeout(1500);
  }
  throw new Error(`card never read "${expected}" (last: ${last})`);
}

// 1 — the manager proposes through the form, signing with the wallet.
await runAs(manager, KEY.manager, async (managerPage) => {
  await openWork(managerPage);
  await managerPage.getByTestId("agreed-proposal-open").click();
  await managerPage.getByTestId("agreed-proposal-form").waitFor({ state: "visible", timeout: 20_000 });
  await managerPage.getByTestId("agreed-proposal-area").selectOption({ index: 1 });
  await managerPage
    .getByTestId("agreed-proposal-deliverable")
    .fill(`the guide for the ${QUANTITY}-Share run, finished and reviewed`);
  await managerPage.getByTestId("agreed-proposal-criteria").fill("docs merged and reviewed");
  await managerPage.getByTestId("agreed-proposal-beneficiary").fill(beneficiary);
  await managerPage.getByTestId("agreed-proposal-quantity").fill(QUANTITY);
  // The form validates against the CHAIN's clock, and a demo world that has been
  // warped to exercise review windows runs days ahead of wall time.
  const chainNow = Number(
    offline(["block", "latest", "--field", "timestamp", "--rpc-url", wsRpc]),
  );
  const due = new Date((chainNow + 7 * 86_400) * 1000).toISOString().slice(0, 10);
  await managerPage.getByTestId("agreed-proposal-deadline").fill(due);
  await managerPage.getByTestId("agreed-proposal-send").click();
  await managerPage.waitForTimeout(8000);
  if ((await cardFor(managerPage).count()) === 0) {
    // No offer exists, so whatever the form says is why it was refused (as
    // opposed to the publish problem, which only appears once the offer is on
    // chain and is handled by the retry loop below).
    const refused = managerPage.getByTestId("agreed-proposal-problem");
    const why = (await refused.count())
      ? (await refused.first().innerText()).replace(/\s+/g, " ")
      : "no offer appeared and the form showed no reason";
    throw new Error(`the form refused the offer: ${why}`);
  }
  const offered = await waitForCardState(managerPage, "Offered");
  // The words the work is judged by are published beside the chain record; the
  // beneficiary's submission form needs them. If the automatic publish failed,
  // the panel offers a retry — press it until the panel clears.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const panel = managerPage.getByTestId("agreed-proposal-pending-publish");
    if (!(await panel.count())) break;
    const why = await managerPage
      .getByTestId("agreed-proposal-problem")
      .innerText()
      .catch(() => "");
    console.log(`[propose] publish pending (${why.replace(/\s+/g, " ").slice(0, 120)}) — retrying`);
    await managerPage.getByTestId("agreed-proposal-publish").click();
    await managerPage.waitForTimeout(6000);
  }
  if (await managerPage.getByTestId("agreed-proposal-pending-publish").count()) {
    throw new Error("the offer's words still are not published after retries");
  }
  await offered.screenshot({ path: path.join(SHOTS, "wallet-1-proposed.png") });
  console.log(`[propose] wallet ${manager} signed it; card reads: ${await offered.getByTestId("agreed-state").innerText()}`);
});

// 2 and 3 — the beneficiary accepts, then submits the work once.
await runAs(beneficiary, KEY.beneficiary, async (beneficiaryPage) => {
  await openWork(beneficiaryPage);
  const offeredToMe = await waitForCardState(beneficiaryPage, "Offered");
  await offeredToMe.getByTestId("agreed-accept").click();
  const accepted = await waitForCardState(beneficiaryPage, "Agreed");
  await accepted.screenshot({ path: path.join(SHOTS, "wallet-2-accepted.png") });
  console.log(`[accept] wallet ${beneficiary} signed it; card reads: ${await accepted.getByTestId("agreed-state").innerText()}`);

  await beneficiaryPage
    .getByTestId("agreed-artifact")
    .fill("the guide, in the repository, with the review notes");
  await beneficiaryPage.getByTestId("agreed-met").fill("read it end to end and ran the examples");
  await beneficiaryPage.getByTestId("agreed-submission-send").click();
  await beneficiaryPage.waitForTimeout(10_000);
  const submitted = await waitForCardState(beneficiaryPage, "Agreed");
  await submitted.screenshot({ path: path.join(SHOTS, "wallet-3-submitted.png") });
  const evidenceLink = submitted.locator('a[href^="#claim-"]');
  const href = await evidenceLink.first().getAttribute("href").catch(() => null);
  if (!href) throw new Error("the submitted card offers no link to its claim row");
  const [, rowMandate, rowClaim] = href.slice(1).split("-");
  claimRow = { mandate: rowMandate, claim: rowClaim };
  console.log(`[submit] next: ${await submitted.getByTestId("agreed-next").innerText().catch(() => "")}`);
  console.log(`[submit] bound claim ${rowClaim} in ${rowMandate}`);
});

// The agreement the claim was bound to, read from the chain's own binding (set
// at bind time, before any approval), so the end-of-run checks do not rely on
// what the app believes.
claimRow.agreementId = offline([
  "call",
  BUDGET,
  "agreementOfClaim(bytes32)(bytes32)",
  claimRow.claim,
  "--rpc-url",
  wsRpc,
]);
if (!/^0x[0-9a-f]{64}$/.test(claimRow.agreementId) || /^0x0+$/.test(claimRow.agreementId)) {
  throw new Error(`the claim is not bound to any agreement: ${claimRow.agreementId}`);
}
console.log(`[bind] claim ${claimRow.claim.slice(0, 10)}… is bound to ${claimRow.agreementId.slice(0, 14)}…`);

// 4 — the panel approves from the app, one reviewer per page.
for (const [name, pk] of [
  ["reviewerA", KEY.reviewerA],
  ["reviewerB", KEY.reviewerB],
]) {
  await runAs(addressOf(pk), pk, async (reviewerPage) => {
    await openWork(reviewerPage);
    if (!claimRow) throw new Error("no bound claim id was captured from the card");
    const row = reviewerPage.locator(`#claim-${claimRow.mandate}-${claimRow.claim}`);
    await row.first().waitFor({ state: "visible", timeout: 30_000 });
    const approve = row.first().getByTestId("work-approve");
    await approve.waitFor({ state: "visible", timeout: 30_000 });
    await approve.click();
    await reviewerPage.waitForTimeout(10_000);
    console.log(`[approve] ${name} ${addressOf(pk)} signed the approval`);
  });
}

// 5 — finishing the review starts the challenge window; time passes it.
await runAs(beneficiary, KEY.beneficiary, async (beneficiaryPage) => {
  await openWork(beneficiaryPage);
  const row = beneficiaryPage.locator(`#claim-${claimRow.mandate}-${claimRow.claim}`);
  const finish = row.first().getByTestId("work-settle");
  await finish.waitFor({ state: "visible", timeout: 40_000 });
  await finish.click();
  await beneficiaryPage.waitForTimeout(12_000);
  console.log("[window] the approval quorum was finished, which starts the challenge window");
});

const claimsEscrow = offline(["call", BUDGET, "claims()(address)", "--rpc-url", wsRpc]);
const challenge = Number(
  offline(["call", claimsEscrow, "challengeWindow()(uint64)", "--rpc-url", wsRpc]).split(" ")[0],
);
offline(["rpc", "anvil_increaseTime", String(challenge + 120), "--rpc-url", wsRpc]);
offline(["rpc", "anvil_mine", "0x1", "--rpc-url", wsRpc]);

// 6 — anyone settles the agreed reward from the card, and the chain pays exactly.
await runAs(beneficiary, KEY.beneficiary, async (beneficiaryPage) => {
  await openWork(beneficiaryPage);
  const before = BigInt(
    offline(["call", process.env.SHARES ?? "", "balanceOf(address)(uint256)", beneficiary, "--rpc-url", wsRpc]).split(" ")[0],
  );
  // Scope to this run's own card: another agreement in the same work area may
  // also be ready to settle, and settling the wrong one would still "work".
  const mine = cardFor(beneficiaryPage);
  await mine.waitFor({ state: "visible", timeout: 40_000 });
  const settle = mine.getByTestId("agreed-settle");
  await settle.waitFor({ state: "visible", timeout: 40_000 });
  await settle.click();
  await beneficiaryPage.waitForTimeout(14_000);
  const settled = await waitForCardState(beneficiaryPage, "Settled");
  await settled.screenshot({ path: path.join(SHOTS, "wallet-4-settled.png") });
  const after = BigInt(
    offline(["call", process.env.SHARES ?? "", "balanceOf(address)(uint256)", beneficiary, "--rpc-url", wsRpc]).split(" ")[0],
  );
  const minted = after - before;
  const expected = BigInt(QUANTITY) * 10n ** 18n;
  if (minted !== expected) throw new Error(`settled minted ${minted}, expected ${expected}`);
  console.log(`[settle] wallet ${beneficiary} signed it; card reads Settled; exactly ${minted} Shares minted`);
});

// 7 — the chain agrees, read independently of the app.
const tuple = offline([
  "call",
  BUDGET,
  "agreements(bytes32)(bytes32,address,uint128,bytes32,bytes32,uint64,uint64,uint64,uint64,bytes32,uint8,uint32,bytes32)",
  claimRow.agreementId,
  "--rpc-url",
  wsRpc,
]);
const fields = tuple.split("\n").map((line) => line.trim().split(" ")[0]);
const terminal = fields[10];
if (terminal !== "1") throw new Error(`terminalKind should be settled (1), got ${terminal}`);
const bound = offline([
  "call",
  BUDGET,
  "agreementOfClaim(bytes32)(bytes32)",
  claimRow.claim,
  "--rpc-url",
  wsRpc,
]);
if (bound.toLowerCase() !== claimRow.agreementId.toLowerCase()) {
  throw new Error(`agreementOfClaim is ${bound}, expected ${claimRow.agreementId}`);
}
const reserved = offline(["call", BUDGET, "sharesReservedTotal()(uint256)", "--rpc-url", wsRpc]).split(" ")[0];
console.log(`[chain] terminalKind=${terminal} agreementOfClaim matches; shares still reserved: ${reserved}`);

console.log(
  "PASS: proposed, accepted, submitted, approved by both reviewers, review finished, " +
    `challenge window passed and settled — all from the app; exactly ${BigInt(QUANTITY) * 10n ** 18n} Shares minted`,
);
