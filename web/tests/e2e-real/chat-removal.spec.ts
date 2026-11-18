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
 * A room's owner removes someone else's chat message, against a REAL server (`scripts/web-invite-only-e2e.sh`).
 *
 * An owner makes a community and a room; an invited member writes in it. The owner removes the message: the member, who
 * has the room open, sees it go without reloading (so the server delivers the removal to readers, not only stores it), it
 * stays gone after a reload (the server deleted it), and the member is offered no Remove of their own. The same for a post on
 * a board. Nothing is mocked.
 */

test.use({ viewport: { width: 1280, height: 900 } });

test("an owner removes a member's message; the member's open room shows it gone and a reload does not bring it back", async ({
  page: owner,
  browser,
}) => {
  test.setTimeout(300_000);
  const name = unique();
  const host = `${name}.localhost:${PORT}`;
  const spam = `Buy my coin ${name}`;

  await signInAsNewAccount(owner);
  await createCommunity(owner, name);
  await openPeople(owner);
  const inviteUrl = await makeInviteLink(owner);

  // The owner makes a room.
  await owner.goto(`/c/${host}`);
  await owner.getByTestId("new-channel").click();
  await owner.locator("#channel-name").fill("lobby");
  await owner.getByTestId("submit-create-channel").click();
  await expect(owner.getByTestId("channel-lobby")).toBeVisible({
    timeout: 30_000,
  });

  // A member writes in it.
  const member = await joinWithInvite(browser, inviteUrl, host);
  await member.goto(`http://${host}/c/${host}`);
  await member.getByTestId("channel-lobby").click({ timeout: 30_000 });
  await member.getByTestId("composer-input").fill(spam);
  await member.getByTestId("composer-send").click();
  const theirs = (page: typeof owner) =>
    page.getByTestId("message-row").filter({ hasText: spam });
  await expect(theirs(member)).toBeVisible({ timeout: 30_000 });
  // They are offered no Remove, on their own message or anyone's.
  await expect(theirs(member).getByTestId("remove-button")).toHaveCount(0);

  // The owner has the room open, sees it, and removes it.
  await owner.getByTestId("channel-lobby").click();
  await expect(theirs(owner)).toBeVisible({ timeout: 30_000 });
  await theirs(owner).hover();
  await theirs(owner).getByTestId("remove-button").click();
  await owner.getByRole("button", { name: "Remove message" }).click();
  await expect(owner.getByText("message removed by a moderator")).toBeVisible({
    timeout: 30_000,
  });

  // The member did not reload: the removal reaches them.
  await expect(member.getByText("message removed by a moderator")).toBeVisible({
    timeout: 30_000,
  });
  await expect(member.getByText(spam)).toHaveCount(0);

  // The server deleted it: a reload does not bring it back, for either of them.
  await member.reload();
  await member.getByTestId("channel-lobby").click({ timeout: 30_000 });
  await expect(member.getByText(spam)).toHaveCount(0);
  await owner.reload();
  await owner.getByTestId("channel-lobby").click({ timeout: 30_000 });
  await expect(owner.getByText(spam)).toHaveCount(0);
});

test("an owner removes a member's board post; the member's open board shows it gone and a reload does not bring it back", async ({
  page: owner,
  browser,
}) => {
  test.setTimeout(300_000);
  const name = unique();
  const host = `${name}.localhost:${PORT}`;
  const title = `Free tokens ${name}`;

  await signInAsNewAccount(owner);
  await createCommunity(owner, name);
  await openPeople(owner);
  const inviteUrl = await makeInviteLink(owner);
  await owner.goto(`/c/${host}`);
  await owner.getByTestId("starter-boards").click();
  await expect(owner.getByTestId("board-nav-supporters")).toBeVisible({
    timeout: 30_000,
  });

  // A member posts on the supporters board and keeps it open.
  const member = await joinWithInvite(browser, inviteUrl, host);
  await member.goto(`http://${host}/c/${host}`);
  await member.getByTestId("board-nav-supporters").click({ timeout: 30_000 });
  await member.getByTestId("board-new-post").click();
  await member.getByPlaceholder("Title").fill(title);
  await member.getByTestId("board-composer-submit").click();
  const post = (page: typeof owner) =>
    page.getByTestId("board-post-title").filter({ hasText: title });
  await expect(post(member)).toBeVisible({ timeout: 30_000 });

  // The owner opens the post and removes it.
  await owner.getByTestId("board-nav-supporters").click();
  await expect(post(owner)).toBeVisible({ timeout: 30_000 });
  await post(owner).click();
  // Removing sits in the Moderate menu and asks for a reason (D98).
  await owner.getByTestId("board-moderate-post").click();
  await owner.getByTestId("board-remove-post").click();
  await owner.getByTestId("board-remove-dialog-reason").fill("Spam");
  await owner.getByTestId("board-remove-dialog-submit").click();

  // The member did not reload: it is gone from their board.
  await expect(post(member)).toHaveCount(0, { timeout: 30_000 });

  // The server deleted it: a reload does not bring it back.
  await member.reload();
  await member.getByTestId("board-nav-supporters").click({ timeout: 30_000 });
  await expect(post(member)).toHaveCount(0);
});
