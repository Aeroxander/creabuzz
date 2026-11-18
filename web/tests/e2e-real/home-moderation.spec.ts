import { execFileSync } from "node:child_process";

import type { Browser, Page } from "@playwright/test";

import { expect, test } from "./frame-meter";
import { PEOPLE, post, pubkeyOf, readAs } from "./social-helpers.mjs";

/**
 * Removing a Home post on a REAL server (`scripts/web-social-e2e.sh`), with the people `seed-social.mjs` made and Dev,
 * the community's owner (`seed.sql`): Carol and Alice each post on Home and Bob reports both. Dev removes Carol's from
 * the post's own menu with a reason, and Alice's from the moderation queue with a reason. The server deletes both,
 * closes both reports, and writes each author a public log entry with the reason (kind 45004, named by `p`), which is
 * what their notifications read; Bob, after a reload, no longer sees either on Home. Nothing is mocked.
 *
 * Before this, a Home post could not be removed by anyone but its author: the post had only Report and Ban, the queue
 * offered no Delete for a report outside a room, and the server refused a removal without one.
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

function sql(query: string): string {
  const db = process.env.DATABASE_URL;
  if (!db)
    throw new Error("DATABASE_URL is not set (run scripts/web-social-e2e.sh)");
  return execFileSync("psql", [db, "-Atc", query], { encoding: "utf8" }).trim();
}

const postCard = (page: Page, text: string) =>
  page.getByTestId("social-post").filter({ hasText: text }).first();

/** The Home feed pages as you scroll; wait for `text` to load, boundedly. */
async function showsOnHome(page: Page, text: string) {
  await expect(page.getByTestId("social-shell")).toBeVisible({
    timeout: 30_000,
  });
  for (let i = 0; i < 25; i += 1) {
    if (await postCard(page, text).isVisible()) return;
    await page.getByTestId("social-shell").evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await page.waitForTimeout(400);
  }
  await expect(postCard(page, text)).toBeVisible({ timeout: 20_000 });
}

/** The status of the report about `target` (reports are not stored as events, so the database is asked). */
function reportStatus(target: string): string {
  return sql(
    `select status from moderation_reports where target_event_id = decode('${target}','hex')`,
  );
}

/** The public log entries about `who` that name `target`, read as `who` (the read their notifications make). */
async function logEntriesAbout(who: keyof typeof PEOPLE, target: string) {
  const entries = (await readAs(who, {
    kinds: [45004],
    "#p": [pubkeyOf(who)],
    limit: 50,
  })) as { content: string; tags: string[][] }[];
  return entries.filter((entry) =>
    entry.tags.some((tag) => tag[0] === "e" && tag[1] === target),
  );
}

test("the community's owner removes Home posts from the post and from the queue; the authors are told", async ({
  browser,
}) => {
  // The app learns who owns and runs the server from its member list, which the server keeps only when it is
  // invite-only, as the pilot server is. On an open test server nobody is offered Remove (or Ban).
  test.skip(
    process.env.SOCIAL_HOSTED !== "1",
    "needs the invite-only server of HOSTED=1 scripts/web-social-e2e.sh, whose member list names the owner",
  );
  test.setTimeout(240_000);
  const watches = `Cheap watches, DM me ${RUN}`;
  const course = `Buy my course today ${RUN}`;
  const control = `Still on Home ${RUN}`;

  const carolsPost = await post("carol", {
    kind: 1,
    tags: [],
    content: watches,
  });
  const alicesPost = await post("alice", {
    kind: 1,
    tags: [],
    content: course,
  });
  await post("bob", { kind: 1, tags: [], content: control });
  for (const [target, note] of [
    [carolsPost, `watches ${RUN}`],
    [alicesPost, `course ${RUN}`],
  ] as const) {
    await post("bob", {
      kind: 1984,
      tags: [
        ["e", target.id, "spam"],
        ["p", target.pubkey],
      ],
      content: note,
    });
  }
  expect(reportStatus(carolsPost.id)).toBe("open");
  expect(reportStatus(alicesPost.id)).toBe("open");

  const bob = await signedIn(browser, "bob");
  await test.step("Bob sees both posts on Home", async () => {
    await bob.goto("/social");
    await showsOnHome(bob, watches);
    await showsOnHome(bob, course);
    // Bob is not the owner: no Remove on someone else's post.
    await expect(
      postCard(bob, watches).getByTestId("social-moderator-remove"),
    ).toHaveCount(0);
  });

  const dev = await signedIn(browser, "dev");
  await test.step("Dev removes Carol's post from its menu, with a reason", async () => {
    await dev.goto("/social");
    await showsOnHome(dev, watches);
    await postCard(dev, watches).getByTestId("social-moderator-remove").click();
    await dev.getByTestId("social-moderator-remove-dialog-reason").fill("Spam");
    await dev.getByTestId("social-moderator-remove-dialog-submit").click();
    await expect(dev.getByText(/Post removed\./)).toBeVisible({
      timeout: 30_000,
    });
    await expect(postCard(dev, watches)).toHaveCount(0);
  });

  await test.step("Dev removes Alice's post from the moderation queue, with a reason", async () => {
    await dev.goto(`/c/${HOST}`);
    await dev.getByTestId("moderation-toggle").click();
    const rows = dev.getByTestId("moderation-report-row");
    // The removal from the post already closed the report about it.
    await expect(rows.filter({ hasText: `watches ${RUN}` })).toContainText(
      "Resolved",
      { timeout: 60_000 },
    );
    const row = rows.filter({ hasText: `course ${RUN}` });
    await expect(row).toContainText("about a post on Home");
    await row.getByTestId("moderation-delete").click();
    await dev.getByTestId("moderation-delete-dialog-reason").fill("Selling");
    await dev.getByTestId("moderation-delete-dialog-submit").click();
    await expect(row).toContainText("Resolved", { timeout: 30_000 });
    await expect(dev.getByTestId("moderation-action-error")).toHaveCount(0);
  });

  await test.step("the server deleted both and closed both reports", async () => {
    expect(
      await readAs("bob", {
        kinds: [1],
        ids: [carolsPost.id, alicesPost.id],
      }),
    ).toHaveLength(0);
    expect(reportStatus(carolsPost.id)).toBe("resolved");
    expect(reportStatus(alicesPost.id)).toBe("resolved");
  });

  await test.step("after a reload, Bob no longer sees either on Home", async () => {
    await bob.reload();
    await showsOnHome(bob, control);
    await expect(postCard(bob, watches)).toHaveCount(0);
    await expect(postCard(bob, course)).toHaveCount(0);
  });

  await test.step("each author's account holds the notice, with the reason", async () => {
    for (const [who, target, reason] of [
      ["carol", carolsPost.id, "Spam"],
      ["alice", alicesPost.id, "Selling"],
    ] as const) {
      const entries = await logEntriesAbout(who, target);
      expect(entries, `${who}'s notice`).toHaveLength(1);
      const [entry] = entries;
      expect(entry.content).toBe(reason);
      expect(entry.tags).toContainEqual(["action", "remove"]);
      expect(entry.tags).toContainEqual(["role", "community_owner"]);
      // A Home removal belongs to no board.
      expect(entry.tags.some((tag) => tag[0] === "h")).toBe(false);
    }
  });
});
