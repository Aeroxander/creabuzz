import { expect, type Page, test } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";

import { COMMUNITY_HOST, createMockRelay, matches } from "./mock-relay";

/**
 * Ideas from the boards: the team turns a board post into a task, and the
 * person who wrote the post can claim a finder's credit once it is done.
 *
 * What is checked is what the page writes (read back from the mock server) and
 * what it shows. The rules themselves are in `task-source.test.mjs`; these
 * specs bind them to the real screens, including the one that matters most: a
 * task row only *says* who wrote a post, so the claim must look the post up.
 */

const BOARD = "b0a4d000-1111-2222-3333-444444444444";
const GENERAL = "0f0f0f0f-1111-2222-3333-444444444444";
const key = (hex: string) =>
  Uint8Array.from(hex.match(/.{2}/g) ?? [], (b) => Number.parseInt(b, 16));
const TEAM_NSEC = "4".repeat(64);
const ALICE_NSEC = "5".repeat(64);
const TEAM = getPublicKey(key(TEAM_NSEC));
const ALICE = getPublicKey(key(ALICE_NSEC));
const BOB = "b2".repeat(32);
const ADMIN = "a".repeat(64);

const ALICE_POST = `${"1".repeat(8)}${"e".repeat(56)}`;
const BOB_POST = `${"2".repeat(8)}${"e".repeat(56)}`;
const TEAM_POST = `${"3".repeat(8)}${"e".repeat(56)}`;

let seq = 0;
function event(fields: {
  kind: number;
  pubkey: string;
  tags?: string[][];
  content?: string;
  id?: string;
  created_at?: number;
}) {
  seq += 1;
  return {
    id: `${(seq + 100).toString(16).padStart(8, "0")}${"d".repeat(56)}`,
    created_at: 1_700_000_000 + seq,
    tags: [],
    content: "",
    sig: "0".repeat(128),
    ...fields,
  };
}

const forumPost = (id: string, pubkey: string, title: string, body = "") =>
  event({
    id,
    kind: 45001,
    pubkey,
    tags: [["h", BOARD]],
    content: body ? `# ${title}\n\n${body}` : `# ${title}`,
  });

const vote = (target: string, pubkey: string) =>
  event({
    kind: 45002,
    pubkey,
    tags: [
      ["h", BOARD],
      ["e", target],
    ],
    content: "+",
  });

function taskRow(
  pubkey: string,
  d: string,
  body: Record<string, unknown>,
  at: number,
) {
  return event({
    kind: 44011,
    pubkey,
    tags: [
      ["d", d],
      ["h", BOARD],
    ],
    content: JSON.stringify(body),
    created_at: at,
  });
}

const source = (post: string, author: string, finderReward = 5) => ({
  post,
  board: BOARD,
  author,
  finderReward,
});

function seedCommunity(relay: ReturnType<typeof createMockRelay>) {
  for (const [id, name, type] of [
    [GENERAL, "general", "stream"],
    [BOARD, "ideas", "forum"],
  ] as const) {
    relay.seed(
      event({
        kind: 39000,
        pubkey: ADMIN,
        tags: [["d", id], ["name", name], ["public"], ["t", type]],
      }),
    );
  }
  relay.seed(
    forumPost(ALICE_POST, ALICE, "Add dark mode", "It hurts at night."),
  );
  relay.seed(forumPost(BOB_POST, BOB, "Faster search"));
  relay.seed(forumPost(TEAM_POST, TEAM, "Our own idea"));
  // Alice's post is the best liked.
  relay.seed(vote(ALICE_POST, BOB));
  relay.seed(vote(ALICE_POST, ADMIN));
}

async function openWork(
  page: Page,
  relay: ReturnType<typeof createMockRelay>,
  nsec: string,
) {
  await relay.install(page);
  await page.route("**/communities", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        communities: [
          {
            host: COMMUNITY_HOST,
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
  await page.route("**/query", async (route) => {
    const filters = JSON.parse(route.request().postData() ?? "[]") as Record<
      string,
      unknown
    >[];
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        relay.events.filter((e) => filters.some((f) => matches(f, e))),
      ),
    });
  });
  await page.addInitScript((secret) => {
    window.localStorage.setItem("buzz.identity.nsec", secret);
    window.localStorage.setItem("buzz.identity.backedUp", "1");
  }, nsec);
  await page.goto(`/c/${COMMUNITY_HOST}`);
  await page.getByTestId("content-pane").waitFor();
  await page.getByTestId("work-toggle").click();
  await page.getByTestId("board-ideas-toggle").click();
}

test("the team turns a board post into a task, with a credit for whoever wrote it", async ({
  page,
}) => {
  const relay = createMockRelay();
  seedCommunity(relay);
  await openWork(page, relay, TEAM_NSEC);

  // Best liked first; a person's own post is never offered to them.
  const rows = page.getByTestId("idea-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("Add dark mode");
  await expect(rows.nth(1)).toContainText("Faster search");
  await expect(page.getByText("Our own idea")).toHaveCount(0);

  await rows.nth(0).getByTestId("idea-make-task").click();
  await page.getByTestId("idea-reward").fill("50");
  // Left empty, the credit is a tenth of the reward.
  await expect(page.getByTestId("idea-finder")).toHaveAttribute(
    "placeholder",
    "5",
  );
  await page.getByTestId("idea-submit").click();

  await expect
    .poll(() => relay.events.find((e) => e.kind === 44011)?.content)
    .toBeTruthy();
  const task = relay.events.find((e) => e.kind === 44011);
  expect(task?.pubkey).toBe(TEAM);
  expect(task?.tags).toContainEqual(["h", BOARD]);
  const body = JSON.parse(task?.content ?? "{}");
  expect(body).toMatchObject({
    title: "Add dark mode",
    description: "It hurts at night.",
    reward: 50,
    labels: ["from-board"],
    source: source(ALICE_POST, ALICE, 5),
  });

  // The person who wrote it finds out, on the post itself.
  await expect
    .poll(
      () =>
        relay.events.find(
          (e) =>
            e.kind === 45003 &&
            e.pubkey === TEAM &&
            e.tags.some((t) => t[0] === "e" && t[1] === ALICE_POST),
        )?.content,
    )
    .toBe(
      "The team turned this into a task. If it gets done, you can claim 5 points as its finder.",
    );

  // And it is no longer waiting.
  await expect(rows).toHaveCount(1);
  await expect(rows.nth(0)).toContainText("Faster search");
});

test("before the task is done there is nothing to claim", async ({ page }) => {
  const relay = createMockRelay();
  seedCommunity(relay);
  relay.seed(
    taskRow(
      TEAM,
      "idea-1",
      {
        title: "Add dark mode",
        status: "open",
        reward: 50,
        source: source(ALICE_POST, ALICE),
      },
      1_700_000_100,
    ),
  );
  await openWork(page, relay, ALICE_NSEC);

  const mine = page.getByTestId("your-suggestions");
  await expect(mine).toContainText("Add dark mode");
  await expect(mine).toContainText("Made into a task · 5 points for you");
  await expect(page.getByTestId("suggestion-claim")).toHaveCount(0);
});

function seedFinished(
  relay: ReturnType<typeof createMockRelay>,
  d: string,
  title: string,
  post: string,
) {
  relay.seed(
    taskRow(
      TEAM,
      d,
      {
        title,
        status: "open",
        reward: 50,
        source: source(post, ALICE),
      },
      1_700_000_100,
    ),
  );
  const done = taskRow(TEAM, d, { title, status: "done" }, 1_700_000_200);
  relay.seed(done);
  return done;
}

test("a finished task lets its post's author claim, and a second claim is refused", async ({
  page,
}) => {
  const relay = createMockRelay();
  seedCommunity(relay);
  const done = seedFinished(relay, "idea-1", "Add dark mode", ALICE_POST);
  await openWork(page, relay, ALICE_NSEC);

  await page.getByTestId("suggestion-claim").click();
  await expect(page.getByTestId("suggestion-filed")).toBeVisible();

  const record = relay.events.find((e) => e.kind === 37013);
  expect(record?.pubkey).toBe(ALICE);
  // Inside the 64 bytes the record builders allow an id.
  expect(record?.tags).toContainEqual(["d", `finder:${done.id.slice(0, 56)}`]);
  expect(
    record?.tags.find((t) => t[0] === "d")?.[1].length,
  ).toBeLessThanOrEqual(64);
  const content = JSON.parse(record?.content ?? "{}");
  expect(content).toMatchObject({
    amount: 5,
    reviewStatus: "pending",
    evidence: [ALICE_POST, done.id],
  });
  expect(content.action).toBe("Suggested on the board: Add dark mode");

  // After a reload the button is back, and the server's answer is no.
  await page.reload();
  // The address keeps the Work page open across a reload.
  await page.getByTestId("board-ideas-toggle").click();
  await page.getByTestId("suggestion-claim").click();
  await expect(
    page.getByText("This credit has already been claimed."),
  ).toBeVisible();
  expect(relay.events.filter((e) => e.kind === 37013)).toHaveLength(1);
});

test("a task row cannot name a post that is not yours", async ({ page }) => {
  const relay = createMockRelay();
  seedCommunity(relay);
  // The row says Alice wrote it; the post on the board says Bob did.
  seedFinished(relay, "idea-forged", "Faster search", BOB_POST);
  await openWork(page, relay, ALICE_NSEC);

  await page.getByTestId("suggestion-claim").click();
  await expect(
    page.getByText(
      "We couldn't find your post on that board, so the credit can't be filed.",
    ),
  ).toBeVisible();
  expect(relay.events.filter((e) => e.kind === 37013)).toHaveLength(0);
});

test("nobody but the post's author is offered the credit", async ({ page }) => {
  const relay = createMockRelay();
  seedCommunity(relay);
  seedFinished(relay, "idea-1", "Add dark mode", ALICE_POST);
  // The team member who made the task is not its finder.
  await openWork(page, relay, TEAM_NSEC);

  await expect(page.getByTestId("board-ideas")).toBeVisible();
  await expect(page.getByTestId("your-suggestions")).toHaveCount(0);
  await expect(page.getByTestId("suggestion-claim")).toHaveCount(0);
});
