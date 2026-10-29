import { randomUUID } from "node:crypto";

import type { Browser, Page } from "@playwright/test";

import { expect, test } from "./frame-meter";

import { PEOPLE, post, pubkeyOf, readAs } from "./social-helpers.mjs";

/**
 * Two pilot blockers on a REAL server (`scripts/web-social-e2e.sh`, with `SPECS` naming this file), with the people
 * `seed-social.mjs` made:
 *
 * 1. Bob follows two people within a second from Explore. Both follows are kept (each change used to be built from the
 *    same cached list, so the second write dropped the first), and both people are told he followed them.
 * 2. A board's moderator removes Carol's board post with a reason, and Carol's Home notifications say so, with the
 *    reason, counted in the badge (the notice used to reach only the community bell).
 *
 * Nothing is mocked. Bob's follows are put back as the seed left them (Alice and Carol) when the test ends.
 */

test.use({ viewport: { width: 1280, height: 900 } });

const HOST = "localhost:3199";
const RUN = Date.now().toString(36);

async function signedIn(
  browser: Browser,
  who: keyof typeof PEOPLE,
): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript((nsec) => {
    window.localStorage.setItem("buzz.identity.nsec", nsec);
    window.localStorage.setItem("buzz.identity.backedUp", "1");
  }, PEOPLE[who]);
  return page;
}

interface ListEvent {
  created_at: number;
  id: string;
  tags: string[][];
}

/** Bob's newest contact list on the server. */
async function bobsNewestList(): Promise<ListEvent | null> {
  const lists = (await readAs("bob", {
    kinds: [3],
    authors: [pubkeyOf("bob")],
  })) as ListEvent[];
  return (
    lists.sort(
      (a, b) => b.created_at - a.created_at || (a.id < b.id ? 1 : -1),
    )[0] ?? null
  );
}

/** Replace Bob's contact list with one following exactly `who`, dated after whatever is there. */
async function setBobsFollows(who: (keyof typeof PEOPLE)[]) {
  const newest = await bobsNewestList();
  await post("bob", {
    kind: 3,
    tags: who.map((name) => ["p", pubkeyOf(name)]),
    content: "",
    created_at: Math.max(
      Math.floor(Date.now() / 1000),
      (newest?.created_at ?? 0) + 1,
    ),
  });
}

test("following two people within a second keeps both, and both are told", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const alice = pubkeyOf("alice");
  const dev = pubkeyOf("dev");

  // Bob starts following only Carol, so Alice and Dev are both people to follow (and neither has a follow from him).
  await setBobsFollows(["carol"]);
  try {
    await expect
      .poll(
        async () =>
          (
            await readAs("alice", {
              kinds: [3],
              authors: [pubkeyOf("bob")],
              "#p": [alice],
            })
          ).length,
        { timeout: 20_000 },
      )
      .toBe(0);

    const bob = await signedIn(browser, "bob");
    await test.step("Bob follows Alice and Dev from Explore, one right after the other", async () => {
      await bob.goto("/social/explore");
      await bob.getByTestId("social-tab-people").click();
      const people = bob.getByTestId("social-people-list");
      const followOf = (name: string) =>
        people
          .getByTestId("social-person")
          .filter({ hasText: name })
          .getByTestId("social-follow");
      const followAlice = followOf("Alice Archer");
      const followDev = followOf("Dev Tester");
      await expect(followAlice).toBeEnabled({ timeout: 30_000 });
      await expect(followDev).toBeEnabled();
      await expect(followAlice).toHaveAttribute("aria-pressed", "false");
      await expect(followDev).toHaveAttribute("aria-pressed", "false");
      // Both clicks go out before the first follow can have reached the server.
      await Promise.all([followAlice.click(), followDev.click()]);
    });

    await test.step("the server's newest list keeps Carol and has both of them", async () => {
      await expect
        .poll(
          async () =>
            (await bobsNewestList())?.tags
              .filter((t) => t[0] === "p")
              .map((t) => t[1])
              .sort(),
          { timeout: 30_000 },
        )
        .toEqual([alice, pubkeyOf("carol"), dev].sort());
    });

    await test.step("after a reload, Bob's profile counts all three", async () => {
      await bob.goto(`/u/${pubkeyOf("bob")}`);
      await expect(bob.getByTestId("profile-following-count")).toContainText(
        "3",
        { timeout: 30_000 },
      );
    });

    for (const who of ["alice", "dev"] as const) {
      await test.step(`${who} is told Bob followed them`, async () => {
        const page = await signedIn(browser, who);
        await page.goto("/social/notifications");
        await expect(
          page
            .locator('[data-testid="social-notification"][data-kind="follow"]')
            .filter({ hasText: "Bob Builder" }),
        ).toBeVisible({ timeout: 60_000 });
        await page.context().close();
      });
    }
    await bob.context().close();
  } finally {
    await setBobsFollows(["alice", "carol"]);
  }
});

test("a moderator's removal of a board post reaches the author's Home notifications, with the reason, in the badge", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const board = randomUUID();
  const carol = pubkeyOf("carol");
  const reason = `Off topic ${RUN}`;

  await test.step("Alice starts a board and appoints Bob; Carol posts; Dev reports it", async () => {
    await post("alice", {
      kind: 9007,
      tags: [
        ["h", board],
        ["name", `notify-${RUN}`],
        ["visibility", "open"],
        ["channel_type", "forum"],
      ],
      content: "",
    });
    await post("alice", {
      kind: 9052,
      tags: [
        ["h", board],
        ["p", pubkeyOf("bob")],
      ],
      content: "",
    });
  });
  const spam = await post("carol", {
    kind: 45001,
    tags: [["h", board]],
    content: `# Not about this board ${RUN}\n\nBuy my thing.`,
  });
  await post("dev", {
    kind: 1984,
    tags: [
      ["e", spam.id, "spam"],
      ["p", carol],
    ],
    content: "not about this board",
  });

  // Carol looks at her notifications first, so the badge starts at nothing new.
  const carolPage = await signedIn(browser, "carol");
  await test.step("Carol has seen everything so far", async () => {
    await carolPage.goto("/social/notifications");
    await expect(
      carolPage
        .getByTestId("social-notification")
        .or(carolPage.getByTestId("social-notifications-empty"))
        .first(),
    ).toBeVisible({ timeout: 30_000 });
    await expect(carolPage.getByTestId("social-unread")).toHaveCount(0, {
      timeout: 20_000,
    });
  });

  const bob = await signedIn(browser, "bob");
  await test.step("Bob removes Carol's post with a reason", async () => {
    await bob.goto(`/c/${HOST}?channel=${board}`);
    await expect(bob.getByTestId("board-report-count")).toContainText("1", {
      timeout: 60_000,
    });
    await bob.getByTestId("board-moderation-toggle").click();
    const row = bob.getByTestId("board-report-row");
    await expect(row).toContainText("a post by Carol");
    await row.getByTestId("board-report-remove").click();
    await bob.getByTestId("board-report-remove-dialog-reason").fill(reason);
    await bob.getByTestId("board-report-remove-dialog-submit").click();
    await expect(bob.getByTestId("board-reports-empty")).toBeVisible({
      timeout: 30_000,
    });
    await bob.context().close();
  });

  await test.step("Carol's badge counts it", async () => {
    await carolPage.goto("/social");
    await expect(carolPage.getByTestId("social-unread").first()).toContainText(
      /[1-9]/,
      { timeout: 60_000 },
    );
  });

  await test.step("Carol's notifications say a moderator removed her post, why, and open the board", async () => {
    await carolPage.goto("/social/notifications");
    const notice = carolPage
      .locator('[data-testid="social-notification"][data-kind="moderation"]')
      .filter({ hasText: reason });
    await expect(notice).toBeVisible({ timeout: 60_000 });
    await expect(notice).toContainText("A moderator removed your post");
    await expect(
      notice.getByTestId("social-notification-reason"),
    ).toContainText(`Reason: ${reason}.`);
    await expect(
      notice.getByRole("link", { name: /Open the board/ }),
    ).toHaveAttribute("href", new RegExp(`/b/${board}`));
  });
  await carolPage.context().close();
});
