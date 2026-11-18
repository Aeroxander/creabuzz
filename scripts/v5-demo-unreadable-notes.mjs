// v5-demo-unreadable-notes.mjs — prove the two "we could not read this" notes
// appear when the milestone-panel read genuinely fails, against the live demo
// world.
//
// It does NOT fake the UI: it answers every RPC call normally except
// `milestoneMandate(address)`, which gets a JSON-RPC error whose message is not
// a revert (the node has no such state). That is exactly the shape the reader
// classifies as `unreadable`, so the app's own code path produces the flag.
//
// LOCAL ONLY: loopback app and chain, anvil's public dev keys.
//
// Env: APP_URL, RPC, SHOTS, WALLET_PK (a key that can open a decision).

import { mkdirSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const APP = process.env.APP_URL ?? "";
const RPC = process.env.RPC ?? "";
const SHOTS = process.env.SHOTS ?? "";
const PK = process.env.WALLET_PK ?? "";
// `FAIL_PANEL=0` is the control: the same screens, with the panel read answering
// normally, must show NO note. Without that, a note that is always rendered would
// pass this test.
const FAIL_PANEL = process.env.FAIL_PANEL !== "0";
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+\//.test(APP))
  throw new Error("APP_URL must be loopback");
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(RPC))
  throw new Error("RPC must be loopback http");
if (!SHOTS) throw new Error("SHOTS is required");
if (!/^0x[0-9a-fA-F]{64}$/.test(PK)) throw new Error("WALLET_PK must be a key");
mkdirSync(SHOTS, { recursive: true });

const here = path.dirname(new URL(import.meta.url).pathname);
const require = createRequire(path.join(here, "..", "web", "node_modules", "package.json"));
const { chromium } = require("@playwright/test");

/** `milestoneMandate(address)` — the one call this run makes fail. */
const PANEL_SELECTOR = "0x17362283";

const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--single-process"],
});
const context = await browser.newContext({ viewport: { width: 1280, height: 1400 } });
await context.addInitScript(
  ({ rpc, pk }) => {
    // The app stores its account key as plain 64-hex (re-encrypted on read).
    localStorage.setItem("buzz.identity.nsec", pk.replace(/^0x/, ""));
    localStorage.setItem("buzz.relayUrl", "ws://127.0.0.1:3030");
    localStorage.setItem("buzz.launchpad.rpc", rpc);
  },
  { rpc: RPC, pk: PK },
);

let failedPanelCalls = 0;
let answeredPanelCalls = 0;
// Both modes intercept the panel call, so the run does not depend on this host's
// flaky RPC: the forced run makes it fail, and the control answers it with the
// zero address the chain really returns. Only the answer differs, so a note that
// showed up regardless of the answer would fail the control.
await context.route(
  (url) => url.href.startsWith(RPC),
  async (route) => {
    const body = route.request().postDataJSON();
    const call = Array.isArray(body?.params) ? body.params[0] : null;
    const data = typeof call?.data === "string" ? call.data.toLowerCase() : "";
    if (data.startsWith(PANEL_SELECTOR)) {
      if (!FAIL_PANEL) {
        answeredPanelCalls += 1;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: body.id ?? 1,
            result: `0x${"0".repeat(64)}`,
          }),
        });
        return;
      }
      failedPanelCalls += 1;
      // A node-side failure, NOT a revert: the reader must call this unreadable.
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: body.id ?? 1,
          error: { code: -32000, message: "missing trie node" },
        }),
      });
      return;
    }
    await route.continue();
  },
);

const page = await context.newPage();
page.on("pageerror", (e) => console.log("pageerror:", String(e).slice(0, 160)));

async function workTab() {
  await page.goto(APP, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(5000);
  await page.getByRole("tab", { name: "Work" }).click();
  await page.waitForTimeout(8000);
}

// ── 1. The Work tab: the note appears, and the cards still render ───────────
await workTab();
const workNote = page.getByTestId("work-panel-unreadable");
if (FAIL_PANEL) await workNote.waitFor({ state: "visible", timeout: 30_000 });
else {
  await page.waitForTimeout(4000);
  if ((await workNote.count()) !== 0)
    throw new Error("the control run still showed the note: it is not caused by the failure");
}
const openWork = (await page.locator("body").innerText()).replace(/\s+/g, " ");
if (!/Open work|Work budget|Milestone/i.test(openWork))
  throw new Error("the Work tab rendered nothing else: the note replaced the cards");
if (FAIL_PANEL) {
  const workText = (await workNote.innerText()).replace(/\s+/g, " ");
  console.log(`[work] note: ${workText}`);
  console.log(
    `[work] cards still on screen: ${await page.getByTestId("agreed-agreement").count()} agreed card(s)`,
  );
  await page.screenshot({ path: path.join(SHOTS, "unreadable-work-tab.png") });
  await workNote.scrollIntoViewIfNeeded();
  await workNote.screenshot({ path: path.join(SHOTS, "unreadable-work-note.png") });
} else {
  console.log("[work] control: the note is absent, and the tab still renders its content");
}

// ── 2. The decision composer: its own note, with the forms below it ─────────
await page.getByRole("tab", { name: "Decisions" }).click();
await page.waitForTimeout(6000);
const openComposer = page.getByTestId("decision-new");
await openComposer.waitFor({ state: "visible", timeout: 30_000 });
await openComposer.click();
const panelNote = page.getByTestId("decision-panel-unreadable");
if (FAIL_PANEL) await panelNote.waitFor({ state: "visible", timeout: 30_000 });
else if ((await panelNote.count()) !== 0)
  throw new Error("the control run still showed the composer note");
const kinds = page.getByTestId("decision-kind-select");
if ((await kinds.count()) === 0)
  throw new Error("the composer offered no forms beside its note");
if (FAIL_PANEL) {
  const panelText = (await panelNote.innerText()).replace(/\s+/g, " ");
  console.log(`[composer] note: ${panelText}`);
  console.log(`[composer] the kind picker is still offered: ${await kinds.count()}`);
  await page.screenshot({ path: path.join(SHOTS, "unreadable-composer.png") });
  await panelNote.scrollIntoViewIfNeeded();
  await panelNote.screenshot({ path: path.join(SHOTS, "unreadable-composer-note.png") });
} else {
  console.log("[composer] control: the note is absent, and the forms are still offered");
}

if (FAIL_PANEL && failedPanelCalls === 0)
  throw new Error("the panel call was never intercepted");
if (!FAIL_PANEL && answeredPanelCalls === 0)
  throw new Error("the control never answered the panel call");

await browser.close();
console.log(
  FAIL_PANEL
    ? `\nPASS: with ${failedPanelCalls} milestoneMandate read(s) failing, the Work tab and the` +
        " decision composer each say they could not read the panel, and both still render their content"
    : "\nPASS (control): with the panel read answering normally, neither note appears",
);
