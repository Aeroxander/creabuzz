import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { expect, type Browser, type Page, test } from "@playwright/test";

import { PEOPLE, post, pubkeyOf, readAs } from "./social-helpers.mjs";

/**
 * A board's moderation on a REAL server (`scripts/web-social-e2e.sh`), with the people `seed-social.mjs` made: Alice
 * starts a board and appoints Bob its moderator; Carol posts spam; Dev reports it. Bob, who moderates only this board,
 * sees the report without who sent it and removes the post from the queue with a reason: the server deletes it, closes
 * the report as acted on, and Carol's notifications say a moderator removed her post. Then Alice mutes Carol, and her
 * next post on the board is left out of Alice's list with a way to show it. (Alice, not Dev: the social suite runs as
 * Dev and expects to see Carol.) Nothing is mocked (D93 to D100).
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

test("a board's moderator removes a reported post from the queue; the author is told; a mute hides her next post", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const board = randomUUID();
  const carol = pubkeyOf("carol");

  await test.step("Alice starts a board and appoints Bob; Carol posts; Dev reports it", async () => {
    await post("alice", {
      kind: 9007,
      tags: [
        ["h", board],
        ["name", `moderated-${RUN}`],
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
    content: `# Cheap followers ${RUN}\n\nDM me.`,
  });
  await post("dev", {
    kind: 1984,
    tags: [
      ["e", spam.id, "spam"],
      ["p", carol],
    ],
    content: "selling followers",
  });

  const bob = await signedIn(browser, "bob");
  await test.step("Bob sees the report, without who sent it, and removes the post with a reason", async () => {
    await bob.goto(`/c/${HOST}?channel=${board}`);
    await expect(bob.getByTestId("board-report-count")).toContainText("1", {
      timeout: 60_000,
    });
    await bob.getByTestId("board-moderation-toggle").click();
    const row = bob.getByTestId("board-report-row");
    await expect(row).toContainText("a post by Carol");
    await expect(row).toContainText("selling followers");
    await expect(bob.getByTestId("board-reports")).not.toContainText("Dev");
    await row.getByTestId("board-report-remove").click();
    await bob.getByTestId("board-report-remove-dialog-reason").fill("Spam");
    await bob.getByTestId("board-report-remove-dialog-submit").click();
    await expect(bob.getByTestId("board-reports-empty")).toBeVisible({
      timeout: 30_000,
    });
    await expect(bob.getByTestId("board-log")).toContainText(
      "removed a post by Carol",
    );
  });

  await test.step("the server deleted it and closed the report as acted on, recorded as a board moderator's", async () => {
    expect(
      await readAs("dev", { kinds: [45001], ids: [spam.id] }),
    ).toHaveLength(0);
    expect(
      sql(
        `select status from moderation_reports where report_event_id = decode('${await reportId(spam.id)}','hex')`,
      ),
    ).toBe("resolved");
    expect(
      sql(
        `select count(*) from moderation_actions where actor_authority = 'board_moderator' and encode(actor_pubkey,'hex') = '${pubkeyOf("bob")}'`,
      ),
    ).toBe("2");
  });

  await test.step("Carol's notifications say a moderator removed her post, with the reason", async () => {
    const page = await signedIn(browser, "carol");
    await page.goto(`/c/${HOST}`);
    const bell = page.getByTestId("notifications-bell");
    await expect(bell).toContainText(/[1-9]/, { timeout: 60_000 });
    await bell.getByRole("button").first().click();
    await expect(bell.getByText("A moderator removed your post")).toBeVisible();
    await expect(bell.getByText(/Reason: Spam\./)).toBeVisible();
  });

  await test.step("Alice mutes Carol; her next post is left out of Alice's board with a way to show it", async () => {
    await post("alice", { kind: 10000, tags: [["p", carol]], content: "" });
    const again = `Second try ${RUN}`;
    await post("carol", {
      kind: 45001,
      tags: [["h", board]],
      content: `# ${again}`,
    });
    const page = await signedIn(browser, "alice");
    await page.goto(`/c/${HOST}?channel=${board}`);
    const hidden = page.getByTestId("board-muted-hidden");
    await expect(hidden).toContainText("1 post from someone you muted", {
      timeout: 60_000,
    });
    // Her post was the only one left, so the board says what it holds instead of "no posts yet".
    await expect(page.getByTestId("board-empty")).toContainText(
      "Nothing here but posts from people you muted",
    );
    await expect(page.getByText(again)).toHaveCount(0);
    await hidden.getByRole("button", { name: "Show" }).click();
    await expect(page.getByTestId("board-posts")).toContainText(again);
  });
});

/** The id of the report about `target` (reports are not stored as events, so the database is asked). */
async function reportId(target: string): Promise<string> {
  return sql(
    `select encode(report_event_id,'hex') from moderation_reports where target_event_id = decode('${target}','hex') limit 1`,
  );
}
