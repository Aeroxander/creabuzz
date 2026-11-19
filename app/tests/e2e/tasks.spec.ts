import { type Browser, expect, type Page, test } from "@playwright/test";
import { encodeFunctionData } from "../../../packages/creaton-core/src/launchpad/evmAbi.ts";
import {
  revokeAgentCall,
  setAgentCall,
} from "../../src/features/tasks/task-calls";
import { expectAccessible } from "../helpers/a11y";
import { expectNoSidewaysScroll } from "../helpers/layout";
import { BACKER_EVM, CONTRACTS, FOUNDER_EVM } from "../helpers/numbers-fixture";
import { PLAN_V2_BUDGETS, PressCounter } from "../helpers/press-counter";
import {
  chainKeyTag,
  installWallet,
  RELAY,
  seedNumbers,
  sentCalls,
} from "./helpers/money-world";
import {
  coordOf,
  DAY,
  event,
  install,
  now,
  profile,
  projectLink,
  projectRecord,
  pubkeyOf,
  type Relay,
} from "./helpers/world";
import { createMockRelay } from "./mock-relay";
import { LEGACY_BUILD, LEGACY_WHY } from "./helpers/legacy-build";

test.skip(!LEGACY_BUILD, LEGACY_WHY);

/**
 * Tasks in the app (plan v2, milestone 8), at 390x844: the founder posts a task with what and what it pays (2 presses,
 * 2 boxes), a stranger takes it and hands the work in, and the founder accepts and pays in 1 press: the wallet sends
 * `Treasury.spend` to the address the stranger's take named, then the acceptance record names its transaction. An
 * agent account on the team is never offered the press. The wallet is a stand-in that records what it is asked to send.
 */

const FOUNDER_KEY = "a1".repeat(32);
const STRANGER_KEY = "a2".repeat(32);
const AGENT_KEY = "a3".repeat(32);
const FOUNDER = pubkeyOf(FOUNDER_KEY);
const STRANGER = pubkeyOf(STRANGER_KEY);
const AGENT = pubkeyOf(AGENT_KEY);
const COORD = coordOf(FOUNDER, "lantern");
const PROJECT = projectLink(FOUNDER, "lantern");

function seed(relay: Relay, team: string[] = []) {
  relay.seed(profile(FOUNDER, "Fay Founder"));
  relay.seed(profile(STRANGER, "Sam Stranger"));
  relay.seed(
    projectRecord(
      FOUNDER,
      "lantern",
      "Lantern",
      "Solar lamps for night markets.",
      now() - 50 * DAY,
      [chainKeyTag(COORD), ...team.map((key) => ["team", key, "engineer"])],
    ),
  );
  seedNumbers(relay, { coordinate: COORD });
}

/** A page for `key`, with a wallet whose account is `account`, on the project's Tasks tab. */
async function openTasks(
  page: Page,
  relay: Relay,
  key: string,
  account: string,
) {
  await install(page, relay, key, { investing: true, relaySelf: RELAY });
  await installWallet(page, { account });
  await page.goto(PROJECT);
  await page.getByTestId("tab-tasks").click({ timeout: 20_000 });
}

async function phone(browser: Browser): Promise<Page> {
  const context = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  return context.newPage();
}

const tasksOf = (relay: Relay, part: string) =>
  relay.events.filter(
    (e) =>
      e.kind === 47003 &&
      e.tags.some((t) => t[0] === "task-part" && t[1] === part),
  );

test(`Post a task: ${PLAN_V2_BUDGETS.postTask.presses} presses and ${PLAN_V2_BUDGETS.postTask.fields} fields, then a stranger takes it, hands in, and is paid on accept in ${PLAN_V2_BUDGETS.acceptAndPay.presses} press`, async ({
  page,
  browser,
}) => {
  const relay = createMockRelay();
  seed(relay);

  // The founder posts.
  await openTasks(page, relay, FOUNDER_KEY, FOUNDER_EVM);
  await expect(page.getByTestId("tasks-none")).toBeVisible();
  const post = new PressCounter();
  await post.press(page.getByTestId("task-new"), "Post a task");
  await expect(page.getByTestId("post-task-sheet")).toBeVisible();
  await expectAccessible(page, "Post a task");
  await post.type(
    page.getByTestId("task-what"),
    "Translate the guide into Spanish",
    "What needs doing",
  );
  await post.type(page.getByTestId("task-dollars"), "40", "It pays");
  await post.read(page, "the sheet");
  await post.press(page.getByTestId("task-post"), "Post");
  const card = page.getByTestId("task-card");
  await expect(card).toContainText("Pays 40 dollars on accept", {
    timeout: 20_000,
  });
  await expect(card.getByTestId("task-state")).toHaveText("Open to anyone");
  console.log(post.summary("Post a task"));
  expect(post.presses).toBeLessThanOrEqual(PLAN_V2_BUDGETS.postTask.presses);
  expect(post.fields).toBeLessThanOrEqual(PLAN_V2_BUDGETS.postTask.fields);
  expect(tasksOf(relay, "task")[0]?.tags).toContainEqual(["task-usd", "40"]);
  // The team does not take its own open task.
  await expect(card.getByTestId("task-take")).toHaveCount(0);

  // A stranger takes it with their wallet, and hands the work in.
  const stranger = await phone(browser);
  await openTasks(stranger, relay, STRANGER_KEY, BACKER_EVM);
  await stranger.getByTestId("task-take").click({ timeout: 20_000 });
  await expect(stranger.getByTestId("task-worker")).toContainText("You", {
    timeout: 20_000,
  });
  expect(tasksOf(relay, "take")[0]?.tags).toContainEqual([
    "task-pay-to",
    BACKER_EVM,
  ]);
  await stranger.getByTestId("task-hand-in").click();
  await stranger
    .getByTestId("task-note")
    .fill("The guide in Spanish: https://example.org/es");
  await stranger.getByTestId("task-hand-in-send").click();
  await expect(stranger.getByTestId("task-state")).toHaveText(
    "Work handed in",
    { timeout: 20_000 },
  );
  // Nothing was paid before a person accepted the work.
  expect(await sentCalls(stranger)).toEqual([]);
  await expect(stranger.getByTestId("task-accept")).toHaveCount(0);

  // The founder accepts and pays: one press.
  await page.reload();
  await page.getByTestId("tab-tasks").click({ timeout: 20_000 });
  const accept = page.getByTestId("task-accept");
  await expect(accept).toHaveText("Accept and pay 40 dollars", {
    timeout: 20_000,
  });
  await expectAccessible(page, "Tasks with work handed in");
  await expectNoSidewaysScroll(page, "Tasks");
  const pay = new PressCounter();
  await pay.press(accept, "Accept and pay 40 dollars");
  await expect(page.getByTestId("toast")).toContainText(
    "Accepted and paid 40 dollars.",
    { timeout: 20_000 },
  );
  const sent = await sentCalls(page);
  expect(sent.map(({ to, data, value }) => ({ to, data, value }))).toEqual([
    // The old design paid a task with `Treasury.spend` (this spec belongs to it: it runs only in a legacy build).
    {
      to: CONTRACTS.treasury,
      value: "0x0",
      data: encodeFunctionData(
        "spend(address,uint256)",
        ["address", "uint256"],
        [BACKER_EVM, 40_000_000n],
      ),
    },
  ]);
  expect(sent[0]?.from).toBe(FOUNDER_EVM);
  const [confirm] = tasksOf(relay, "confirm");
  expect(confirm?.pubkey).toBe(FOUNDER);
  expect(confirm?.tags.find((t) => t[0] === "task-paid")?.[1]).toBe(
    `0x${"1".padStart(64, "0")}`,
  );
  await expect(page.getByTestId("task-state")).toHaveText("Accepted", {
    timeout: 20_000,
  });
  console.log(pay.summary("Accept and pay"));
  expect(pay.presses).toBeLessThanOrEqual(PLAN_V2_BUDGETS.acceptAndPay.presses);
  expect(pay.fields).toBeLessThanOrEqual(PLAN_V2_BUDGETS.acceptAndPay.fields);
});

test("an agent account on the team is never offered Accept or Post", async ({
  page,
}) => {
  const relay = createMockRelay();
  seed(relay, [AGENT]);
  // The agent's profile carries the label the server checked: its own key, and the signature of who runs it.
  relay.seed(
    event(
      0,
      AGENT,
      { name: "Mapper" },
      [
        ["agent", AGENT],
        ["auth", FOUNDER, "", "0".repeat(128)],
      ],
      now() - DAY,
    ),
  );
  const at = now() - 3600;
  const task = event(
    47003,
    FOUNDER,
    { title: "Task", body: "Draw the map" },
    [
      ["a", COORD],
      ["l", "creaton-task"],
      ["task-part", "task"],
      ["task-what", "Draw the map"],
      ["task-usd", "15"],
    ],
    at,
  );
  relay.seed(task);
  const step = (who: string, part: string, extra: string[][] = []) =>
    event(
      47003,
      who,
      { title: part, body: "the map" },
      [
        ["a", COORD],
        ["l", "creaton-task"],
        ["task-part", part],
        ["e", task.id],
        ["task", task.id],
        ...extra,
      ],
      at + 60,
    );
  relay.seed(step(STRANGER, "take", [["task-pay-to", BACKER_EVM]]));
  relay.seed(step(STRANGER, "evidence"));
  await openTasks(page, relay, AGENT_KEY, BACKER_EVM);
  await expect(page.getByTestId("task-state")).toHaveText("Work handed in", {
    timeout: 20_000,
  });
  await expect(page.getByTestId("task-accept")).toHaveCount(0);
  await expect(page.getByTestId("task-new")).toHaveCount(0);
  await expectAccessible(page, "Tasks seen by an agent");
});

test("with money off, a task shows no dollars and nothing about money", async ({
  page,
}) => {
  const relay = createMockRelay();
  seed(relay);
  relay.seed(
    event(
      47003,
      FOUNDER,
      { title: "Task", body: "Draw the map" },
      [
        ["a", COORD],
        ["l", "creaton-task"],
        ["task-part", "task"],
        ["task-what", "Draw the map"],
        ["task-usd", "15"],
      ],
      now() - 60,
    ),
  );
  await install(page, relay, STRANGER_KEY);
  await page.goto(PROJECT);
  await page.getByTestId("tab-tasks").click({ timeout: 20_000 });
  await expect(page.getByTestId("task-card")).toContainText("Draw the map", {
    timeout: 20_000,
  });
  await expect(page.getByTestId("task-pays")).toHaveCount(0);
  await expect(page.getByText(/dollar/i)).toHaveCount(0);
  await expect(page.getByTestId("task-take")).toBeVisible();
});

test("the runner sets an agent's daily limits and switches it off", async ({
  page,
}) => {
  const relay = createMockRelay();
  seed(relay);
  const agentWallet = "0x00000000000000000000000000000000000000ab";
  await openTasks(page, relay, FOUNDER_KEY, FOUNDER_EVM);
  const caps = page.getByTestId("agent-caps");
  await expect(caps).toBeVisible({ timeout: 20_000 });
  await expectAccessible(page, "Agent limits");
  await page.getByTestId("agent-address").fill(agentWallet);
  await page.getByTestId("agent-dollars").fill("25");
  await page.getByTestId("agent-shares").fill("5");
  await page.getByTestId("agent-set").click();
  await expect(page.getByTestId("toast")).toContainText(
    "The agent's limits are set.",
    { timeout: 20_000 },
  );
  await page.getByTestId("agent-off").click();
  await expect(
    page.getByTestId("toast").filter({ hasText: "The agent is switched off." }),
  ).toBeVisible({ timeout: 20_000 });
  const sent = await sentCalls(page);
  expect(sent.map(({ to, data }) => ({ to, data }))).toEqual([
    {
      to: CONTRACTS.treasury,
      data: setAgentCall(CONTRACTS.treasury, agentWallet, 25, 5n * 10n ** 18n)
        .data,
    },
    {
      to: CONTRACTS.treasury,
      data: revokeAgentCall(CONTRACTS.treasury, agentWallet).data,
    },
  ]);
});

test("a wallet that does not run the project sees no agent limits", async ({
  page,
}) => {
  const relay = createMockRelay();
  seed(relay);
  await openTasks(page, relay, FOUNDER_KEY, BACKER_EVM);
  await expect(page.getByTestId("tasks-none")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("agent-caps")).toHaveCount(0);
});
