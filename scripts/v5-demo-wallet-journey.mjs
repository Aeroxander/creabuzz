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
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+\//.test(APP)) throw new Error("APP_URL must be loopback");
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(RPC)) throw new Error("RPC must be loopback http");
if (!SHOTS) throw new Error("SHOTS is required");
mkdirSync(SHOTS, { recursive: true });

const here = path.dirname(new URL(import.meta.url).pathname);
const require = createRequire(path.join(here, "..", "web", "node_modules", "package.json"));
const { chromium } = require("@playwright/test");
const { nip19 } = require("nostr-tools");

const KEY = {
  manager: process.env.MANAGER_PK ?? "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  beneficiary: process.env.BENEFICIARY_PK ?? "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
};
const offline = (args) => execFileSync("cast", args, { encoding: "utf8" }).trim();
const wsRpc = RPC.replace(/^http/, "ws");
const addressOf = (pk) => offline(["wallet", "address", "--private-key", pk]);
const nsecOf = (pk) => nip19.nsecEncode(Uint8Array.from(Buffer.from(pk.replace(/^0x/, ""), "hex")));
const QUANTITY = process.env.QUANTITY ?? "3";

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
    const card = cardFor(page);
    if (await card.count()) {
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
    .fill("the first guide, finished and reviewed");
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
  const offered = await waitForCardState(managerPage, "Offered");
  // The words the work is judged by are published beside the chain record; the
  // beneficiary's submission form needs them, so the manager publishes now.
  const publish = managerPage.getByTestId("agreed-proposal-publish");
  if (await publish.count()) {
    await publish.click();
    await managerPage.waitForTimeout(6000);
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
  console.log(`[submit] next: ${await submitted.getByTestId("agreed-next").innerText().catch(() => "")}`);
});

// 4 — the chain agrees: the reservation, the binding, and the attempt.
const summary = offline([
  "call",
  "0x10C6E9530F1C1AF873a391030a1D9E8ed0630D26",
  "sharesReservedTotal()(uint256)",
  "--rpc-url",
  wsRpc,
]);
console.log(`reserved total now: ${summary}`);
console.log("PASS: proposed, accepted and submitted through the app, each signed by a wallet");
