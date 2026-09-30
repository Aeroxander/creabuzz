import { expect, test, type Page } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";

import { createMockRelay, matches } from "./mock-relay";

/**
 * Task planning on the work board: "Next up" orders unstarted tasks by
 * trust-weighted backing, a member backs and un-backs a task, a task's plan
 * (milestone, reward) survives a row that omits it, and the person who
 * finished a task claims it as a pending contribution — once.
 */

const ME_NSEC = "4".repeat(64);
const ME = getPublicKey(Uint8Array.from(Buffer.from(ME_NSEC, "hex")));
const ADMIN = "a".repeat(64);
const ALICE = "b".repeat(64);
const WORKER = "d".repeat(64);
const CHANNEL_ID = "0f0f0f0f-1111-2222-3333-444444444444";

let seq = 0;
function event(fields: {
  kind: number;
  pubkey: string;
  tags?: string[][];
  content?: string;
  created_at?: number;
}) {
  seq += 1;
  return {
    id: `${seq.toString(16).padStart(8, "0")}${"e".repeat(56)}`,
    created_at: fields.created_at ?? 1_700_000_000 + seq,
    tags: [],
    content: "",
    sig: "0".repeat(128),
    ...fields,
  };
}

function taskRow(
  pubkey: string,
  d: string,
  body: Record<string, unknown>,
  createdAt: number,
  assignee?: string,
) {
  const tags = [["d", d]];
  if (assignee) tags.push(["p", assignee]);
  return event({
    kind: 44011,
    pubkey,
    tags,
    content: JSON.stringify(body),
    created_at: createdAt,
  });
}

async function openBoard(page: Page, relay: ReturnType<typeof createMockRelay>) {
  await relay.install(page);
  // Registered after `install`, so these answer first.
  await page.route("**/communities", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        communities: [
          {
            host: "alpha.example.com",
            name: "Alpha",
            description: "A test community.",
            icon: null,
            member_count: 3,
            archived: false,
          },
        ],
      }),
    });
  });
  // Backing is read over HTTP `POST /query` (one request, several filters).
  await page.route("**/query", async (route) => {
    const filters = JSON.parse(route.request().postData() ?? "[]") as Record<
      string,
      unknown
    >[];
    const found = relay.events.filter((e) =>
      filters.some((f) => matches(f, e)),
    );
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(found),
    });
  });
  await page.addInitScript((nsec) => {
    window.localStorage.setItem("buzz.identity.nsec", nsec);
    window.localStorage.setItem("buzz.identity.backedUp", "1");
  }, ME_NSEC);
  await page.goto("/c/alpha.example.com");
  await page.getByTestId("content-pane").waitFor();
  await page.getByTestId("work-toggle").click();
}

function seedCommunity(relay: ReturnType<typeof createMockRelay>) {
  relay.seed(
    event({
      kind: 39000,
      pubkey: ADMIN,
      tags: [
        ["d", CHANNEL_ID],
        ["name", "general"],
      ],
    }),
  );
  // The admin owns the org root, so their backing weighs 2 (a newcomer 0.2).
  relay.seed(
    event({
      kind: 37010,
      pubkey: ADMIN,
      tags: [["d", "root"]],
      content: JSON.stringify({ name: "Org", holders: [ADMIN], scope: {} }),
    }),
  );
}

test("Next up orders unstarted work by backing, and a member backs and un-backs", async ({
  page,
}) => {
  const relay = createMockRelay();
  seedCommunity(relay);
  const pitch = taskRow(
    ALICE,
    "task-pitch",
    { title: "Write the pitch", status: "open", priority: "high" },
    1_700_000_100,
  );
  const onboarding = taskRow(
    ALICE,
    "task-onboarding",
    { title: "Fix onboarding", status: "open", priority: "low" },
    1_700_000_101,
  );
  const started = taskRow(
    ALICE,
    "task-ship",
    { title: "Ship v1", status: "in_progress" },
    1_700_000_102,
  );
  relay.seed(pitch);
  relay.seed(onboarding);
  relay.seed(started);
  // The admin backed the low-priority task: backing outranks priority.
  relay.seed(
    event({
      kind: 7,
      pubkey: ADMIN,
      tags: [
        ["e", onboarding.id],
        ["p", ALICE],
        ["k", "44011"],
        ["a", `44011:${ALICE}:task-onboarding`],
      ],
      content: "+",
    }),
  );

  await openBoard(page, relay);
  await page.getByTestId("work-view-next").click();
  const rows = page.getByTestId("next-up-item");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("Fix onboarding");
  await expect(rows.nth(0)).toContainText("Backed by 1");
  await expect(rows.nth(1)).toContainText("Write the pitch");
  await expect(page.getByTestId("next-up-list")).not.toContainText("Ship v1");

  const back = rows.nth(1).getByTestId("task-back");
  await expect(back).toHaveAttribute("aria-pressed", "false");
  await back.click();
  await expect(back).toHaveAttribute("aria-pressed", "true");
  const mine = relay.events.find((e) => e.kind === 7 && e.pubkey === ME);
  expect(mine?.content).toBe("+");
  expect(mine?.tags).toEqual(
    expect.arrayContaining([
      ["e", pitch.id],
      ["a", `44011:${ALICE}:task-pitch`],
      ["k", "44011"],
    ]),
  );
  // A newcomer's backing (0.2) does not outrank the admin's (2).
  await expect(rows.nth(0)).toContainText("Fix onboarding");

  // Un-backing deletes the reaction.
  await back.click();
  await expect
    .poll(() =>
      relay.events.find(
        (e) =>
          e.kind === 5 &&
          e.pubkey === ME &&
          e.tags.some((t) => t[0] === "e" && t[1] === mine?.id),
      ),
    )
    .toBeTruthy();
});

test("a task's plan survives a row that omits it, and the finisher claims it once", async ({
  page,
}) => {
  const relay = createMockRelay();
  seedCommunity(relay);
  relay.seed(
    taskRow(
      ME,
      "task-docs",
      {
        title: "Write the setup guide",
        description: "Plain words, one page",
        status: "open",
        milestone: "Public beta",
        reward: 40,
      },
      1_700_000_200,
      ME,
    ),
  );
  // A lossy writer (the old worker shape) moves it along without the plan.
  relay.seed(
    taskRow(
      WORKER,
      "task-docs",
      { title: "Write the setup guide", description: "", status: "in_progress" },
      1_700_000_201,
      ME,
    ),
  );
  const done = taskRow(
    ME,
    "task-docs",
    { title: "Write the setup guide", status: "done" },
    1_700_000_202,
    ME,
  );
  relay.seed(done);

  await openBoard(page, relay);
  await page.getByTestId("work-view-list").click();
  await page.getByText("Write the setup guide").first().click();
  const planning = page.getByTestId("task-planning");
  await expect(planning.getByTestId("task-milestone")).toHaveValue(
    "Public beta",
  );
  await expect(planning.getByTestId("task-reward")).toHaveValue("40");

  const claim = planning.getByTestId("task-claim");
  await claim.click();
  await expect(claim).toHaveText("Claimed — waiting for review");
  const record = relay.events.find((e) => e.kind === 37013);
  expect(record?.pubkey).toBe(ME);
  expect(record?.tags).toContainEqual(["d", done.id]);
  const content = JSON.parse(record?.content ?? "{}");
  expect(content.reviewStatus).toBe("pending");
  expect(content.amount).toBe(40);
  expect(content.milestone).toBe("Public beta");
});

test("a task already credited (by the worker or the CLI) cannot be claimed twice", async ({
  page,
}) => {
  const relay = createMockRelay();
  seedCommunity(relay);
  const done = taskRow(
    ME,
    "task-fix",
    { title: "Fix the invite link", status: "done" },
    1_700_000_300,
    ME,
  );
  relay.seed(done);
  relay.seed(
    event({
      kind: 37013,
      pubkey: WORKER,
      tags: [["d", done.id]],
      content: JSON.stringify({ v: 1, action: "Fix", reviewStatus: "pending" }),
    }),
  );

  await openBoard(page, relay);
  await page.getByTestId("work-view-list").click();
  await page.getByText("Fix the invite link").first().click();
  await page.getByTestId("task-claim").click();
  await expect(page.getByText("This task has already been claimed.")).toBeVisible();
  expect(relay.events.filter((e) => e.kind === 37013)).toHaveLength(1);
});
