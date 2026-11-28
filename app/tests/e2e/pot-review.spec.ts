import { type Page, expect, test } from "@playwright/test";
import * as reads from "../../../packages/creaton-core/src/pot/pot-reads.ts";
import { call } from "../anvil/rpc";
import {
  backFor,
  chainNow,
  giveDollars,
  launchProject,
  NO_CHAIN_WHY,
} from "./helpers/live-chain";
import {
  FOUNDER_NOSTR,
  liveWorld,
  openMoney,
  openServer,
  pageOf,
  READER_KEY,
  seedServer,
} from "./helpers/live-browser";
import { liveRecord } from "./helpers/live-record";
import {
  DAY,
  event,
  now,
  profile,
  projectRecord,
  pubkeyOf,
} from "./helpers/world";
import { createMockRelay } from "./mock-relay";

test.skip(NO_CHAIN_WHY !== null, NO_CHAIN_WHY ?? "");

/**
 * What the Money tab does with a wallet or a record that is not what it hoped for, in the default build on a real local chain: a
 * wallet on another network is told so and Back works once it is switched, a wallet that shares no account is offered to connect
 * (never told it holds nothing), a record that copies another project's chain key never shows that project's numbers, and numbers
 * signed by any key but the server's are not shown.
 */

const world = liveWorld();
const read = (to: string, data: string) => call(to, data);
const SQUATTER = pubkeyOf("a3".repeat(32));

test("a wallet that starts on another network is told so, and Back works once it is switched", async ({
  page,
}) => {
  const w = world.get();
  const project = await launchProject(w, "wrongnet", FOUNDER_NOSTR);
  await giveDollars(w, w.who.backer);
  const { wallet } = await openMoney(page, w, project, {
    account: w.who.backer,
    startOnChain: "0x1",
  });
  // The page says what is wrong and offers the switch, instead of showing a quote read from the wrong network.
  const wrong = page.getByTestId("pot-wrong-network").first();
  await expect(wrong).toContainText("Your wallet is on another network", {
    timeout: 20_000,
  });
  await wrong.getByRole("button", { name: "Switch network" }).click();
  await expect(page.getByTestId("backing-amount")).toBeVisible({
    timeout: 20_000,
  });
  expect(wallet.switches).toBe(1);
  expect(wallet.chain).toBe("0x7a69");
  // Back goes through as it does on the right network.
  await page.getByTestId("backing-amount").fill("25");
  await page.getByTestId("backing-review").click();
  await page.getByTestId("sheet-confirm").click();
  await expect(page.getByTestId("back-sheet")).toBeHidden({ timeout: 30_000 });
  expect(wallet.prompts).toBe(1);
  expect(
    await reads.balanceOf(read, project.shares, w.who.backer),
  ).toBeGreaterThan(0n);
});

test("a wallet that shares no account is offered to connect it, never told it holds nothing", async ({
  page,
}) => {
  const w = world.get();
  const project = await launchProject(w, "noaccount", FOUNDER_NOSTR);
  await backFor(w, project, w.who.second, 100n);
  const { wallet } = await openMoney(page, w, project, {
    account: w.who.backer,
    connected: false,
  });
  await expect(page.getByTestId("pot-connect").first()).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId("holding-dollars")).toHaveCount(0);
  await expect(page.getByTestId("top-holding")).toHaveCount(0);
  await page
    .getByTestId("pot-connect")
    .first()
    .getByRole("button", { name: "Connect your wallet" })
    .click();
  await expect(page.getByTestId("holding-dollars")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId("holding-take-out")).toHaveCount(0);
  expect(wallet.connects).toBe(1);
});

test("a record copying another project's chain key never shows that project's numbers", async ({
  page,
}) => {
  const w = world.get();
  const project = await launchProject(w, "copied", FOUNDER_NOSTR);
  await backFor(w, project, w.who.second, 100n);
  const relay = createMockRelay();
  await seedServer(relay, w, project);
  // Someone else's project record names this project's chain key.
  relay.seed(profile(SQUATTER, "Sam Squatter"));
  relay.seed(
    projectRecord(
      SQUATTER,
      "copycat",
      "Lantern Two",
      "Lamps too.",
      now() - DAY,
      [["chain-key", project.key]],
    ),
  );
  await openServer(page, relay, READER_KEY);
  await page.goto(pageOf(project.label));
  await page.getByTestId("tab-money").click({ timeout: 20_000 });
  await expect(page.getByTestId("money-pot")).toBeVisible({ timeout: 20_000 });
  // Client-side navigation to the copying record (the query cache survives; a full reload would clear it).
  await page.evaluate(
    (path) => {
      history.pushState({}, "", path);
      dispatchEvent(new PopStateEvent("popstate"));
    },
    `/p/copycat-${SQUATTER.slice(0, 16)}`,
  );
  await expect(page.getByTestId("project-name")).toHaveText("Lantern Two", {
    timeout: 20_000,
  });
  await page.getByTestId("tab-money").click({ timeout: 20_000 });
  await page.waitForTimeout(1_000);
  await expect(page.getByTestId("money-pot")).toHaveCount(0);
  await expect(page.getByTestId("project-money")).toHaveCount(0);
});

test("numbers signed by any key but the server's are not shown", async ({
  page,
}: {
  page: Page;
}) => {
  const w = world.get();
  const project = await launchProject(w, "forged", FOUNDER_NOSTR);
  await backFor(w, project, w.who.second, 100n);
  const relay = createMockRelay();
  relay.seed(profile(FOUNDER_NOSTR, "Fay Founder"));
  relay.seed(
    projectRecord(
      FOUNDER_NOSTR,
      project.label,
      "Lantern",
      "Solar lamps for night markets.",
      now() - 50 * DAY,
      [["chain-key", project.key]],
    ),
  );
  // A well-formed record of numbers, signed by someone who is not the server.
  relay.seed(
    event(
      39009,
      pubkeyOf("f1".repeat(32)),
      await liveRecord(w, project),
      [
        ["d", project.key],
        ["chain", "31337"],
        ["launcher", project.launcher],
      ],
      (await chainNow()) + 1,
    ),
  );
  await openServer(page, relay, READER_KEY);
  await page.goto(pageOf(project.label));
  await expect(page.getByTestId("project-name")).toHaveText("Lantern", {
    timeout: 20_000,
  });
  await page.getByTestId("tab-money").click({ timeout: 20_000 });
  await expect(page.getByTestId("money-none")).toContainText("No numbers yet");
  await expect(page.getByTestId("money-pot")).toHaveCount(0);
});
