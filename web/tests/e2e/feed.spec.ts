import { expect, test, type Page } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";

import { createMockRelay } from "./mock-relay";

/**
 * The social layer end to end against the stateful mock relay: posting and
 * replying, trust-weighted votes, launch discussion, following a launch
 * (published as a bookmark list), migrating the old browser-only follows, and
 * the public-Nostr copy being opt-in.
 */

const ME_NSEC = "3".repeat(64);
const ME = getPublicKey(Uint8Array.from(Buffer.from(ME_NSEC, "hex")));
const ADMIN = "a".repeat(64);
const ALICE = "b".repeat(64);
const FOUNDER = "c".repeat(64);
const now = () => Math.floor(Date.now() / 1000);

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
    id: `${seq.toString(16).padStart(8, "0")}${"f".repeat(56)}`,
    created_at: fields.created_at ?? now() - 60,
    tags: [],
    content: "",
    sig: "0".repeat(128),
    ...fields,
  };
}

const LAUNCH = event({
  kind: 37001,
  pubkey: FOUNDER,
  tags: [
    ["d", "nebula"],
    ["name", "Nebula DAO"],
    ["t", "dao-launchpad"],
    ["admission", "community"],
  ],
  content: JSON.stringify({ pitch: "To the stars.", stage: "live" }),
});
const COORD = `37001:${FOUNDER}:nebula`;

async function signIn(page: Page) {
  await page.addInitScript((nsec) => {
    window.localStorage.setItem("buzz.identity.nsec", nsec);
    window.localStorage.setItem("buzz.identity.backedUp", "1");
  }, ME_NSEC);
}

test("a post appears on Home and a reply opens its thread", async ({
  page,
}) => {
  const relay = createMockRelay();
  await relay.install(page);
  await signIn(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();

  await page
    .getByTestId("social-composer-input")
    .fill("Shipping the #agents MVP");
  await page.getByTestId("social-composer-submit").click();
  const card = page.getByTestId("social-post").filter({ hasText: "MVP" });
  await expect(card).toBeVisible();
  const post = relay.events.find((e) => e.kind === 1);
  expect(post?.tags).toContainEqual(["t", "agents"]);
  expect(post?.tags.some((t) => t[0] === "h")).toBe(false);

  // Replying opens the post's own page, where the conversation is.
  await card.getByTestId("social-reply").click();
  await expect(page).toHaveURL(/\/social\/post\//);
  await page.getByTestId("social-reply-composer-input").fill("Congrats!");
  await page.getByTestId("social-reply-composer-submit").click();
  await expect(
    page.getByTestId("social-post").filter({ hasText: "Congrats!" }),
  ).toBeVisible();
  const reply = relay.events.find(
    (e) => e.kind === 1 && e.content === "Congrats!",
  );
  expect(reply?.tags).toContainEqual(["e", post?.id, "", "root"]);
});

test("a note's author can delete it from Home", async ({ page }) => {
  const relay = createMockRelay();
  relay.seed(event({ kind: 1, pubkey: ALICE, content: "Someone else's note" }));
  await relay.install(page);
  await signIn(page);
  await page.goto("/");
  await page.getByTestId("social-composer-input").fill("A note I will delete");
  await page.getByTestId("social-composer-submit").click();
  const mine = page
    .getByTestId("social-post")
    .filter({ hasText: "A note I will delete" });
  await expect(mine).toBeVisible();
  // Other people's notes carry no delete button.
  await expect(
    page
      .getByTestId("social-post")
      .filter({ hasText: "Someone else's note" })
      .getByTestId("social-delete"),
  ).toHaveCount(0);

  await mine.getByTestId("social-delete").click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(mine).toHaveCount(0);
  const note = relay.events.find((e) => e.content === "A note I will delete");
  // The card hides at once; the NIP-09 request follows a moment later.
  await expect
    .poll(() => relay.events.find((e) => e.kind === 5)?.tags ?? [])
    .toContainEqual(["e", note?.id]);
});

test("votes are trust-weighted: an org admin outweighs a swarm of new keys (on a launch's discussion)", async ({
  page,
}) => {
  const relay = createMockRelay();
  // Posts on Home are liked, not voted; up and down votes live where a team talks about its launch.
  relay.seed({ ...LAUNCH, tags: [...LAUNCH.tags, ["team", ALICE, "member"]] });
  // The admin owns the org root; the relay only accepts a root from an admin.
  relay.seed(
    event({
      kind: 37010,
      pubkey: ADMIN,
      tags: [["d", "root"]],
      content: JSON.stringify({ name: "Org", holders: [ADMIN], scope: {} }),
    }),
  );
  const note = event({
    kind: 1,
    pubkey: ALICE,
    tags: [["a", COORD]],
    content: "Weighted post",
  });
  relay.seed(note);
  const vote = (pubkey: string, content: string) =>
    relay.seed(
      event({
        kind: 7,
        pubkey,
        tags: [
          ["e", note.id],
          ["p", ALICE],
          ["k", "1"],
        ],
        content,
      }),
    );
  vote(ADMIN, "+");
  for (const n of ["1", "2", "3", "4", "5"]) vote(n.repeat(64), "-");
  await relay.install(page);
  await signIn(page);
  await page.goto(`/launchpad/nebula?author=${FOUNDER}`);
  await page.getByRole("tab", { name: "Discussion" }).click();

  const card = page
    .getByTestId("note-card")
    .filter({ hasText: "Weighted post" });
  // The number is the plain headcount: 1 up (admin) − 5 down (newcomers). Trust only
  // changes ranking, never the figure, so no decimal can appear.
  await expect(card.getByTestId("note-vote-score")).toHaveText(/-4/);

  await card.getByTestId("note-vote-up").click();
  await expect(card.getByTestId("note-vote-up")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(card.getByTestId("note-vote-score")).toHaveText(/-3/);
  // The vote shows at once and reaches the server just after.
  await expect
    .poll(() => relay.events.find((e) => e.kind === 7 && e.pubkey === ME))
    .toBeTruthy();
  const mine = relay.events.find((e) => e.kind === 7 && e.pubkey === ME);
  expect(mine?.tags).toContainEqual(["e", note.id]);
  expect(mine?.content).toBe("+");
});

test("the founder opens the project's board on its Discussion tab; a post there is a board post and shows on Home", async ({
  page,
}) => {
  // The relay derives a new channel's metadata from its create, as the real server does.
  const relay = createMockRelay({ deriveChannels: true });
  const mine = event({
    kind: 37001,
    pubkey: ME,
    tags: [
      ["d", "orbit"],
      ["name", "Orbit"],
      ["t", "dao-launchpad"],
      ["admission", "community"],
    ],
    content: JSON.stringify({ pitch: "Round and round.", stage: "live" }),
  });
  relay.seed(mine);
  await relay.install(page);
  await signIn(page);
  await page.goto(`/launchpad/orbit?author=${ME}`);
  await page.getByRole("tab", { name: "Discussion" }).click();

  // A project from before boards has none; its founder opens it in one step.
  await page.getByTestId("discussion-open-board-button").click();
  await expect(page.getByTestId("discussion-board")).toBeVisible({
    timeout: 15_000,
  });
  const create = relay.events.find((e) => e.kind === 9007);
  const boardId = create?.tags.find((t) => t[0] === "h")?.[1] ?? "";
  expect(create?.tags).toContainEqual(["channel_type", "forum"]);
  expect(create?.tags).toContainEqual(["visibility", "open"]);
  // The record is published again naming the board, as a room it binds and in its body.
  const record = relay.events
    .filter((e) => e.kind === 37001 && e.pubkey === ME && e.id !== mine.id)
    .at(-1);
  expect(record?.tags).toContainEqual(["buzz-channel", boardId]);
  expect(JSON.parse(record?.content ?? "{}").chat?.board).toBe(boardId);

  // The founder owns the board (as the server lists it) and can edit it, but a project's board stays open to everyone:
  // who can read it is not offered.
  relay.deliver(
    event({
      kind: 39002,
      pubkey: "b".repeat(64),
      created_at: now(),
      // The server stores a roster under its board and sends it live to a subscription naming the board by `#h`.
      tags: [
        ["d", boardId],
        ["h", boardId],
        ["p", ME, "", "owner"],
      ],
    }),
  );
  await page.getByTestId("board-edit").click();
  await expect(page.getByTestId("edit-channel-visibility-fixed")).toBeVisible();
  await expect(page.getByTestId("edit-channel-visibility")).toHaveCount(0);
  await page.getByRole("button", { name: "Cancel" }).click();

  // Talk is a board post on the project's board, with the board's own composer.
  await page.getByTestId("board-new-post").click();
  await page.getByLabel("Title").fill("Which planet first?");
  await page.getByTestId("board-composer-submit").click();
  await expect(page.getByTestId("discussion-board")).toContainText(
    "Which planet first?",
  );
  const written = relay.events.find((e) => e.kind === 45001 && e.pubkey === ME);
  expect(written?.tags).toEqual([["h", boardId]]);

  // The project vote names the record's event id (the relay requires it) and its coordinate (so the vote survives
  // edits). Pressing it again takes it back.
  await page.getByTestId("launch-vote-up").click();
  await expect(page.getByTestId("launch-vote-up")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect.poll(() => relay.events.find((e) => e.kind === 7)).toBeTruthy();
  const vote = relay.events.find((e) => e.kind === 7);
  expect(vote?.tags).toEqual(
    expect.arrayContaining([
      ["e", record?.id],
      ["a", `37001:${ME}:orbit`],
    ]),
  );
  await page.getByTestId("launch-vote-up").click();
  await expect(page.getByTestId("launch-vote-up")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect
    .poll(() =>
      relay.events.some(
        (e) =>
          e.kind === 5 && e.tags.some((t) => t[0] === "e" && t[1] === vote?.id),
      ),
    )
    .toBe(true);

  // The board is a board like any other: its post shows on Home.
  await page.getByTestId("app-nav-home").click();
  await expect(page.getByText("Which planet first?")).toBeVisible({
    timeout: 15_000,
  });
});

test("notes from before the board stay readable on the Discussion tab, with no box to write in", async ({
  page,
}) => {
  const relay = createMockRelay();
  relay.seed(LAUNCH);
  const teamPost = event({
    kind: 1,
    pubkey: FOUNDER,
    tags: [["a", COORD]],
    content: "Milestone one shipped.",
  });
  relay.seed(teamPost);
  relay.seed(
    event({
      kind: 1,
      pubkey: ALICE,
      tags: [
        ["e", teamPost.id, "", "root"],
        ["p", FOUNDER],
        ["a", COORD],
      ],
      content: "Congrats!",
    }),
  );
  // A supporter's own top-level post about the launch was never part of the team's notes.
  relay.seed(
    event({
      kind: 1,
      pubkey: ALICE,
      tags: [["a", COORD]],
      content: "Loving this project.",
    }),
  );
  await relay.install(page);
  await signIn(page);
  await page.goto(`/launchpad/nebula?author=${FOUNDER}`);
  await page.getByRole("tab", { name: "Discussion" }).click();

  // Not the founder, and no board yet: said plainly, with Home as the place to post meanwhile.
  await expect(page.getByTestId("discussion-no-board")).toBeVisible();
  await expect(page.getByTestId("discussion-open-board-button")).toHaveCount(0);

  const earlier = page.getByTestId("discussion-earlier");
  await expect(earlier).toContainText("Milestone one shipped.");
  await expect(earlier).not.toContainText("Loving this project.");
  await earlier.getByTestId("note-reply").click();
  await expect(earlier.getByTestId("thread-replies")).toContainText(
    "Congrats!",
  );
  await expect(earlier.getByRole("textbox")).toHaveCount(0);
});

test("following a launch publishes a bookmark list and fills Following", async ({
  page,
}) => {
  const relay = createMockRelay();
  relay.seed(LAUNCH);
  // An existing bookmark from another client must survive the edit.
  relay.seed(event({ kind: 10003, pubkey: ME, tags: [["e", "e".repeat(64)]] }));
  await relay.install(page);
  await signIn(page);
  await page.goto("/launchpad");
  await page.getByRole("button", { name: "Follow launch" }).click();
  await expect
    .poll(
      () =>
        relay.events.filter((e) => e.kind === 10003 && e.pubkey === ME).length,
    )
    .toBe(2);
  const latest = relay.events.filter((e) => e.kind === 10003).at(-1);
  expect(latest?.tags).toEqual([
    ["e", "e".repeat(64)],
    ["a", COORD],
  ]);
  await page.getByRole("tab", { name: "Following" }).click();
  await expect(page.getByText("Nebula DAO")).toBeVisible();
});

test("launches followed in the old browser-only list move into bookmarks once", async ({
  page,
}) => {
  const relay = createMockRelay();
  relay.seed(LAUNCH);
  await relay.install(page);
  await signIn(page);
  await page.addInitScript((key) => {
    window.localStorage.setItem(
      "buzz.launchpad.followed",
      JSON.stringify([key]),
    );
  }, `${FOUNDER}:nebula`);
  await page.goto("/launchpad");
  await expect
    .poll(() => relay.events.find((e) => e.kind === 10003)?.tags)
    .toEqual([["a", COORD]]);
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.localStorage.getItem("buzz.launchpad.followed"),
      ),
    )
    .toBeNull();
});

test("posts are only copied to public relays when the author opts in", async ({
  page,
}) => {
  const relay = createMockRelay();
  await relay.install(page);
  const publicSockets: string[] = [];
  await page.routeWebSocket(/relay\.damus\.io|nos\.lol/, (ws) => {
    publicSockets.push(ws.url());
    ws.close();
  });
  await signIn(page);
  await page.goto("/");

  await page.getByTestId("social-composer-input").fill("Only here");
  await page.getByTestId("social-composer-submit").click();
  await expect(
    page.getByTestId("social-post").filter({ hasText: "Only here" }),
  ).toBeVisible();
  expect(publicSockets).toEqual([]);

  await page.getByTestId("social-composer-mirror").check();
  await page.getByTestId("social-composer-input").fill("Everywhere");
  await page.getByTestId("social-composer-submit").click();
  await expect.poll(() => publicSockets.length).toBe(2);
});

test("the launch page's follow star is saved, not forgotten on navigation", async ({
  page,
}) => {
  // Regression: the star was component state only, so it reset on every visit.
  const relay = createMockRelay();
  relay.seed(LAUNCH);
  await relay.install(page);
  await signIn(page);
  await page.goto(`/launchpad/nebula?author=${FOUNDER}`);
  const star = page.getByTestId("launch-follow");
  await star.click();
  await expect
    .poll(() => relay.events.find((e) => e.kind === 10003)?.tags)
    .toEqual([["a", COORD]]);
  await page.getByTestId("app-nav-home").click();
  await page.goBack();
  await expect(page.getByTestId("launch-follow")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});
