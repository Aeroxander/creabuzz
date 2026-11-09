import { expect, type Page, test } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";

import { createMockRelay } from "./mock-relay";

/**
 * The right rail on Home: the newest projects, trending posts, hashtags and people to follow, each a short list that
 * ends in a "See all" to its full page. The rail is one complementary landmark, below the feed on narrower screens
 * (never dropped), and the old Explore address still opens. The list rules are pinned in
 * `src/features/social/lib/rail.test.mjs`; this runs them on the real page.
 */

const NSEC = "79".repeat(32);
const ME = getPublicKey(
  Uint8Array.from(NSEC.match(/.{2}/g) ?? [], (b) => Number.parseInt(b, 16)),
);
const ALICE = "e".repeat(64);
const BOB = "b0".repeat(32);
const CAROL = "c0".repeat(32);
const DAN = "d0".repeat(32);
const NOW = Math.floor(Date.now() / 1000);
const HOUR = 3600;

type Relay = ReturnType<typeof createMockRelay>;
type Filter = Record<string, unknown> | undefined;
const asks = (filter: Filter, kind: number) =>
  Array.isArray(filter?.kinds) && (filter.kinds as number[]).includes(kind);

function launch(id: string, name: string, at: number, stage = "live") {
  return {
    id: `launch-${id}`,
    pubkey: ALICE,
    created_at: at,
    kind: 37001,
    tags: [
      ["d", id],
      ["name", name],
      ["t", "dao-launchpad"],
      ["chain", "11155111"],
    ],
    content: JSON.stringify({
      pitch: `${name} pitch.`,
      stage,
      currency: "USDC",
      budget: "1000000",
      requiredRaised: "6000000",
    }),
    sig: "sig",
  };
}

function note(id: string, author: string, content: string, tags: string[][]) {
  return {
    id,
    pubkey: author,
    created_at: NOW - HOUR,
    kind: 1,
    tags,
    content,
    sig: "sig",
  };
}

function like(id: string, by: string, target: string) {
  return {
    id,
    pubkey: by,
    created_at: NOW - 600,
    kind: 7,
    tags: [["e", target]],
    content: "+",
    sig: "sig",
  };
}

function profile(pubkey: string, name: string) {
  return {
    id: `profile-${name}`,
    pubkey,
    created_at: NOW - 5 * HOUR,
    kind: 0,
    tags: [],
    content: JSON.stringify({ name }),
    sig: "sig",
  };
}

function follows(id: string, by: string, people: string[]) {
  return {
    id,
    pubkey: by,
    created_at: NOW - 4 * HOUR,
    kind: 3,
    tags: people.map((p) => ["p", p]),
    content: "",
    sig: "sig",
  };
}

/** Five open projects (the oldest must not show), a draft, a failed one; one liked post; people to follow. */
function seeded(): Relay {
  const relay = createMockRelay();
  relay.seed(launch("oldest", "Oldest project", NOW - 90 * HOUR));
  relay.seed(launch("alpha", "Alpha project", NOW - 40 * HOUR));
  relay.seed(launch("beta", "Beta project", NOW - 30 * HOUR));
  relay.seed(launch("gamma", "Gamma project", NOW - 20 * HOUR));
  relay.seed(launch("delta", "Delta project", NOW - 10 * HOUR));
  relay.seed(launch("secret", "Secret draft", NOW - 5 * HOUR, "draft"));
  relay.seed(launch("dead", "Dead project", NOW - 4 * HOUR, "failed"));
  const post = note(
    "post-trending".padEnd(64, "0"),
    ALICE,
    "Shipping the rail today #creaton",
    [["t", "creaton"]],
  );
  relay.seed(post);
  relay.seed(like("like-1".padEnd(64, "0"), BOB, post.id));
  relay.seed(like("like-2".padEnd(64, "0"), CAROL, post.id));
  relay.seed(profile(ALICE, "Alice Archer"));
  relay.seed(profile(DAN, "Dan Drummer"));
  relay.seed(follows("follow-b".padEnd(64, "0"), BOB, [DAN]));
  relay.seed(follows("follow-c".padEnd(64, "0"), CAROL, [DAN]));
  return relay;
}

async function setUp(page: Page, relay: Relay) {
  await page.route("http://127.0.0.1:8545/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x10" }),
    }),
  );
  await relay.install(page);
  // No terms set on this server, so no "could not check the terms" notice covers the page.
  await page.route("**/api/join-policy", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({}),
    }),
  );
  await page.addInitScript((nsec) => {
    window.localStorage.setItem("buzz.identity.nsec", nsec);
    window.localStorage.setItem("buzz.identity.backedUp", "1");
  }, NSEC);
}

const rail = (page: Page) =>
  page.getByRole("complementary", { name: "Discover" });

test("Home's rail lists the newest projects, trending posts, hashtags and people to follow", async ({
  page,
}) => {
  await setUp(page, seeded());
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

  // One landmark, a heading per block.
  await expect(rail(page)).toHaveCount(1);
  for (const name of [
    "Projects",
    "Trending posts",
    "Hashtags",
    "People to follow",
  ]) {
    await expect(
      rail(page).getByRole("heading", { level: 2, name, exact: true }),
    ).toBeVisible({ timeout: 20_000 });
  }

  // Projects: the four newest open ones, newest first. Not the oldest, not a draft, not a failed one.
  const projects = rail(page)
    .getByTestId("social-rail-projects")
    .getByRole("link");
  await expect(projects).toHaveText([
    /Delta project/,
    /Gamma project/,
    /Beta project/,
    /Alpha project/,
  ]);
  await expect(projects.first()).toHaveAttribute("href", /\/launchpad\/delta/);
  // The author goes with the id, as in every other project link: two authors can share an id.
  await expect(projects.first()).toHaveAttribute(
    "href",
    new RegExp(`author=${ALICE}`),
  );

  await expect(rail(page).getByTestId("social-rail-posts")).toContainText(
    "Alice Archer",
  );
  await expect(rail(page).getByTestId("social-rail-posts")).toContainText(
    "Shipping the rail today",
  );
  await expect(rail(page).getByTestId("social-rail-trending")).toContainText(
    "#creaton",
  );
  await expect(rail(page).getByTestId("social-rail-people")).toContainText(
    "Dan Drummer",
  );

  // The rail comes after the feed in reading and Tab order, and every link in it is named.
  const feedBeforeRail = await page.evaluate(() => {
    const aside = document.querySelector('[data-testid="social-rail"]');
    const tabs = document.querySelector('[role="tablist"]');
    return Boolean(
      aside &&
        tabs &&
        tabs.compareDocumentPosition(aside) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });
  expect(feedBeforeRail).toBe(true);
  const unnamed = await rail(page)
    .getByRole("link")
    .evaluateAll(
      (links) =>
        links.filter(
          (link) =>
            !(link.textContent ?? "").trim() &&
            !link.getAttribute("aria-label"),
        ).length,
    );
  expect(unnamed).toBe(0);
  await rail(page).getByTestId("social-rail-projects-all").focus();
  await expect(
    rail(page).getByTestId("social-rail-projects-all"),
  ).toBeFocused();
});

test("each See all opens its full page, and the old Explore address still works", async ({
  page,
}) => {
  await setUp(page, seeded());
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

  await rail(page).getByRole("link", { name: "See all projects" }).click();
  await expect(page).toHaveURL(/\/discover$/);
  await expect(page.getByTestId("discover-launch-list")).toBeVisible({
    timeout: 20_000,
  });

  const tab = (name: string) => page.getByRole("tab", { name, exact: true });
  await page.goto("/");
  await rail(page)
    .getByRole("link", { name: "See all people to follow" })
    .click();
  await expect(page).toHaveURL(/\/social\/explore\?tab=people$/);
  await expect(tab("People to follow")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByTestId("social-people-list")).toContainText(
    "Dan Drummer",
    {
      timeout: 20_000,
    },
  );

  await page.goto("/");
  await rail(page).getByRole("link", { name: "See all hashtags" }).click();
  await expect(page).toHaveURL(/\/social\/explore\?tab=hashtags$/);
  await expect(tab("Hashtags")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("social-hashtag-list")).toContainText(
    "#creaton",
    {
      timeout: 20_000,
    },
  );

  await page.goto("/");
  await rail(page)
    .getByRole("link", { name: "See all trending posts" })
    .click();
  await expect(page).toHaveURL(/\/social\/explore$/);
  await expect(tab("Trending posts")).toHaveAttribute("aria-selected", "true");

  // The old address and an unknown tab both open Explore on its first tab, never a 404.
  for (const old of ["/social/explore", "/social/explore?tab=nonsense"]) {
    await page.goto(old);
    await expect(tab("Trending posts")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(
      page.getByRole("heading", { level: 1, name: "Explore" }),
    ).toBeVisible();
  }

  // Picking a tab keeps it in the address, so a reload opens the same list.
  await tab("Trending posts").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page).toHaveURL(/tab=people/);
  await page.reload();
  await expect(tab("People to follow")).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

test("on a phone the rail sits below the feed with every block reachable and no sideways scroll", async ({
  page,
}) => {
  await setUp(page, seeded());
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  await expect(rail(page)).toHaveCount(1);
  for (const name of [
    "Projects",
    "Trending posts",
    "Hashtags",
    "People to follow",
  ]) {
    const heading = rail(page).getByRole("heading", {
      level: 2,
      name,
      exact: true,
    });
    await heading.scrollIntoViewIfNeeded();
    await expect(heading).toBeInViewport();
    const box = await heading.boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= 390).toBe(true);
  }
  await expect(rail(page).getByTestId("social-rail-people")).toContainText(
    "Dan Drummer",
  );
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    const shell = document.querySelector('[data-testid="social-shell"]');
    return {
      page: doc.scrollWidth - window.innerWidth,
      shell: shell ? shell.scrollWidth - shell.clientWidth : 0,
    };
  });
  expect(overflow.page).toBeLessThanOrEqual(0);
  expect(overflow.shell).toBeLessThanOrEqual(0);

  // A link in a block works from there.
  await rail(page).getByRole("link", { name: "See all projects" }).click();
  await expect(page).toHaveURL(/\/discover$/);
});

test("a tablet keeps the rail under the feed, not beside it", async ({
  page,
}) => {
  await setUp(page, seeded());
  await page.setViewportSize({ width: 900, height: 900 });
  await page.goto("/");
  const aside = page.getByTestId("social-rail");
  await expect(
    aside.getByRole("heading", { name: "Projects", exact: true }),
  ).toBeVisible({
    timeout: 20_000,
  });
  const layout = await page.evaluate(() => {
    const rect = (selector: string) =>
      document.querySelector(selector)?.getBoundingClientRect();
    const feed = rect('[role="tablist"]');
    const side = rect('[data-testid="social-rail"]');
    return {
      feedBottom: feed?.bottom ?? 0,
      sideTop: side?.top ?? 0,
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
  expect(layout.sideTop).toBeGreaterThan(layout.feedBottom);
  expect(layout.overflow).toBeLessThanOrEqual(0);
});

test("a server with no projects says so and points to Start, not a blank box", async ({
  page,
}) => {
  await setUp(page, createMockRelay());
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const empty = rail(page).getByTestId("social-rail-projects-empty");
  await expect(empty).toContainText("No projects on this server yet", {
    timeout: 20_000,
  });
  await expect(empty.getByRole("link", { name: "Start one" })).toHaveAttribute(
    "href",
    "/start",
  );
  await expect(rail(page).getByTestId("social-rail-posts-empty")).toBeVisible();
  await expect(
    rail(page).getByTestId("social-rail-hashtags-empty"),
  ).toBeVisible();
});

test("projects the server would not answer for are a failure with a retry, not an empty list", async ({
  page,
}) => {
  const relay = seeded();
  relay.setClosingSockets((filter) => asks(filter, 37001));
  await setUp(page, relay);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const error = rail(page).getByTestId("social-rail-projects-error");
  await expect(error).toBeVisible({ timeout: 30_000 });
  await expect(
    rail(page).getByTestId("social-rail-projects-empty"),
  ).toHaveCount(0);
  // A failed read is said as an alert; a block still reading is plain text, so four loading blocks do not announce.
  await expect(error).toHaveAttribute("role", "alert");
  await expect(rail(page).getByRole("status")).toHaveCount(0);

  relay.setClosingSockets(false);
  await error.getByRole("button", { name: /try again/i }).click();
  await expect(rail(page).getByTestId("social-rail-projects")).toContainText(
    "Delta project",
    {
      timeout: 20_000,
    },
  );
});

for (const width of [390, 900]) {
  test(`on a short page at ${width}px the rail starts below the page, never over it`, async ({
    page,
  }) => {
    // A person with nothing posted is a page far shorter than the screen: the rail used to be laid over its lower half.
    await setUp(page, seeded());
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`/u/${DAN}`);
    await expect(
      rail(page).getByRole("heading", { name: "Projects", exact: true }),
    ).toBeVisible({ timeout: 20_000 });
    const gap = await page.evaluate(() => {
      const side = document.querySelector('[data-testid="social-rail"]');
      const timeline = side?.previousElementSibling?.getBoundingClientRect();
      return side && timeline
        ? side.getBoundingClientRect().top - timeline.bottom
        : null;
    });
    expect(gap).not.toBeNull();
    expect(gap).toBeGreaterThanOrEqual(-1);
  });
}

test("a muted person is left out of the rail's trending posts and people to follow", async ({
  page,
}) => {
  const relay = seeded();
  // Bob is the author of a second liked post and also the other person worth following; the reader muted him.
  const bobs = note("post-by-bob".padEnd(64, "0"), BOB, "Bob's hot take", []);
  relay.seed(bobs);
  relay.seed(like("like-3".padEnd(64, "0"), CAROL, bobs.id));
  relay.seed(like("like-4".padEnd(64, "0"), DAN, bobs.id));
  relay.seed(like("like-5".padEnd(64, "0"), ALICE, bobs.id));
  relay.seed(profile(BOB, "Bob Baker"));
  relay.seed(follows("follow-a".padEnd(64, "0"), ALICE, [BOB]));
  relay.seed(follows("follow-d".padEnd(64, "0"), DAN, [BOB]));
  relay.seed(follows("follow-c2".padEnd(64, "0"), CAROL, [BOB]));
  await setUp(page, relay);
  await page.setViewportSize({ width: 1440, height: 900 });

  // Before the mute: Bob shows in both blocks (so the test can fail).
  await page.goto("/");
  await expect(rail(page).getByTestId("social-rail-posts")).toContainText(
    "Bob Baker",
    { timeout: 20_000 },
  );
  await expect(rail(page).getByTestId("social-rail-people")).toContainText(
    "Bob Baker",
  );

  relay.seed({
    id: "mute-list".padEnd(64, "0"),
    pubkey: ME,
    created_at: NOW - 60,
    kind: 10000,
    tags: [["p", BOB]],
    content: "",
    sig: "sig",
  });
  await page.goto("/");
  await expect(rail(page).getByTestId("social-rail-posts")).toContainText(
    "Alice Archer",
    { timeout: 20_000 },
  );
  await expect(rail(page).getByTestId("social-rail-people")).toContainText(
    "Dan Drummer",
  );
  await expect(rail(page).getByText("Bob Baker")).toHaveCount(0);
  await expect(rail(page).getByText("Bob's hot take")).toHaveCount(0);
});

test("when the mute list can't be read, the rail and Explore show no people, only a failure with a retry", async ({
  page,
}) => {
  const relay = seeded();
  // Bob wrote the most liked post and is the most followed; the reader muted him, but the mute list will not load.
  const bobs = note("post-by-bob".padEnd(64, "0"), BOB, "Bob's hot take", []);
  relay.seed(bobs);
  relay.seed(like("like-3".padEnd(64, "0"), CAROL, bobs.id));
  relay.seed(like("like-4".padEnd(64, "0"), DAN, bobs.id));
  relay.seed(like("like-5".padEnd(64, "0"), ALICE, bobs.id));
  relay.seed(profile(BOB, "Bob Baker"));
  relay.seed(follows("follow-a".padEnd(64, "0"), ALICE, [BOB]));
  relay.seed(follows("follow-d".padEnd(64, "0"), DAN, [BOB]));
  relay.seed(follows("follow-c2".padEnd(64, "0"), CAROL, [BOB]));
  relay.seed({
    id: "mute-list".padEnd(64, "0"),
    pubkey: ME,
    created_at: NOW - 60,
    kind: 10000,
    tags: [["p", BOB]],
    content: "",
    sig: "sig",
  });
  relay.setClosingSockets((filter) => asks(filter, 10000));
  await setUp(page, relay);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

  // Who is muted is unknown, so neither block shows anyone: each says the read failed, as an alert with a retry.
  const postsError = rail(page).getByTestId("social-rail-posts-error");
  const peopleError = rail(page).getByTestId("social-rail-people-error");
  await expect(postsError).toBeVisible({ timeout: 30_000 });
  await expect(peopleError).toBeVisible();
  await expect(postsError).toHaveAttribute("role", "alert");
  await expect(peopleError).toHaveAttribute("role", "alert");
  await expect(rail(page).getByTestId("social-rail-posts")).toHaveCount(0);
  await expect(rail(page).getByTestId("social-rail-people")).toHaveCount(0);
  await expect(rail(page).getByText("Bob Baker")).toHaveCount(0);
  await expect(rail(page).getByText("Bob's hot take")).toHaveCount(0);
  // The blocks that name nobody are not held back.
  await expect(rail(page).getByTestId("social-rail-projects")).toBeVisible();
  await expect(rail(page).getByTestId("social-rail-trending")).toBeVisible();

  // Explore's People tab follows the same rule: a failure, never a list that may hold a muted person.
  await page.goto("/social/explore?tab=people");
  await expect(page.getByTestId("social-people-error")).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByTestId("social-people-list")).toHaveCount(0);
  await expect(page.getByText("Bob Baker")).toHaveCount(0);

  // The retry reads the mute list again; once it answers, the lists come back without the muted person.
  relay.setClosingSockets(false);
  await page
    .getByTestId("social-people-error")
    .getByRole("button", { name: /try again/i })
    .click();
  await expect(page.getByTestId("social-people-list")).toContainText(
    "Dan Drummer",
    { timeout: 20_000 },
  );
  await expect(page.getByTestId("social-people-list")).not.toContainText(
    "Bob Baker",
  );

  relay.setClosingSockets((filter) => asks(filter, 10000));
  await page.goto("/");
  await expect(postsError).toBeVisible({ timeout: 30_000 });
  relay.setClosingSockets(false);
  await postsError.getByRole("button", { name: /try again/i }).click();
  await expect(rail(page).getByTestId("social-rail-posts")).toContainText(
    "Alice Archer",
    { timeout: 20_000 },
  );
  await expect(rail(page).getByTestId("social-rail-people")).toContainText(
    "Dan Drummer",
  );
  await expect(rail(page).getByText("Bob Baker")).toHaveCount(0);
  await expect(rail(page).getByText("Bob's hot take")).toHaveCount(0);
});

test("the rail reads a handful of trending posts by id, not the whole trending list", async ({
  page,
}) => {
  const relay = seeded();
  for (let n = 0; n < 14; n++) {
    const extra = note(
      `extra-${n}`.padEnd(64, "0"),
      ALICE,
      `Extra post ${n}`,
      [],
    );
    relay.seed(extra);
    relay.seed(like(`like-x${n}`.padEnd(64, "0"), BOB, extra.id));
  }
  await setUp(page, relay);
  await page.setViewportSize({ width: 1440, height: 900 });
  // A page that is not Home: the rail is on every social page.
  await page.goto("/social/notifications");
  await expect(
    rail(page).getByRole("heading", { name: "Trending posts", exact: true }),
  ).toBeVisible({ timeout: 20_000 });
  await expect(rail(page).getByTestId("social-rail-posts")).toBeVisible();
  const longest = Math.max(
    0,
    ...relay
      .reqsReceived()
      .flat()
      .map((f) => (Array.isArray(f.ids) ? (f.ids as string[]).length : 0)),
  );
  expect(longest).toBeGreaterThan(0);
  expect(longest).toBeLessThanOrEqual(9);
});
