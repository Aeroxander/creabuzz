import { expect, test } from "@playwright/test";

import {
  PORT,
  createCommunity,
  joinWithInvite,
  makeInviteLink,
  openPeople,
  signInAsNewAccount,
  unique,
} from "./community-helpers";

/**
 * Ideas from the boards, against a REAL server (`scripts/web-invite-only-e2e.sh`).
 *
 * An owner makes a community and its two starter boards. A member posts an idea on the supporters board. The owner
 * opens Work, sees it under "Ideas from the boards", and turns it into a task with a reward and the default credit
 * for whoever wrote it, then moves the task to Done. The member's own page shows it as theirs and done, and they claim
 * the credit: the server takes the contribution record, and a second claim is refused because the record is there.
 * Nothing is mocked: this is what proves the server accepts the task's `source`, the note under the post, the board
 * lookup by id and the finder's record.
 */

test.use({ viewport: { width: 1280, height: 900 } });

test("a member's board post becomes a task, and they claim the credit once it is done", async ({
  page: owner,
  browser,
}) => {
  test.setTimeout(300_000);
  const name = unique();
  const host = `${name}.localhost:${PORT}`;
  const title = `Add dark mode ${name}`;

  await signInAsNewAccount(owner);
  await createCommunity(owner, name);
  await openPeople(owner);
  const inviteUrl = await makeInviteLink(owner);

  // The community's two starter boards.
  await owner.goto(`/c/${host}`);
  await owner.getByTestId("starter-boards").click();
  await expect(owner.getByTestId("board-nav-supporters")).toBeVisible({
    timeout: 30_000,
  });

  // A member posts an idea.
  const member = await joinWithInvite(browser, inviteUrl, host);
  await member.goto(`http://${host}/c/${host}`);
  await member.getByTestId("board-nav-supporters").click({ timeout: 30_000 });
  await member.getByTestId("board-new-post").click();
  await member.getByPlaceholder("Title").fill(title);
  await member.getByTestId("board-composer-submit").click();
  const theirPost = member
    .getByTestId("board-post-title")
    .filter({ hasText: title });
  await expect(theirPost).toBeVisible({ timeout: 30_000 });

  // The owner finds it under Work and turns it into a task.
  await owner.goto(`/c/${host}`);
  await owner.getByTestId("work-toggle").click({ timeout: 30_000 });
  await owner.getByTestId("board-ideas-toggle").click();
  const idea = owner.getByTestId("idea-row").filter({ hasText: title });
  await expect(idea).toBeVisible({ timeout: 30_000 });
  await idea.getByTestId("idea-make-task").click();
  await owner.getByTestId("idea-reward").fill("20");
  await expect(owner.getByTestId("idea-finder")).toHaveAttribute(
    "placeholder",
    "2",
  );
  await owner.getByTestId("idea-submit").click();
  // It leaves the list: the server took the task and sent it back.
  await expect(idea).toHaveCount(0, { timeout: 30_000 });

  // The owner finishes it.
  const card = owner
    .locator('[data-testid^="kanban-card-"]')
    .filter({ hasText: title });
  await expect(card).toBeVisible({ timeout: 30_000 });
  // Task rows are stamped to the second and a tie goes to the lower id, so a person takes longer than a second between
  // making a task and finishing it. The test must too.
  await owner.waitForTimeout(1100);
  await card.hover();
  await card.locator('[data-testid^="kanban-menu-"]').click();
  await card.getByRole("button", { name: "Done" }).click();
  await expect(
    owner
      .getByTestId("kanban-col-done")
      .locator('[data-testid^="kanban-card-"]')
      .filter({ hasText: title }),
  ).toBeVisible({ timeout: 30_000 });

  // The member sees the note under their post, and the task as theirs and done.
  await member.goto(`http://${host}/c/${host}`);
  await member.getByTestId("board-nav-supporters").click({ timeout: 30_000 });
  await expect(
    member.getByTestId("board-posts").locator("li").filter({ hasText: title }),
  ).toContainText("1 reply", { timeout: 30_000 });
  // Work is not in a member's sidebar (D108); its link still opens it.
  await member.goto(`http://${host}/c/${host}?view=work`);
  await member.getByTestId("board-ideas-toggle").click({ timeout: 30_000 });
  const mine = member.getByTestId("your-suggestions");
  await expect(mine).toContainText(title, { timeout: 30_000 });
  await expect(mine).toContainText("Done");
  await expect(mine).toContainText("2 points for you");

  // They claim the credit; the server takes the record.
  await member.getByTestId("suggestion-claim").click();
  await expect(member.getByTestId("suggestion-filed")).toBeVisible({
    timeout: 30_000,
  });

  // After a reload the button is back, and the server says the credit is already claimed.
  await member.reload();
  await member.getByTestId("board-ideas-toggle").click();
  await member.getByTestId("suggestion-claim").click({ timeout: 30_000 });
  await expect(
    member.getByText("This credit has already been claimed."),
  ).toBeVisible({ timeout: 30_000 });
});
