import { expect, test, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as nip44 from "nostr-tools/nip44";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";

import { openGiftWrap } from "../../src/features/social/lib/nip17.ts";
import { keyFromHex, post, readAs, waitForEvents } from "./social-helpers.mjs";

/**
 * The social section against a real relay: real NIP-42 auth, real ingest, real
 * Postgres reads. Each test makes its own posts (with a run id in the text) so
 * it does not depend on what earlier tests or runs left behind, and checks what
 * the relay *stored* — tags, encryption, authors — not just what the page shows.
 *
 * Setup: see README.md, then `node --experimental-strip-types
 * tests/e2e-real/seed-social.mjs` for the people, follows and the DM.
 */

interface Fixture {
  relay: string;
  people: Record<"dev" | "alice" | "bob" | "carol", string>;
  nsecs: Record<"dev" | "alice" | "bob" | "carol", string>;
  notes: Record<string, string>;
}

function fixtureOrSkip(): Fixture {
  const path = join(
    dirname(fileURLToPath(import.meta.url)),
    ".social-fixture.json",
  );
  if (!existsSync(path)) {
    test.skip(
      true,
      "run `node --experimental-strip-types tests/e2e-real/seed-social.mjs` (see README.md)",
    );
  }
  return JSON.parse(readFileSync(path, "utf8")) as Fixture;
}

test.use({ viewport: { width: 1360, height: 900 } });

const RUN = Date.now().toString(36);
const unique = (label: string) =>
  `${label} ${RUN}-${Math.random().toString(36).slice(2, 6)}`;

async function signInAsDev(page: Page, fixture: Fixture) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(
    ([nsec]) => window.localStorage.setItem("buzz.identity.nsec", nsec),
    [fixture.nsecs.dev],
  );
  return errors;
}

const postCard = (page: Page, text: string) =>
  page.getByTestId("social-post").filter({ hasText: text }).first();

/** The feed pages as you scroll; an old seeded post may be several pages down. */
async function scrollUntilVisible(page: Page, text: string) {
  for (let i = 0; i < 25; i += 1) {
    if (await postCard(page, text).isVisible()) return;
    await page.getByTestId("social-shell").evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await page.waitForTimeout(400);
  }
}

test("the Creaton feed shows every post on the relay, including reposts", async ({
  page,
}) => {
  const fixture = fixtureOrSkip();
  const errors = await signInAsDev(page, fixture);
  await page.goto("/social");
  await expect(page.getByTestId("social-shell")).toBeVisible({
    timeout: 20_000,
  });
  for (const text of [
    "Shipping the first Creaton social feed today.",
    "Maintainer life: 40 open issues",
    "Testing the Creaton feed from a real relay.",
  ]) {
    await scrollUntilVisible(page, text);
    await expect(postCard(page, text)).toBeVisible({ timeout: 20_000 });
  }
  // Carol's repost of Alice's launch post shows who reposted it.
  await expect(page.getByTestId("social-reposted-by").first()).toContainText(
    "Carol Coder reposted",
  );
  // A reply is not a top-level post, so it is not in the main timeline.
  await expect(postCard(page, "Congrats Alice, this looks great!")).toHaveCount(
    0,
  );
  expect(errors, errors.join(" | ")).toEqual([]);
});

test("Following shows the people you follow and nobody else", async ({
  page,
}) => {
  const fixture = fixtureOrSkip();
  await signInAsDev(page, fixture);
  await page.goto("/social");
  await page.getByTestId("social-tab-following").click();
  // Dev follows Alice (and sees their own posts). The seeded posts may be a few
  // pages down once earlier runs have added more.
  await scrollUntilVisible(
    page,
    "Shipping the first Creaton social feed today.",
  );
  await scrollUntilVisible(page, "Testing the Creaton feed from a real relay.");
  await expect(
    postCard(page, "Shipping the first Creaton social feed today."),
  ).toBeVisible({
    timeout: 20_000,
  });
  await expect(
    postCard(page, "Testing the Creaton feed from a real relay."),
  ).toBeVisible();
  // Carol's post and Bob's mention are not from anyone Dev follows.
  await expect(postCard(page, "Maintainer life: 40 open issues")).toHaveCount(
    0,
  );
  await expect(postCard(page, "want to review this?")).toHaveCount(0);
});

test("a post with a hashtag and a mention is stored with the right tags and findable", async ({
  page,
}) => {
  test.slow();
  const fixture = fixtureOrSkip();
  await signInAsDev(page, fixture);
  await page.goto("/social");
  const tag = `tag${RUN}`;
  const input = page.getByTestId("social-composer-input");
  await input.click();
  await input.pressSequentially("hello @Alic");
  // Mentions autocomplete from the people you follow.
  const option = page.getByRole("option", { name: /Alice Archer/ });
  await expect(option).toBeVisible({ timeout: 15_000 });
  await option.click();
  await input.pressSequentially(`welcome to #${tag}`);
  await page.getByTestId("social-composer-submit").click();

  await expect(postCard(page, `#${tag}`)).toBeVisible({ timeout: 20_000 });

  const stored = await waitForEvents("dev", {
    kinds: [1],
    authors: [fixture.people.dev],
    "#t": [tag],
  });
  expect(stored[0].tags).toEqual(
    expect.arrayContaining([
      ["t", tag],
      ["p", fixture.people.alice],
    ]),
  );
  expect(stored[0].content).toContain("nostr:npub1");

  // It survives a reload and is on the hashtag page.
  await page.goto(`/social/tag/${tag}`);
  await expect(postCard(page, `#${tag}`)).toBeVisible({ timeout: 20_000 });
  // The mention renders as the person's name, linked to their profile.
  await expect(
    postCard(page, `#${tag}`).getByRole("link", { name: "@Alice Archer" }),
  ).toBeVisible();
});

test("a like is stored and still shown after a reload", async ({ page }) => {
  test.slow();
  const fixture = fixtureOrSkip();
  const text = unique("like me");
  const note = await post("carol", { kind: 1, tags: [], content: text });
  await signInAsDev(page, fixture);
  await page.goto("/social");
  const card = postCard(page, text);
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.getByTestId("social-like").click();
  await expect(card.getByTestId("social-like")).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  const likes = await waitForEvents("dev", {
    kinds: [7],
    authors: [fixture.people.dev],
    "#e": [note.id],
  });
  expect(likes[0].content).toBe("+");
  expect(likes[0].tags).toEqual(
    expect.arrayContaining([
      ["e", note.id],
      ["p", fixture.people.carol],
    ]),
  );

  await page.reload();
  const again = postCard(page, text);
  await expect(again.getByTestId("social-like")).toHaveAttribute(
    "aria-pressed",
    "true",
    { timeout: 20_000 },
  );
  await expect(again.getByTestId("social-like")).toContainText("1");
});

test("replying from the thread page stores NIP-10 reply tags and shows the conversation", async ({
  page,
}) => {
  test.slow();
  const fixture = fixtureOrSkip();
  const rootText = unique("thread root");
  const root = await post("alice", { kind: 1, tags: [], content: rootText });
  await signInAsDev(page, fixture);
  await page.goto(`/social/post/${root.id}`);
  await expect(postCard(page, rootText)).toBeVisible({ timeout: 20_000 });

  const reply = unique("my reply");
  await page.getByTestId("social-reply-composer-input").fill(reply);
  await page.getByTestId("social-reply-composer-submit").click();
  await expect(postCard(page, reply)).toBeVisible({ timeout: 20_000 });

  const stored = await waitForEvents("dev", {
    kinds: [1],
    authors: [fixture.people.dev],
    "#e": [root.id],
  });
  expect(stored[0].tags).toEqual(
    expect.arrayContaining([
      ["e", root.id, "", "root"],
      ["p", fixture.people.alice],
    ]),
  );

  await page.reload();
  await expect(postCard(page, reply)).toBeVisible({ timeout: 20_000 });
  // Opening the reply shows the post above it.
  await page.goto(`/social/post/${(stored[0] as { id: string }).id}`);
  await expect(postCard(page, rootText)).toBeVisible({ timeout: 20_000 });
  await expect(postCard(page, reply)).toBeVisible();
});

test("a repost shows on your timeline and can be undone", async ({ page }) => {
  test.slow();
  const fixture = fixtureOrSkip();
  const text = unique("repost me");
  const note = await post("bob", { kind: 1, tags: [], content: text });
  await signInAsDev(page, fixture);
  await page.goto("/social");
  const card = postCard(page, text);
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.getByTestId("social-repost").click();
  await card.getByTestId("social-repost-confirm").click();

  const reposts = await waitForEvents("dev", {
    kinds: [6],
    authors: [fixture.people.dev],
    "#e": [note.id],
  });
  expect(reposts[0].tags).toEqual(
    expect.arrayContaining([
      ["e", note.id],
      ["p", fixture.people.bob],
    ]),
  );
  // The original is embedded so other clients can show it without a lookup.
  expect(JSON.parse(reposts[0].content).id).toBe(note.id);

  await page.goto("/social");
  await expect(
    page
      .getByTestId("social-post")
      .filter({ hasText: text })
      .first()
      .getByTestId("social-reposted-by"),
  ).toContainText("You reposted", { timeout: 20_000 });

  // Undo: the repost is deleted from the relay and the marker goes away.
  const row = postCard(page, text);
  await row.getByTestId("social-repost").click();
  await expect(row.getByTestId("social-repost-confirm")).toContainText(
    "Undo repost",
  );
  await row.getByTestId("social-repost-confirm").click();
  await expect
    .poll(
      async () =>
        (
          await readAs("dev", {
            kinds: [6],
            authors: [fixture.people.dev],
            "#e": [note.id],
          })
        ).length,
      {
        timeout: 20_000,
      },
    )
    .toBe(0);
});

test("a quote post carries a q tag and shows the quoted post as a card", async ({
  page,
}) => {
  test.slow();
  const fixture = fixtureOrSkip();
  const original = unique("quote this");
  const note = await post("carol", { kind: 1, tags: [], content: original });
  await signInAsDev(page, fixture);
  await page.goto("/social");
  const card = postCard(page, original);
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.getByTestId("social-repost").click();
  await card.getByTestId("social-quote").click();

  const comment = unique("my take");
  await page.getByTestId("social-quote-composer-input").fill(comment);
  await page.getByTestId("social-quote-composer-submit").click();

  const stored = await waitForEvents("dev", {
    kinds: [1],
    authors: [fixture.people.dev],
    "#q": [note.id],
  });
  expect(stored[0].tags).toEqual(
    expect.arrayContaining([["q", note.id, "", fixture.people.carol]]),
  );
  expect(stored[0].content).toContain("nostr:nevent1");

  await page.goto("/social");
  const quote = postCard(page, comment);
  await expect(quote).toBeVisible({ timeout: 20_000 });
  await expect(quote.getByTestId("social-quote-card")).toContainText(original);
});

test("bookmarks are private: stored encrypted, listed after a reload", async ({
  page,
}) => {
  test.slow();
  const fixture = fixtureOrSkip();
  const text = unique("save me");
  const note = await post("alice", { kind: 1, tags: [], content: text });
  await signInAsDev(page, fixture);
  await page.goto("/social");
  const card = postCard(page, text);
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.getByTestId("social-bookmark").click();
  await expect(card.getByTestId("social-bookmark")).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  const [list] = await waitForEvents("dev", {
    kinds: [10003],
    authors: [fixture.people.dev],
  });
  // Nothing in the public tags or plain content reveals what was saved...
  expect(JSON.stringify(list.tags)).not.toContain(note.id);
  expect(list.content).not.toContain(note.id);
  expect(list.content.length).toBeGreaterThan(0);
  // ...but the owner can read it.
  const key = keyFromHex(fixture.nsecs.dev);
  const private_ = nip44.decrypt(
    list.content,
    nip44.getConversationKey(key, getPublicKey(key)),
  );
  expect(private_).toContain(note.id);

  await page.goto("/social/bookmarks");
  await expect(postCard(page, text)).toBeVisible({ timeout: 20_000 });
});

test("notifications list likes, replies, mentions and follows with an unread badge", async ({
  page,
}) => {
  const fixture = fixtureOrSkip();
  await signInAsDev(page, fixture);
  await page.goto("/social");
  await expect(page.getByTestId("social-unread").first()).toBeVisible({
    timeout: 20_000,
  });

  await page.goto("/social/notifications");
  const kinds = page.getByTestId("social-notification");
  await expect(kinds.first()).toBeVisible({ timeout: 20_000 });
  // Rows fill in as the posts and profiles they mention arrive.
  const shell = page.getByTestId("social-shell");
  await expect(shell).toContainText("liked your post", { timeout: 20_000 });
  await expect(shell).toContainText("replied to you", { timeout: 20_000 });
  await expect(shell).toContainText("mentioned you", { timeout: 20_000 });
  await expect(shell).toContainText("followed you", { timeout: 20_000 });
  // Likes on the same post collapse into one row.
  await expect(page.locator('[data-kind="like"]')).toHaveCount(1);
  await expect(page.locator('[data-kind="like"]')).toContainText("and 1 other");

  // Viewing them clears the badge, and it stays cleared after a reload.
  await page.goto("/social");
  await expect(page.getByTestId("social-unread")).toHaveCount(0, {
    timeout: 20_000,
  });
});

test("Explore surfaces trending posts, people to follow and hashtags", async ({
  page,
}) => {
  const fixture = fixtureOrSkip();
  await signInAsDev(page, fixture);
  await page.goto("/social/explore");
  // Alice's first post has the most likes and replies.
  await expect(
    postCard(page, "Shipping the first Creaton social feed today."),
  ).toBeVisible({
    timeout: 20_000,
  });
  await page.getByTestId("social-tab-people").click();
  await expect(page.getByTestId("social-people-list")).toContainText(
    "Carol Coder",
  );
  await page.getByTestId("social-tab-hashtags").click();
  await expect(page.getByTestId("social-hashtag-list")).toContainText(
    "#creaton",
  );
});

test("search finds people by name and recent posts by text", async ({
  page,
}) => {
  const fixture = fixtureOrSkip();
  await signInAsDev(page, fixture);
  await page.goto("/social/search?q=whiteboard");
  await expect(postCard(page, "A picture of the whiteboard")).toBeVisible({
    timeout: 20_000,
  });
  await page.goto("/social/search?q=Archer");
  await page.getByTestId("social-tab-people").click();
  await expect(page.getByTestId("social-search-people")).toContainText(
    "Alice Archer",
    {
      timeout: 20_000,
    },
  );
});

test("a profile shows counts and tabs; following and unfollowing is stored", async ({
  page,
}) => {
  test.slow();
  const fixture = fixtureOrSkip();
  await signInAsDev(page, fixture);
  await page.goto(`/u/${fixture.people.carol}`);
  await expect(
    page.getByRole("heading", { name: "Carol Coder" }).first(),
  ).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("profile-followers-count")).toContainText("1");
  await expect(page.getByTestId("profile-following-count")).toContainText("2");

  // Follow Carol: the relay's newest contact list for Dev now has her, and keeps Alice.
  await page.getByTestId("profile-follow").click();
  await expect
    .poll(
      async () => {
        const lists = await readAs("dev", {
          kinds: [3],
          authors: [fixture.people.dev],
        });
        const newest = lists.sort(
          (a: { created_at: number }, b: { created_at: number }) =>
            b.created_at - a.created_at,
        )[0];
        return newest?.tags.map((t: string[]) => t[1]).sort();
      },
      { timeout: 20_000 },
    )
    .toEqual([fixture.people.alice, fixture.people.carol].sort());

  // Unfollow: back to only Alice (keeps the fixture clean for other tests).
  await expect(page.getByTestId("profile-follow")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByTestId("profile-follow").click();
  await expect
    .poll(
      async () => {
        const lists = await readAs("dev", {
          kinds: [3],
          authors: [fixture.people.dev],
        });
        const newest = lists.sort(
          (a: { created_at: number }, b: { created_at: number }) =>
            b.created_at - a.created_at,
        )[0];
        return newest?.tags.map((t: string[]) => t[1]);
      },
      { timeout: 20_000 },
    )
    .toEqual([fixture.people.alice]);

  for (const tab of ["replies", "media", "likes"]) {
    await page.getByTestId(`social-tab-${tab}`).click();
  }
  await page.getByTestId("social-tab-posts").click();
  await expect(postCard(page, "Maintainer life: 40 open issues")).toBeVisible({
    timeout: 20_000,
  });
});

test("editing your profile keeps the fields the form does not show", async ({
  page,
}) => {
  test.slow();
  const fixture = fixtureOrSkip();
  // A field the form has no input for must survive an edit.
  await post("dev", {
    kind: 0,
    tags: [],
    content: JSON.stringify({
      name: "dev",
      display_name: "Dev Tester",
      about: "before",
      lud16: "dev@example.com",
    }),
  });
  await signInAsDev(page, fixture);
  await page.goto(`/u/${fixture.people.dev}`);
  await page.getByTestId("profile-edit").click();
  const about = unique("about me");
  await page.getByLabel("Bio").fill(about);
  await page.getByTestId("social-edit-profile-save").click();

  await expect
    .poll(
      async () => {
        const events = await readAs("dev", {
          kinds: [0],
          authors: [fixture.people.dev],
        });
        const newest = events.sort(
          (a: { created_at: number }, b: { created_at: number }) =>
            b.created_at - a.created_at,
        )[0];
        return newest ? JSON.parse(newest.content) : null;
      },
      { timeout: 20_000 },
    )
    .toMatchObject({
      about,
      lud16: "dev@example.com",
      display_name: "Dev Tester",
    });

  await page.reload();
  // `getByText` also matches a textarea's value, so read rendered text instead.
  await expect
    .poll(() => page.getByTestId("social-shell").innerText(), {
      timeout: 20_000,
    })
    .toContain(about);
});

test("muting someone hides their posts from your timelines", async ({
  page,
}) => {
  test.slow();
  const fixture = fixtureOrSkip();
  const text = unique("mute test");
  await post("carol", { kind: 1, tags: [], content: text });
  await signInAsDev(page, fixture);
  await page.goto("/social");
  await expect(postCard(page, text)).toBeVisible({ timeout: 20_000 });

  await page.goto(`/u/${fixture.people.carol}`);
  await page.getByTestId("profile-mute").click();
  // Wait for the relay to hold a mute list that actually names Carol.
  await expect
    .poll(
      async () => {
        const lists = await readAs("dev", {
          kinds: [10000],
          authors: [fixture.people.dev],
        });
        const newest = lists.sort(
          (a: { created_at: number }, b: { created_at: number }) =>
            b.created_at - a.created_at,
        )[0];
        return newest?.tags.some(
          (t: string[]) => t[1] === fixture.people.carol,
        );
      },
      { timeout: 20_000 },
    )
    .toBe(true);

  await page.goto("/social");
  await expect(page.getByTestId("social-post-list")).toBeVisible({
    timeout: 20_000,
  });
  await expect(postCard(page, text)).toHaveCount(0);

  // Unmute so later runs see Carol again — and wait for the relay to hold it,
  // because leaving the page first would abandon the write.
  await page.goto(`/u/${fixture.people.carol}`);
  await page.getByTestId("profile-mute").click();
  await expect
    .poll(
      async () => {
        const lists = await readAs("dev", {
          kinds: [10000],
          authors: [fixture.people.dev],
        });
        const newest = lists.sort(
          (a: { created_at: number }, b: { created_at: number }) =>
            b.created_at - a.created_at,
        )[0];
        return newest?.tags.some(
          (t: string[]) => t[1] === fixture.people.carol,
        );
      },
      { timeout: 20_000 },
    )
    .toBe(false);
  await page.goto("/social");
  await expect(postCard(page, text)).toBeVisible({ timeout: 20_000 });
});

test("direct messages are end-to-end encrypted and readable by another client", async ({
  page,
}) => {
  test.slow();
  const fixture = fixtureOrSkip();
  await signInAsDev(page, fixture);
  await page.goto("/social/messages");
  // The seeded encrypted message from Alice is opened in the browser. (Earlier
  // runs may have added replies, so look in the thread, not the list preview.)
  await expect(page.getByTestId("social-conversation").first()).toContainText(
    "Alice Archer",
    { timeout: 20_000 },
  );
  await page.getByTestId("social-conversation").first().click();
  await expect(
    page
      .getByTestId("social-message")
      .filter({ hasText: "this message is end-to-end encrypted" }),
  ).toBeVisible({ timeout: 20_000 });

  const reply = unique("pong");
  await page.getByTestId("social-message-input").fill(reply);
  await page.getByTestId("social-message-send").click();
  await expect(
    page.getByTestId("social-message").filter({ hasText: reply }),
  ).toBeVisible({ timeout: 20_000 });

  // What the relay stored for Alice is a gift wrap from a throwaway key — it never
  // names Dev, and the text is not in it...
  const wraps = (await waitForEvents(
    "alice",
    { kinds: [1059], "#p": [fixture.people.alice] },
    2,
  )) as {
    id: string;
    pubkey: string;
    kind: number;
    content: string;
    tags: string[][];
    created_at: number;
    sig: string;
  }[];
  for (const wrap of wraps) {
    expect(wrap.pubkey).not.toBe(fixture.people.dev);
    expect(wrap.content).not.toContain(reply);
  }
  // ...but Alice (any NIP-17 client holding her key) can open it.
  const aliceKey = keyFromHex(fixture.nsecs.alice);
  const aliceSigner = {
    pubkey: fixture.people.alice,
    sign: async (t: object) =>
      finalizeEvent(
        {
          created_at: Math.floor(Date.now() / 1000),
          ...(t as { kind: number; tags: string[][]; content: string }),
        },
        aliceKey,
      ),
    encrypt: async (peer: string, text: string) =>
      nip44.encrypt(text, nip44.getConversationKey(aliceKey, peer)),
    decrypt: async (peer: string, text: string) =>
      nip44.decrypt(text, nip44.getConversationKey(aliceKey, peer)),
  };
  const opened = (
    await Promise.all(wraps.map((w) => openGiftWrap(aliceSigner, w as never)))
  ).filter(Boolean);
  expect(opened.map((m) => m?.content)).toContain(reply);

  await page.reload();
  await expect(
    page.getByTestId("social-message").filter({ hasText: reply }),
  ).toBeVisible({ timeout: 20_000 });
});

const LAUNCH_LABEL = ["l", "launch-update", "creaton.launch"];

test("launch mode: the team's update is stored as a normal note, marked and shown in Updates; a stranger's mark does nothing", async ({
  page,
}) => {
  test.slow();
  const fixture = fixtureOrSkip();
  await signInAsDev(page, fixture);
  const quartz = `37001:${fixture.people.dev}:quartz-hardware`;
  const nebula = `37001:${fixture.people.alice}:nebula-dao`;

  // A stranger copies the label onto a post about Alice's launch…
  const fake = unique("fake update");
  await post("bob", {
    kind: 1,
    tags: [["a", nebula], LAUNCH_LABEL],
    content: fake,
  });

  await page.goto("/social");
  await expect(page.getByTestId("social-composer-launch-mode")).toBeVisible({
    timeout: 20_000,
  });
  const text = unique("Quartz batch two ships");
  await page.getByTestId("social-composer-input").fill(text);
  await page.getByTestId("social-composer-launch-mode").check();
  await page.getByTestId("social-composer-submit").click();

  // What the relay stored is a plain kind 1 note naming the launch + the label.
  let stored: { kind: number; tags: string[][]; content: string } | undefined;
  for (let i = 0; i < 30 && !stored; i += 1) {
    const mine = await readAs("dev", {
      kinds: [1],
      authors: [fixture.people.dev],
      limit: 30,
    });
    stored = mine.find((e: { content: string }) => e.content.includes(text));
    if (!stored) await new Promise((r) => setTimeout(r, 500));
  }
  if (!stored) throw new Error("the relay never stored the launch update");
  expect(stored.kind).toBe(1);
  expect(stored.tags).toContainEqual(["a", quartz]);
  expect(stored.tags).toContainEqual(LAUNCH_LABEL);

  await page.getByRole("tab", { name: "Launch Updates" }).click();
  const card = postCard(page, text);
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card.getByTestId("social-launch-update")).toBeVisible();
  // …and the stranger's marked post is not an update.
  await expect(postCard(page, fake)).toHaveCount(0);
});

test("a priority update from a launch you follow lands in notifications, and can be turned off", async ({
  page,
}) => {
  test.slow();
  const fixture = fixtureOrSkip();
  await signInAsDev(page, fixture);
  // A launch of its own per run: priority updates are rationed per launch per
  // week, so reusing one would stop being priority after a few runs.
  const launchId = `nebula-${RUN}`;
  const nebula = `37001:${fixture.people.alice}:${launchId}`;
  await post("alice", {
    kind: 37001,
    tags: [
      ["d", launchId],
      ["name", `Nebula ${RUN}`],
      ["t", "dao-launchpad"],
      ["admission", "curated"],
    ],
    content: JSON.stringify({
      pitch: "A fresh launch for this run.",
      stage: "funding",
    }),
  });

  // Dev follows Nebula (a bookmark-list `a` tag, keeping what is already there).
  const lists = await readAs("dev", {
    kinds: [10003],
    authors: [fixture.people.dev],
    limit: 5,
  });
  const current = lists.sort(
    (a: { created_at: number }, b: { created_at: number }) =>
      b.created_at - a.created_at,
  )[0];
  const tags: string[][] = current?.tags ?? [];
  if (!tags.some((t) => t[0] === "a" && t[1] === nebula)) {
    await post("dev", {
      kind: 10003,
      created_at: Math.max(
        Math.floor(Date.now() / 1000),
        (current?.created_at ?? 0) + 1,
      ),
      tags: [...tags, ["a", nebula]],
      content: current?.content ?? "",
    });
  }

  // Alice, the founder, posts an official update.
  const text = unique("Nebula beta is open");
  await post("alice", {
    kind: 1,
    tags: [["a", nebula], LAUNCH_LABEL],
    content: text,
  });

  await page.goto("/social/notifications");
  const section = page.getByTestId("social-launch-updates");
  await expect(section).toContainText(text, { timeout: 30_000 });
  await expect(
    section.getByTestId("social-launch-update").first(),
  ).toBeVisible();

  // Turning the launch's priority updates off removes them without unfollowing.
  await section.getByTestId("social-launch-update-mute").first().click();
  await expect(page.getByTestId("social-launch-updates")).toHaveCount(0);
});

test("you can delete your own post; other people's posts have no delete button", async ({
  page,
}) => {
  test.slow();
  const fixture = fixtureOrSkip();
  await signInAsDev(page, fixture);
  const mine = unique("delete me");
  const theirs = unique("not mine");
  await post("carol", { kind: 1, tags: [], content: theirs });

  await page.goto("/social");
  await page.getByTestId("social-composer-input").fill(mine);
  await page.getByTestId("social-composer-submit").click();
  const card = postCard(page, mine);
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(postCard(page, theirs)).toBeVisible({ timeout: 20_000 });
  await expect(postCard(page, theirs).getByTestId("social-delete")).toHaveCount(
    0,
  );

  const stored = await waitForEvents("dev", {
    kinds: [1],
    authors: [fixture.people.dev],
    limit: 50,
  });
  const event = stored.find((e: { content: string }) => e.content === mine);
  expect(event).toBeTruthy();

  await card.getByTestId("social-delete").click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(postCard(page, mine)).toHaveCount(0);

  // The relay honoured the NIP-09 request: the note is gone for everyone.
  for (let i = 0; i < 20; i += 1) {
    const left = await readAs("carol", { ids: [event.id], kinds: [1] });
    if (left.length === 0) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("the relay still serves the deleted post");
});

test("launch chat: the founder creates the rooms, a backer is admitted with one click", async ({
  page,
}) => {
  test.slow();
  const fixture = fixtureOrSkip();
  const errors = await signInAsDev(page, fixture);
  // A launch of the dev's own, published without rooms.
  const launchId = `chat-${RUN}`;
  await post("dev", {
    kind: 37001,
    tags: [
      ["d", launchId],
      ["name", `Chat launch ${RUN}`],
      ["t", "dao-launchpad"],
      ["admission", "curated"],
    ],
    content: JSON.stringify({
      pitch: "A launch to talk about.",
      stage: "funding",
    }),
  });

  await page.goto(`/launchpad/${launchId}?author=${fixture.people.dev}`);
  await page.getByTestId("launch-chat-create").click();
  await expect(page.getByTestId("launch-chat")).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByTestId("launch-chat-open")).toBeVisible();

  // The record names both rooms, and the relay holds them as private channels.
  const stored = await waitForEvents("dev", {
    kinds: [37001],
    authors: [fixture.people.dev],
    "#d": [launchId],
  });
  const record = stored.sort(
    (a: { created_at: number }, b: { created_at: number }) =>
      b.created_at - a.created_at,
  )[0];
  const chat = JSON.parse(record.content).chat as {
    team: string;
    supporters: string;
  };
  expect(chat.team).toMatch(/^[0-9a-f-]{36}$/);
  expect(chat.supporters).toMatch(/^[0-9a-f-]{36}$/);
  const bound = record.tags
    .filter((t: string[]) => t[0] === "buzz-channel")
    .map((t: string[]) => t[1]);
  expect(bound.sort()).toEqual([chat.team, chat.supporters].sort());

  // Alice is not in the room, so she cannot see it.
  const before = await readAs("alice", {
    kinds: [39000],
    "#d": [chat.supporters],
  });
  expect(before).toHaveLength(0);

  // She records a bid, and the founder sees her waiting.
  await post("alice", {
    kind: 47002,
    tags: [
      ["a", `37001:${fixture.people.dev}:${launchId}`],
      ["m", "bucket-1"],
    ],
    content: JSON.stringify({ budget: "1000000" }),
  });
  await page.reload();
  await expect(page.getByTestId("launch-chat-admit")).toBeVisible({
    timeout: 30_000,
  });
  await page.getByTestId("launch-chat-admit-button").click();
  await expect(page.getByTestId("launch-chat-admit")).toHaveCount(0, {
    timeout: 30_000,
  });

  // The relay now lets her see the supporters room, but not the team room.
  const after = await waitForEvents("alice", {
    kinds: [39000],
    "#d": [chat.supporters],
  });
  expect(after).toHaveLength(1);
  const teamRoom = await readAs("alice", {
    kinds: [39000],
    "#d": [chat.team],
  });
  expect(teamRoom).toHaveLength(0);
  expect(errors, errors.join(" | ")).toEqual([]);
});
