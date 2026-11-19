import { type Page, expect, test } from "@playwright/test";
import { decodeCall } from "../../../packages/creaton-core/src/pot/abi-codec.ts";
import { TREASURY_ABI } from "../../../packages/creaton-core/src/pot/abis.generated.ts";
import { topicOf } from "../../../packages/creaton-core/src/launchpad/work.ts";
import { expectAccessible } from "../helpers/a11y";
import { expectNoSidewaysScroll } from "../helpers/layout";
import { PLAN_V2_BUDGETS, PressCounter } from "../helpers/press-counter";
import { rpc } from "../anvil/rpc";
import {
  backFor,
  checkIn,
  type LiveProject,
  type LiveWorld,
  launchProject,
  NO_CHAIN_WHY,
} from "./helpers/live-chain";
import {
  FOUNDER_KEY,
  FOUNDER_NOSTR,
  liveWorld,
  openServer,
  seedServer,
  syncClock,
} from "./helpers/live-browser";
import { installAnvilWallet, type WalletLog } from "./helpers/live-wallet";
import { createMockRelay } from "./mock-relay";

test.skip(NO_CHAIN_WHY !== null, NO_CHAIN_WHY ?? "");

/**
 * The weekly update with its check-in, in the default build on a real local chain: the update is signed and posted FIRST,
 * and the check-in then carries that record's hash (its id), so the chain points at exactly what was said. A check-in that
 * does not go through says so, keeps the posted update, and offers only the check-in again with the same hash; a project not
 * on the network posts the update alone and says nothing about a check-in.
 */

const world = liveWorld();
const CHECKED_IN = topicOf("CheckedIn(address,bytes32,uint64)");

async function openWeek(
  page: Page,
  w: LiveWorld,
  project: LiveProject | null,
): Promise<{ relay: ReturnType<typeof createMockRelay>; wallet: WalletLog }> {
  const relay = createMockRelay();
  if (project)
    await seedServer(relay, w, project, { recordHash: `0x${"5c".repeat(32)}` });
  else {
    // A project the founder started and has not launched: no chain key on its record.
    const { profile, projectRecord, now, DAY } = await import(
      "./helpers/world"
    );
    relay.seed(profile(FOUNDER_NOSTR, "Fay Founder"));
    relay.seed(
      projectRecord(
        FOUNDER_NOSTR,
        "unlaunched",
        "Lantern",
        "Solar lamps for night markets.",
        now() - 5 * DAY,
      ),
    );
  }
  await openServer(page, relay, FOUNDER_KEY);
  const wallet = await installAnvilWallet(page, w.who.founder);
  await syncClock(page);
  await page.goto("/week");
  return { relay, wallet };
}

/** The check-ins a Treasury logged, as the record hashes they carry, oldest first. */
async function checkInHashes(treasury: string): Promise<string[]> {
  const logs = await rpc<{ data: string }[]>("eth_getLogs", [
    {
      address: treasury,
      topics: [CHECKED_IN],
      fromBlock: "0x0",
      toBlock: "latest",
    },
  ]);
  return logs.map((log) => `0x${log.data.slice(2, 66)}`);
}

const updatesOf = (relay: ReturnType<typeof createMockRelay>) =>
  relay.events.filter((e) => e.kind === 47003 && e.pubkey === FOUNDER_NOSTR);

test(`Weekly update with check-in: ${PLAN_V2_BUDGETS.weeklyUpdate.presses} presses and ${PLAN_V2_BUDGETS.weeklyUpdate.fields} field, the record first, then the check-in carrying its hash`, async ({
  page,
}) => {
  const w = world.get();
  const project = await launchProject(w, "weekone", FOUNDER_NOSTR);
  await backFor(w, project, w.who.second, 100n);
  await checkIn(w, project);
  const before = (await checkInHashes(project.treasury)).length;
  const { relay, wallet } = await openWeek(page, w, project);
  const card = page.getByTestId("week-project");
  await expect(card.getByTestId("week-clock")).toContainText("Last check-in", {
    timeout: 20_000,
  });
  await expect(card.getByTestId("week-open")).toHaveText(
    "Post this week's update and check in",
  );
  await expectAccessible(page, "This week");
  const path = new PressCounter();
  await path.press(card.getByTestId("week-open"), "Post this week's update");
  await path.type(
    page.getByTestId("weekly-text"),
    "Lit ten stalls and fixed the charger.",
    "What did you do this week?",
  );
  await path.read(page, "the weekly sheet");
  await expectAccessible(page, "The weekly sheet");
  await path.press(page.getByTestId("weekly-post"), "Post and check in");
  await expect(page.getByTestId("toast")).toContainText(
    "Posted and checked in",
    { timeout: 30_000 },
  );
  // The update was signed and posted: one record, in the project's name, with the words typed.
  const updates = updatesOf(relay);
  expect(updates).toHaveLength(1);
  expect(updates[0]?.tags).toContainEqual(["a", project.coordinate]);
  expect(updates[0]?.tags).toContainEqual([
    "update-part",
    "done",
    "Lit ten stalls and fixed the charger.",
  ]);
  // One wallet prompt, one call: the Treasury's check-in, which carries the posted record's id. The record came first: its
  // id is the only thing the call could have carried.
  expect(wallet.prompts).toBe(1);
  expect(wallet.sent).toHaveLength(1);
  expect(wallet.sent[0]?.to.toLowerCase()).toBe(project.treasury);
  const call = decodeCall(TREASURY_ABI, wallet.sent[0]?.data ?? "");
  expect(call?.name).toBe("checkIn");
  expect(String(call?.args[0]).toLowerCase()).toBe(`0x${updates[0]?.id}`);
  // The chain logged exactly that check-in, with that hash.
  const hashes = await checkInHashes(project.treasury);
  expect(hashes).toHaveLength(before + 1);
  expect(hashes.at(-1)).toBe(`0x${updates[0]?.id}`);
  console.log(path.summary("Weekly update with check-in"));
  expect(path.presses).toBeLessThanOrEqual(
    PLAN_V2_BUDGETS.weeklyUpdate.presses,
  );
  expect(path.fields).toBeLessThanOrEqual(PLAN_V2_BUDGETS.weeklyUpdate.fields);
  await expectNoSidewaysScroll(page, "This week");
});

test("a check-in that does not go through after the update posted says so and offers only the check-in again, with the same hash", async ({
  page,
}) => {
  const w = world.get();
  const project = await launchProject(w, "weektwo", FOUNDER_NOSTR);
  await backFor(w, project, w.who.second, 100n);
  await checkIn(w, project);
  const before = (await checkInHashes(project.treasury)).length;
  const { relay, wallet } = await openWeek(page, w, project);
  await page.getByTestId("week-open").click({ timeout: 20_000 });
  await page.getByTestId("weekly-text").fill("Quiet week, still at it.");
  // The person says no to the wallet's prompt.
  wallet.rejectNext = 1;
  await page.getByTestId("weekly-post").click();
  await expect(page.getByTestId("weekly-problem")).toContainText(
    "Your update is posted; the check-in did not go through.",
    { timeout: 20_000 },
  );
  // The words box is gone, only the check-in is offered, and nothing was checked in.
  await expect(page.getByTestId("weekly-text")).toHaveCount(0);
  await expect(page.getByTestId("weekly-post")).toHaveText("Check in again");
  expect(await checkInHashes(project.treasury)).toHaveLength(before);
  expect(updatesOf(relay)).toHaveLength(1);
  await page.getByTestId("weekly-post").click();
  await expect(page.getByTestId("toast")).toContainText(
    "Posted and checked in",
    { timeout: 30_000 },
  );
  // One update, however many tries the check-in took, and the check-in carries that update's id.
  const updates = updatesOf(relay);
  expect(updates).toHaveLength(1);
  const hashes = await checkInHashes(project.treasury);
  expect(hashes).toHaveLength(before + 1);
  expect(hashes.at(-1)).toBe(`0x${updates[0]?.id}`);
  expect(wallet.sent).toHaveLength(1);
});

test("a project that is not on the network posts the update alone and says nothing about a check-in", async ({
  page,
}) => {
  const w = world.get();
  const { wallet } = await openWeek(page, w, null);
  await expect(page.getByTestId("week-open")).toHaveText(
    "Post this week's update",
    { timeout: 20_000 },
  );
  await page.getByTestId("week-open").click();
  await page.getByTestId("weekly-text").fill("Built the stand.");
  await expect(page.getByTestId("weekly-post")).toHaveText("Post");
  await page.getByTestId("weekly-post").click();
  await expect(page.getByTestId("toast")).toHaveText("Posted", {
    timeout: 20_000,
  });
  await expect(page.getByTestId("week-last-update")).toHaveText(
    "Updated today",
    { timeout: 20_000 },
  );
  expect(wallet.prompts).toBe(0);
  await expect(page.getByTestId("week-clock")).toHaveCount(0);
});
