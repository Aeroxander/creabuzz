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
 * Reporting, against a REAL server (`scripts/web-invite-only-e2e.sh`). An owner makes a community, posts to its feed and
 * invites someone. The invited person reports the owner's post; the report goes to the owner's moderation queue, where it
 * shows the reason and the note and who sent it. Nothing is removed because of it.
 */

test.use({ viewport: { width: 1280, height: 900 } });

test("a member reports a post and the owner sees it in the moderation queue", async ({
  page: owner,
  browser,
}) => {
  test.setTimeout(240_000);
  const name = unique();
  const host = `${name}.localhost:${PORT}`;
  const post = `Send me your seed phrase ${name}`;

  await signInAsNewAccount(owner);
  await createCommunity(owner, name);
  await openPeople(owner);
  const inviteUrl = await makeInviteLink(owner);

  // The owner posts to the community's social feed.
  await owner.goto("/social");
  await owner.getByTestId("social-composer-input").fill(post);
  await owner.getByTestId("social-composer-submit").click();
  await expect(
    owner.getByTestId("social-post").filter({ hasText: post }),
  ).toBeVisible({ timeout: 30_000 });

  // The invited person finds it and reports it.
  const member = await joinWithInvite(browser, inviteUrl, host);
  await member.goto(`http://${host}/social`);
  const theirs = member.getByTestId("social-post").filter({ hasText: post });
  await expect(theirs).toBeVisible({ timeout: 30_000 });
  await theirs.getByTestId("social-report").click();
  await member.getByTestId("report-reason-spam").check();
  await member.getByTestId("report-note").fill("asks for a seed phrase");
  await member.getByTestId("report-submit").click();
  await expect(member.getByTestId("report-form")).toHaveCount(0, {
    timeout: 30_000,
  });

  // The post is still there: a report removes nothing.
  await expect(theirs).toBeVisible();

  // The owner is a moderator, so the report is in their queue.
  await owner.goto(`/c/${host}`);
  await owner.getByTestId("moderation-toggle").click({ timeout: 30_000 });
  const row = owner.getByTestId("moderation-report-row");
  await expect(row).toHaveCount(1, { timeout: 30_000 });
  await expect(row).toContainText("asks for a seed phrase");
  await expect(row).toContainText("Spam");
});

test("a member reports a person from their profile and the owner sees it in the moderation queue", async ({
  page: owner,
  browser,
}) => {
  test.setTimeout(240_000);
  const name = unique();
  const host = `${name}.localhost:${PORT}`;
  const post = `Dm me for a loan ${name}`;

  await signInAsNewAccount(owner);
  await createCommunity(owner, name);
  await openPeople(owner);
  const inviteUrl = await makeInviteLink(owner);
  await owner.goto("/social");
  await owner.getByTestId("social-composer-input").fill(post);
  await owner.getByTestId("social-composer-submit").click();
  await expect(
    owner.getByTestId("social-post").filter({ hasText: post }),
  ).toBeVisible({ timeout: 30_000 });

  // The invited person opens the author's profile from their post and reports the person, not the post.
  const member = await joinWithInvite(browser, inviteUrl, host);
  await member.goto(`http://${host}/social`);
  const theirs = member.getByTestId("social-post").filter({ hasText: post });
  await expect(theirs).toBeVisible({ timeout: 30_000 });
  await theirs
    .getByRole("link", { name: /profile$/ })
    .first()
    .click();
  await member.getByTestId("profile-report").click({ timeout: 30_000 });
  await member.getByTestId("report-reason-impersonation").check();
  await member.getByTestId("report-note").fill("says they are the founder");
  await member.getByTestId("report-submit").click();
  await expect(member.getByTestId("report-form")).toHaveCount(0, {
    timeout: 30_000,
  });

  // The owner's queue has it, with the reason and the note.
  await owner.goto(`/c/${host}`);
  await owner.getByTestId("moderation-toggle").click({ timeout: 30_000 });
  const row = owner.getByTestId("moderation-report-row");
  await expect(row).toHaveCount(1, { timeout: 30_000 });
  await expect(row).toContainText("says they are the founder");
});

test("your own post offers no Report", async ({ page: owner }) => {
  test.setTimeout(120_000);
  const name = unique();
  await signInAsNewAccount(owner);
  await createCommunity(owner, name);
  await owner.goto("/social");
  await owner.getByTestId("social-composer-input").fill(`A post ${name}`);
  await owner.getByTestId("social-composer-submit").click();
  const mine = owner
    .getByTestId("social-post")
    .filter({ hasText: `A post ${name}` });
  await expect(mine).toBeVisible({ timeout: 30_000 });
  await expect(mine.getByTestId("social-report")).toHaveCount(0);
});
