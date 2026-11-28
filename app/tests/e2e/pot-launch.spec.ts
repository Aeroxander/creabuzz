import { expect, test } from "@playwright/test";
import {
  decodeCall,
  decodeReturn,
  encodeCall,
} from "../../../packages/creaton-core/src/pot/abi-codec.ts";
import { LAUNCHER_ABI } from "../../../packages/creaton-core/src/pot/abis.generated.ts";
import {
  chainKeyOf,
  projectIdOf,
} from "../../../packages/creaton-core/src/launchpad/project-chain.ts";
import * as pot from "../../../packages/creaton-core/src/pot/pot-calls.ts";
import * as reads from "../../../packages/creaton-core/src/pot/pot-reads.ts";
import * as state from "../../../packages/creaton-core/src/pot/pot-state.ts";
import { expectAccessible } from "../helpers/a11y";
import { expectNoSidewaysScroll } from "../helpers/layout";
import { PLAN_V2_BUDGETS, PressCounter } from "../helpers/press-counter";
import { walletOf } from "../anvil/pot-chain";
import { call, send } from "../anvil/rpc";
import { launchedProject, NO_CHAIN_WHY } from "./helpers/live-chain";
import {
  FOUNDER_KEY,
  FOUNDER_NOSTR,
  liveWorld,
  openServer,
  pageOf,
  seedServer,
} from "./helpers/live-browser";
import { installAnvilWallet } from "./helpers/live-wallet";
import { createMockRelay } from "./mock-relay";
import { DAY, install, now, profile, projectRecord } from "./helpers/world";
import { RELAY } from "./helpers/money-world";

test.skip(NO_CHAIN_WHY !== null, NO_CHAIN_WHY ?? "");

/**
 * A founder launches from the app on a real local chain, in a real browser, in the default build: Start, then the launch
 * card on the new project's page, the sheet (nothing typed), one wallet signature, and the page that shows the project
 * once the server has read it (not before). Also: the platform's settings changing between the sheet and the signature, a
 * wallet that says no, a double press, a launch that landed but whose page was not tied to it yet, and the keyboard.
 */

const world = liveWorld();
const read = (to: string, data: string) => call(to, data);
const SHARE = 10n ** 18n;

/** A relay that holds the founder and a project that is NOT on the network yet (no chain key), as Start leaves it. */
function plainRelay(label: string) {
  const relay = createMockRelay();
  relay.seed(profile(FOUNDER_NOSTR, "Fay Founder", "Building lamps."));
  relay.seed(
    projectRecord(
      FOUNDER_NOSTR,
      label,
      "Lantern",
      "Solar lamps for night markets.",
      now() - 50 * DAY,
    ),
  );
  return relay;
}

test("a founder starts a project, launches it with no field and one signature, and the page waits for the server before it shows any figure", async ({
  page,
}) => {
  const w = world.get();
  const relay = createMockRelay();
  relay.seed(profile(FOUNDER_NOSTR, "Fay Founder", "Building lamps."));
  await openServer(page, relay, FOUNDER_KEY);
  const wallet = await installAnvilWallet(page, w.who.founder);
  const path = new PressCounter();

  // Start, as always: three answers.
  await page.goto("/start");
  await path.type(page.getByTestId("start-name"), "Lantern", "Name");
  await path.type(
    page.getByTestId("start-goal"),
    "Solar lamps for night markets.",
    "What will you make?",
  );
  await path.type(
    page.getByTestId("start-how"),
    "Ten markets use them.",
    "How",
  );
  await path.press(page.getByTestId("start-submit"), "Start");

  // The project's page leads to the launch: the card says what it is and that the dollars are play money.
  const card = page.getByTestId("launch-card");
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card).toContainText("Open Lantern to backers");
  await expect(page.getByTestId("launch-play-money")).toContainText(
    "play money",
  );
  await page.getByTestId("tab-money").click();
  await expect(page.getByTestId("money-none")).toContainText(
    "Not open to backers yet",
  );
  await page.getByTestId("tab-updates").click();

  // Launch: one press opens the sheet, which asks for nothing (the two starting numbers are the same for every project);
  // one press sends.
  const before = path.presses;
  await path.press(page.getByTestId("launch-open"), "Launch");
  const sheet = page.getByTestId("launch-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("textbox")).toHaveCount(0);
  await expect(page.getByTestId("launch-fee")).toHaveText(
    "Creaton takes 2% of the money people put in.",
  );
  await expect(page.getByTestId("launch-terms")).toContainText(
    "The team may take 0.10% of the project's money a day. Team pool: 10,000,000 Team Shares.",
  );
  await path.read(page, "the launch sheet");
  await path.press(page.getByTestId("sheet-confirm"), "Launch Lantern");
  await expect(sheet).toBeHidden({ timeout: 30_000 });

  // One signature, one call, and the numbers on the sheet are the numbers on the chain.
  expect(wallet.prompts).toBe(1);
  expect(path.presses - before).toBe(2);
  const sent = wallet.sent[0];
  expect(sent?.to).toBe(w.chain.launcher);
  const decoded = decodeCall(LAUNCHER_ABI, sent?.data ?? "");
  expect(decoded?.name).toBe("launch");
  const coordinate = `37001:${FOUNDER_NOSTR}:lantern`;
  const key = chainKeyOf(w.who.founder, projectIdOf(coordinate));
  expect(decoded?.args.slice(0, 4)).toEqual([
    projectIdOf(coordinate),
    "Lantern",
    "LANTERN",
    [1000n, 10_000_000n * SHARE],
  ]);
  const parts = await state.readProjectParts(read, w.chain.launcher, key);
  expect(await state.ratePpmNow(read, parts.treasury)).toBe(1000);
  expect(await reads.balanceOf(read, parts.team, parts.vester)).toBe(
    10_000_000n * SHARE,
  );

  // The page is tied to the launch and shows the Money tab. The server has not read the project yet: it says so and shows
  // no figure (no zeros).
  await expect(page.getByTestId("launch-card")).toHaveCount(0);
  const none = page.getByTestId("money-none");
  await expect(none).toBeVisible({ timeout: 20_000 });
  await expect(none).toContainText(
    "The server has not read this project's money yet",
  );
  await expect(page.getByTestId("money-pot")).toHaveCount(0);
  expect(await page.getByTestId("money-none").innerText()).not.toMatch(
    /\b0\.00\b/,
  );

  // The server reads the chain; the page looks again on its own and shows the project's money.
  const project = await launchedProject(w, "lantern", FOUNDER_NOSTR);
  await seedServer(relay, w, project);
  await expect(page.getByTestId("project-money")).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByTestId("money-state")).toBeVisible();
  console.log(
    `MEASURED Launch, from the project's page: ${path.presses - before} presses, no field typed, ${wallet.prompts} wallet prompt`,
  );
});

test("a founder with no account goes from Home to launched in the founder budget: Start survives the sign-up, no recovery-key sheet, nothing typed to launch", async ({
  page,
}) => {
  const w = world.get();
  const relay = createMockRelay();
  await install(page, relay, null, {
    investing: true,
    relaySelf: RELAY,
    keepSignUp: true,
  });
  const wallet = await installAnvilWallet(page, w.who.founder);
  const path = new PressCounter();

  await page.goto("/");
  await path.press(page.getByTestId("tab-link-start"), "Start tab");
  await path.type(page.getByTestId("start-name"), "Night Sky", "Name");
  await path.type(
    page.getByTestId("start-goal"),
    "A map of the night sky that ten people use.",
    "What will you make?",
  );
  await path.type(
    page.getByTestId("start-how"),
    "Ten people use it every week.",
    "How",
  );
  await path.press(page.getByTestId("start-submit"), "Start");

  // No account: sign-up, with no recovery-key sheet to get past after it.
  await path.press(page.getByTestId("onboarding-create"), "Create");

  // Back on Start, the press is not asked for again: the project is sent and its page is open with the launch card.
  await expect(page.getByTestId("project-name")).toHaveText("Night Sky", {
    timeout: 20_000,
  });
  await expect(page.getByTestId("backup-sheet")).toHaveCount(0);
  await expect(page.getByTestId("launch-card")).toBeVisible({
    timeout: 20_000,
  });
  await path.press(page.getByTestId("launch-open"), "Launch");
  await expect(
    page.getByTestId("launch-sheet").getByRole("textbox"),
  ).toHaveCount(0);
  await path.press(page.getByTestId("sheet-confirm"), "Launch Night Sky");
  await expect(page.getByTestId("launch-sheet")).toBeHidden({
    timeout: 30_000,
  });
  expect(wallet.prompts).toBe(1);
  const decoded = decodeCall(LAUNCHER_ABI, wallet.sent[0]?.data ?? "");
  expect(decoded?.name).toBe("launch");
  expect(decoded?.args[3]).toEqual([1000n, 10_000_000n * SHARE]);
  console.log(path.summary("Founder, Home to launched"));
  expect(path.presses).toBeLessThanOrEqual(PLAN_V2_BUDGETS.founder.presses);
  expect(path.fields).toBeLessThanOrEqual(PLAN_V2_BUDGETS.founder.fields);
});

test("the platform's settings change between the sheet and the signature: nothing is sent, the words say why, and the next press launches under the new settings", async ({
  page,
}) => {
  const w = world.get();
  const relay = plainRelay("moved");
  await openServer(page, relay, FOUNDER_KEY);
  const wallet = await installAnvilWallet(page, w.who.founder);
  await page.goto(pageOf("moved"));
  await page.getByTestId("launch-open").click();
  await expect(page.getByTestId("launch-fingerprint")).toBeAttached();
  const fingerprint = await page
    .getByTestId("launch-fingerprint")
    .evaluate((el) => el.textContent);
  // The platform's admin changes a setting new projects are born with.
  const [dollar, receiver, fee, unit, agentUsd] = decodeReturn(
    LAUNCHER_ABI,
    "platform",
    await read(w.chain.launcher, encodeCall(LAUNCHER_ABI, "platform", [])),
  ) as [string, string, bigint, bigint, bigint];
  await send(
    w.who.admin,
    w.chain.launcher,
    encodeCall(LAUNCHER_ABI, "setSettings", [
      [dollar, receiver, fee / 2n, unit, agentUsd],
    ]),
  );
  await page.getByTestId("sheet-confirm").click();
  const problem = page.getByTestId("sheet-problem");
  await expect(problem).toContainText(
    "Creaton's settings changed while you were deciding. Nothing was sent.",
  );
  await expect(problem).not.toContainText(/0x|revert|SettingsMoved/);
  expect(wallet.prompts).toBe(0);
  // The sheet shows the new settings (a new fingerprint and the fee the platform changed).
  await expect(page.getByTestId("launch-fingerprint")).not.toHaveText(
    fingerprint ?? "",
  );
  await expect(page.getByTestId("launch-fee")).toHaveText(
    "Creaton takes 1% of the money people put in.",
  );
  await page.getByTestId("sheet-confirm").click();
  await expect(page.getByTestId("launch-sheet")).toBeHidden({
    timeout: 30_000,
  });
  expect(wallet.prompts).toBe(1);
  expect(
    await state.readProjectParts(
      read,
      w.chain.launcher,
      chainKeyOf(w.who.founder, projectIdOf(`37001:${FOUNDER_NOSTR}:moved`)),
    ),
  ).toBeTruthy();
});

test("a wallet that says no leaves the same press; a double press sends one launch", async ({
  page,
}) => {
  const w = world.get();
  const relay = plainRelay("nodouble");
  await openServer(page, relay, FOUNDER_KEY);
  const wallet = await installAnvilWallet(page, w.who.founder);
  await page.goto(pageOf("nodouble"));
  await page.getByTestId("launch-open").click();
  await expect(page.getByTestId("launch-terms")).toBeVisible();
  wallet.rejectNext = 1;
  await page.getByTestId("sheet-confirm").click();
  await expect(page.getByTestId("sheet-problem")).toContainText(
    "You said no in your wallet. Nothing was sent.",
  );
  await expect(page.getByTestId("sheet-confirm")).toBeEnabled();
  expect(
    await state
      .readProjectParts(
        read,
        w.chain.launcher,
        chainKeyOf(
          w.who.founder,
          projectIdOf(`37001:${FOUNDER_NOSTR}:nodouble`),
        ),
      )
      .then(
        () => true,
        () => false,
      ),
  ).toBe(false);
  wallet.delayMs = 700;
  await page.getByTestId("sheet-confirm").dblclick();
  await expect(page.getByTestId("launch-sheet")).toBeHidden({
    timeout: 30_000,
  });
  expect(wallet.prompts).toBe(2); // the one that was refused, and exactly one more
  expect(wallet.sent).toHaveLength(1);
});

test("a launch that landed but whose page was never tied to it offers only the tie, and sends nothing on the chain", async ({
  page,
}) => {
  const w = world.get();
  const relay = plainRelay("landed");
  // The founder launched from this account earlier (the tab was closed before the page could be tied to it).
  const offer = await state.readLaunchOffer(read, w.chain.launcher);
  await walletOf(w.who.founder).sendCalls(
    [
      pot.launchCall({
        launcher: w.chain.launcher,
        projectId: projectIdOf(`37001:${FOUNDER_NOSTR}:landed`),
        name: "Lantern",
        symbol: "LANTERN",
        ratePpm: 1000,
        teamPool: 10_000_000n * SHARE,
        settingsHash: offer.settingsHash,
      }),
    ],
    31337,
  );
  await openServer(page, relay, FOUNDER_KEY);
  const wallet = await installAnvilWallet(page, w.who.founder);
  await page.goto(pageOf("landed"));
  await expect(page.getByTestId("launch-unlinked")).toContainText(
    "It is on the network from this wallet. One step is left",
  );
  await expect(page.getByTestId("launch-open")).toHaveCount(0);
  await page.getByTestId("launch-finish").click();
  await expect(page.getByTestId("launch-card")).toHaveCount(0, {
    timeout: 20_000,
  });
  expect(wallet.prompts).toBe(0);
});

test("the launch card and sheet are reachable by keyboard, Escape closes the sheet, focus returns, and there is no serious accessibility violation or sideways scroll at 360", async ({
  page,
}) => {
  const w = world.get();
  await page.setViewportSize({ width: 360, height: 780 });
  const relay = plainRelay("keys");
  await openServer(page, relay, FOUNDER_KEY);
  await installAnvilWallet(page, w.who.founder);
  await page.goto(pageOf("keys"));
  const opener = page.getByTestId("launch-open");
  await expect(opener).toBeVisible();
  await expectAccessible(page, "Launch card");
  await page.screenshot({ path: "test-results/pot-screens/launch-card.png" });
  await expectNoSidewaysScroll(page, "Launch card, 360");
  await opener.focus();
  await page.keyboard.press("Enter");
  const sheet = page.getByTestId("launch-sheet");
  await expect(sheet).toBeVisible();
  await expect(page.getByTestId("launch-terms")).toBeVisible();
  await expectAccessible(page, "Launch sheet");
  await page.screenshot({ path: "test-results/pot-screens/launch-sheet.png" });
  await sheet.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await page.screenshot({
    path: "test-results/pot-screens/launch-sheet-end.png",
  });
  await expectNoSidewaysScroll(page, "Launch sheet, 360");
  // Tab stays inside the sheet.
  for (let i = 0; i < 25; i += 1) {
    await page.keyboard.press("Tab");
    expect(
      await page.evaluate(() =>
        Boolean(
          document
            .querySelector('[data-testid="launch-sheet"]')
            ?.contains(document.activeElement),
        ),
      ),
    ).toBe(true);
  }
  // The press is at least 44 px high.
  const box = await page.getByTestId("sheet-confirm").boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(opener).toBeFocused();
});
