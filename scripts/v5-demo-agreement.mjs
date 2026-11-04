// v5-demo-agreement.mjs — drive one agreed reward end to end on the demo world,
// and photograph the Work tab at each state.
//
// LOCAL ONLY: a loopback anvil (fixture keys), a loopback relay, the demo world
// `scripts/v5-demo-world.sh` prints. No public network, no real funds.
//
// What it does, in order, with real transactions:
//   propose  → the work area's manager offers an exact Share quantity
//   accept   → the beneficiary accepts those exact terms (the reservation lands)
//   submit   → the beneficiary files the claim, states the agreed check, binds it
//   review   → the panel's two reviewers approve
//   window   → ClaimStake.settle starts the challenge window; time passes
//   settle   → anyone calls the DAO's terms-bound settleAgreement
// and after each step it opens the app, goes to the Work tab and captures what
// the Agreed rewards card says.
//
// Env: RPC (http://… of the demo chain), DAO, BUDGET, SHARES, APP_URL, AUTHOR,
//      SHOTS (directory), RELAY_WS (default ws://127.0.0.1:3030),
//      SHARES_AMOUNT (default 5e18).

import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const RPC_HTTP = process.env.RPC ?? "";
const DAO = process.env.DAO ?? "";
const BUDGET = process.env.BUDGET ?? "";
const SHARES = process.env.SHARES ?? "";
const APP = process.env.APP_URL ?? "";
const SHOTS = process.env.SHOTS ?? "";
const AMOUNT = BigInt(process.env.SHARES_AMOUNT ?? "5000000000000000000");
if (AMOUNT % 10n ** 18n !== 0n) throw new Error("SHARES_AMOUNT must be whole Shares");
const HUMAN_SHARES = (AMOUNT / 10n ** 18n).toString();
const RELAY_WS = process.env.RELAY_WS ?? "ws://127.0.0.1:3030";

if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(RPC_HTTP)) {
  throw new Error(`RPC must be a loopback http URL, got ${RPC_HTTP}`);
}
for (const [name, value] of [["DAO", DAO], ["BUDGET", BUDGET], ["SHARES", SHARES]]) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`${name} must be an address`);
}
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+\//.test(APP)) {
  throw new Error(`APP_URL must be a loopback URL, got ${APP}`);
}
if (!/^ws:\/\/(127\.0\.0\.1|localhost):\d+/.test(RELAY_WS)) {
  throw new Error(`RELAY_WS must be a loopback ws URL, got ${RELAY_WS}`);
}
if (!SHOTS) throw new Error("SHOTS directory is required");
mkdirSync(SHOTS, { recursive: true });

// Foundry's HTTP client panics in this sandbox, so the same node is reached
// over its WebSocket transport.
const RPC = RPC_HTTP.replace(/^http/, "ws");
const here = path.dirname(new URL(import.meta.url).pathname);
const require = createRequire(path.join(here, "..", "web", "node_modules", "package.json"));
const { chromium } = require("@playwright/test");

const KEY = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  manager: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  reviewerA: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  reviewerB: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  beneficiary: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
};

const cast = (args) => execFileSync("cast", [...args, "--rpc-url", RPC], { encoding: "utf8" }).trim();
// Offline helpers (hashing, key derivation) take no RPC flag.
const offline = (args) => execFileSync("cast", args, { encoding: "utf8" }).trim();
// `cast send` on this host intermittently panics while building macOS proxy
// settings (system-configuration returns NULL) before it ever reaches the node.
// That is a client-startup failure, not a chain result, so it is retried; a real
// revert comes back as a parsed receipt with a non-1 status and is NOT retried.
const send = (who, to, sig, params) => {
  let last = "";
  for (let attempt = 1; attempt <= 40; attempt += 1) {
    try {
      const out = cast(["send", to, sig, ...params, "--private-key", KEY[who], "--json"]);
      const receipt = JSON.parse(out);
      if (receipt.status !== "0x1") throw new Error(`${sig} reverted: ${out}`);
      return receipt;
    } catch (error) {
      last = String(error?.stderr ?? error?.message ?? error);
      if (!/system-configuration|NULL object|Unexpected non-whitespace/.test(last)) throw error;
      execFileSync("sleep", ["3"]);
    }
  }
  throw new Error(`${sig} could not be sent after 40 attempts: ${last.slice(0, 300)}`);
};
const call = (to, sig, params = []) => cast(["call", to, sig, ...params]);
const warp = (seconds) => {
  cast(["rpc", "anvil_increaseTime", String(seconds)]);
  cast(["rpc", "anvil_mine", "0x1"]);
};
const hash = (text) => offline(["keccak", text]);
const balanceOf = (who) => BigInt(call(SHARES, "balanceOf(address)(uint256)", [who]).split(" ")[0]);
const now = () => Number(JSON.parse(cast(["rpc", "eth_getBlockByNumber", "latest", "false"])).timestamp);

const CLAIMS = call(BUDGET, "claims()(address)");
const VERIFIERS = call(BUDGET, "verifiers()(address)");
const PROJECT = hash("work-area:docs");
const CHECK = hash("docs merged and reviewed");
const RUN = process.env.RUN_ID ?? String(Date.now());
const SLOT = hash(`demo-deliverable-${RUN}`);
const EVIDENCE = hash("the docs, merged, with the review notes");
const CLAIM_ID = hash(`demo-claim-${RUN}`);
const ZERO32 = `0x${"0".repeat(64)}`;
const agreementId = offline(["keccak", offline(["concat-hex", PROJECT, SLOT])]);

const beneficiaryAddress = offline(["wallet", "address", "--private-key", KEY.beneficiary]);
const reviewerA = offline(["wallet", "address", "--private-key", KEY.reviewerA]);
const reviewerB = offline(["wallet", "address", "--private-key", KEY.reviewerB]);
if (reviewerA.toLowerCase() === beneficiaryAddress.toLowerCase()) {
  throw new Error("the beneficiary must not be a reviewer");
}
if (reviewerA.toLowerCase() === reviewerB.toLowerCase()) {
  throw new Error("the panel needs two distinct reviewers");
}

const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--single-process"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
await page.addInitScript(
  ([relay, rpc]) => {
    localStorage.setItem("buzz.relayUrl", relay);
    localStorage.setItem("buzz.launchpad.rpc", rpc);
  },
  [RELAY_WS, RPC_HTTP],
);

/**
 * The Agreed rewards cards' own words, and a picture of this run's card, at one
 * state. Every agreement in the work area is its own card (`agreed-agreement`);
 * this run's is the one naming the quantity it agreed, so a world that already
 * holds other agreements cannot be mistaken for this one.
 */
async function capture(state, expect) {
  await page.goto(APP, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);
  await page.getByRole("tab", { name: "Work" }).click();
  await page.waitForTimeout(6000);
  const cards = page.getByTestId("agreed-agreement");
  await cards.first().waitFor({ state: "visible", timeout: 30_000 });
  const seen = [];
  let mine = null;
  for (let i = 0; i < (await cards.count()); i += 1) {
    const card = cards.nth(i);
    const label = await card.getByTestId("agreed-state").innerText().catch(() => "?");
    // The badge is the record's own state (offered/agreed/settled); the attempt's
    // review state is carried by the next-step line, so both are captured.
    const next = await card.getByTestId("agreed-next").innerText().catch(() => "");
    const text = (await card.innerText()).replace(/\s+/g, " ");
    seen.push(`${label}`);
    if (text.includes(`${HUMAN_SHARES} Shares`)) mine = { card, label, next, text };
  }
  if (!mine) {
    throw new Error(`no card names ${HUMAN_SHARES} Shares; cards: ${seen.join(" | ")}`);
  }
  if (expect && !mine.label.toLowerCase().includes(expect.toLowerCase())) {
    throw new Error(`expected this card to read ${expect}, got ${mine.label}`);
  }
  const file = path.join(SHOTS, `agreement-${state}.png`);
  await mine.card.screenshot({ path: file });
  console.log(`[${state}] cards=${seen.length} (${seen.join(" | ")}) this=${mine.label}`);
  console.log(`[${state}] next: ${mine.next.replace(/\s+/g, " ").slice(0, 200)}`);
  console.log(`[${state}] shot: ${file}`);
}

// 1 — the manager offers exact terms.
const workDeadline = now() + 7 * 86_400;
send("manager", BUDGET, "proposeAgreement(bytes32,address,uint128,uint64,bytes32,bytes32,bytes32)", [
  PROJECT,
  beneficiaryAddress,
  AMOUNT.toString(),
  String(workDeadline),
  SLOT,
  ZERO32,
  ZERO32,
]);
await capture("1-proposed", "Offered");

// 2 — the beneficiary accepts the exact terms (the reservation lands).
send("beneficiary", BUDGET, "acceptAgreement(bytes32,address[],uint16[])", [agreementId, "[]", "[]"]);
await capture("2-accepted", "Agreed");

// 3 — the beneficiary files, states the agreed check, and binds it.
send("beneficiary", CLAIMS, "submitClaim(bytes32,uint256,uint256,bytes32)", [CLAIM_ID, "0", "0", EVIDENCE]);
send("beneficiary", CLAIMS, "setCheck(bytes32,bytes32)", [CLAIM_ID, CHECK]);
send("beneficiary", BUDGET, "bindSubmission(bytes32,bytes32)", [agreementId, CLAIM_ID]);
await capture("3-submitted");

// 4 — the panel approves (two distinct reviewers, quorum 2).
send("reviewerA", VERIFIERS, "attest(bytes32,bool)", [CLAIM_ID, "true"]);
send("reviewerB", VERIFIERS, "attest(bytes32,bool)", [CLAIM_ID, "true"]);
await capture("4-approved");

// 5 — the approval starts the challenge window; time passes it.
send("deployer", CLAIMS, "settle(bytes32)", [CLAIM_ID]);
const challenge = Number(call(CLAIMS, "challengeWindow()(uint64)").split(" ")[0]);
warp(challenge + 120);
await capture("5-window-passed");

// 6 — anyone settles the agreed reward on its own terms.
const before = balanceOf(beneficiaryAddress);
send("deployer", DAO, "settleAgreement(address,bytes32)", [BUDGET, agreementId]);
const after = balanceOf(beneficiaryAddress);
if (after - before !== AMOUNT) {
  throw new Error(`expected exactly ${AMOUNT} Shares minted, got ${after - before}`);
}
// `cast call` prints one tuple field per line, and numbers carry a bracketed
// human form ("5000000000000000000 [5e18]"), so read the first token of each line.
const fields = call(
  BUDGET,
  "agreements(bytes32)(bytes32,address,uint128,bytes32,bytes32,uint64,uint64,uint64,uint64,bytes32,uint8,uint32,bytes32)",
  [agreementId],
)
  .split("\n")
  .map((line) => line.trim().split(" ")[0]);
const terminal = fields[10];
if (terminal !== "1") throw new Error(`terminalKind should be settled (1), got ${terminal}`);
await capture("6-settled", "Settled");

console.log(
  `\nPASS: one agreement proposed, accepted, submitted, approved, challenged, settled — ` +
    `${AMOUNT} Shares minted exactly (challenge window ${challenge}s)`,
);
await browser.close();
