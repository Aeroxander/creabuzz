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

  await page.getByTestId("composer-input").fill("Shipping the #agents MVP");
  await page.getByTestId("composer-submit").click();
  const card = page.getByTestId("note-card").filter({ hasText: "MVP" });
  await expect(card).toBeVisible();
  const post = relay.events.find((e) => e.kind === 1);
  expect(post?.tags).toContainEqual(["t", "agents"]);
  expect(post?.tags.some((t) => t[0] === "h")).toBe(false);

  await card.getByTestId("note-reply").click();
  await page.getByTestId("reply-composer-input").fill("Congrats!");
  await page.getByTestId("reply-composer-submit").click();
  await expect(page.getByTestId("thread-replies")).toContainText("Congrats!");
  await expect(card.getByTestId("note-reply")).toHaveText("1 reply");
  const reply = relay.events.find(
    (e) => e.kind === 1 && e.content === "Congrats!",
  );
  expect(reply?.tags).toContainEqual(["e", post?.id, "", "root"]);
});

test("votes are trust-weighted: an org admin outweighs a swarm of new keys", async ({
  page,
}) => {
  const relay = createMockRelay();
  // The admin owns the org root; the relay only accepts a root from an admin.
  relay.seed(
    event({
      kind: 37010,
      pubkey: ADMIN,
      tags: [["d", "root"]],
      content: JSON.stringify({ name: "Org", holders: [ADMIN], scope: {} }),
    }),
  );
  const note = event({ kind: 1, pubkey: ALICE, content: "Weighted post" });
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
  await page.goto("/");

  const card = page
    .getByTestId("note-card")
    .filter({ hasText: "Weighted post" });
  // 2 (admin) − 5 × 0.2 (newcomers) = 1.
  await expect(card.getByTestId("note-vote-score")).toContainText("1");
  await expect(card.getByTestId("note-vote-down")).toHaveAttribute(
    "title",
    "5 downvotes",
  );

  await card.getByTestId("note-vote-up").click();
  await expect(card.getByTestId("note-vote-up")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(card.getByTestId("note-vote-score")).toContainText("1.2");
  const mine = relay.events.find((e) => e.kind === 7 && e.pubkey === ME);
  expect(mine?.tags).toContainEqual(["e", note.id]);
  expect(mine?.content).toBe("+");
});

test("a launch's discussion is posted with its coordinate and shows on Home", async ({
  page,
}) => {
  const relay = createMockRelay();
  // The team posts to a launch's own feed; this viewer is on the team.
  relay.seed({ ...LAUNCH, tags: [...LAUNCH.tags, ["team", ME, "member"]] });
  await relay.install(page);
  await signIn(page);
  await page.goto(`/launchpad/nebula?author=${FOUNDER}`);
  await page.getByRole("tab", { name: "Discussion" }).click();
  await expect(page.getByTestId("discussion-empty")).toBeVisible();

  await page.getByTestId("launch-composer-input").fill("Backing this one.");
  await page.getByTestId("launch-composer-submit").click();
  await expect(page.getByTestId("discussion-list")).toContainText(
    "Backing this one.",
  );
  const post = relay.events.find((e) => e.kind === 1);
  expect(post?.tags).toContainEqual(["a", COORD]);
  expect(post?.content).toMatch(/nostr:naddr1/);

  // The launch vote names the record's event id (the relay requires it) and
  // its coordinate (so the vote survives edits).
  await page.getByTestId("launch-vote-up").click();
  await expect(page.getByTestId("launch-vote-up")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const vote = relay.events.find((e) => e.kind === 7);
  expect(vote?.tags).toEqual(
    expect.arrayContaining([
      ["e", LAUNCH.id],
      ["a", COORD],
    ]),
  );

  await page.getByTestId("app-nav-home").click();
  const card = page
    .getByTestId("note-card")
    .filter({ hasText: "Backing this one." });
  await expect(card.getByTestId("note-launch")).toHaveText("Nebula DAO");
  await expect(page.getByTestId("trending-launches")).toContainText(
    "Nebula DAO",
  );
});

test("on a launch's feed only the team posts; everyone can reply", async ({
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
  // A supporter's own top-level post about the launch is not in the team feed…
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

  const list = page.getByTestId("discussion-list");
  await expect(list).toContainText("Milestone one shipped.");
  await expect(list).not.toContainText("Loving this project.");
  // …and a non-team viewer gets no top-level composer, only the pointer.
  await expect(page.getByTestId("launch-composer")).toHaveCount(0);
  await expect(page.getByTestId("launch-team-only")).toBeVisible();

  // Replying to the team's post is open to everyone.
  await list.getByTestId("note-reply").first().click();
  await page.getByTestId("reply-composer-input").fill("Congrats!");
  await page.getByTestId("reply-composer-submit").click();
  await expect(page.getByTestId("thread-replies")).toContainText("Congrats!");
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

  await page.getByTestId("composer-input").fill("Only here");
  await page.getByTestId("composer-submit").click();
  await expect(
    page.getByTestId("note-card").filter({ hasText: "Only here" }),
  ).toBeVisible();
  expect(publicSockets).toEqual([]);

  await page.getByTestId("composer-mirror").check();
  await page.getByTestId("composer-input").fill("Everywhere");
  await page.getByTestId("composer-submit").click();
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
