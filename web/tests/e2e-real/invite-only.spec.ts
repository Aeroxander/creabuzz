import { expect, test } from "@playwright/test";

import {
  PORT,
  createCommunity,
  joinAsNewcomer,
  makeInviteLink,
  newPerson,
  openPeople,
  setAccess,
  signInAsNewAccount,
  unique,
} from "./community-helpers";

/**
 * Private communities and invite links, against a REAL server (`scripts/web-invite-only-e2e.sh` boots it with the
 * server-wide membership switch off, so what is tested is each community's own setting).
 *
 * Nothing is mocked. An owner makes a community and it is private by default; a stranger is turned away with a reason;
 * a one-person invite link lets exactly one person in and is refused for the next; the owner opens the community and the
 * stranger gets in; the owner closes it again and the stranger is out while the invited person stays. The public
 * directory never lists a community while it is private.
 */

test.use({ viewport: { width: 1280, height: 900 } });

test("a private community turns strangers away, an invite lets one person in, and the owner can open and close it", async ({
  page: owner,
  browser,
}) => {
  test.setTimeout(240_000);
  const name = unique();
  const host = `${name}.localhost:${PORT}`;
  const listed = async () => {
    const response = await owner.request.get(
      `http://localhost:${PORT}/communities`,
    );
    const body = (await response.json()) as {
      communities: { host: string }[];
    };
    return body.communities.map((community) => community.host);
  };

  // The owner makes a community and does not choose: it is private.
  await signInAsNewAccount(owner);
  await owner.goto("/c");
  await owner.getByTestId("create-community").click();
  await owner.getByTestId("community-name").fill(name);
  await expect(owner.getByTestId("community-access-invite_only")).toBeChecked();
  await owner.getByTestId("community-create-submit").click();
  await owner.waitForURL(new RegExp(`/c/${name}\\.localhost`), {
    timeout: 30_000,
  });
  await openPeople(owner);
  await expect(owner.getByTestId("access-invite_only")).toBeChecked({
    timeout: 30_000,
  });
  await expect(owner.getByTestId("person")).toHaveCount(1);
  expect(await listed()).not.toContain(host);

  // A one-person invite link, read from the page as the owner would copy it.
  await owner.getByTestId("invite-make").click();
  const inviteUrl = await owner.getByTestId("invite-link").inputValue({
    timeout: 30_000,
  });
  expect(inviteUrl).toContain(`${host}/invite/`);

  // A stranger who has the address but no invite is told it is private, and why.
  const stranger = await newPerson(browser);
  await stranger.goto(`http://${host}/c/${host}`);
  await expect(stranger.getByTestId("community-invite-only")).toBeVisible({
    timeout: 30_000,
  });
  await expect(stranger.getByTestId("community-invite-only")).toContainText(
    "invite link",
  );

  // The invite lets them in.
  await stranger.goto(inviteUrl);
  await stranger.getByRole("button", { name: "Join in browser" }).click();
  await stranger.waitForURL((url) => url.pathname === "/", { timeout: 30_000 });
  await stranger.goto(`http://${host}/c/${host}`);
  await expect(stranger.getByTestId("content-pane")).toBeVisible({
    timeout: 30_000,
  });
  await expect(stranger.getByTestId("community-invite-only")).toHaveCount(0);

  // The owner's list now has both of them.
  // A fresh load of the community (a reload would keep the Org view open, and opening it again would close it).
  await owner.goto(`/c/${host}`);
  await openPeople(owner);
  await expect(owner.getByTestId("person")).toHaveCount(2, {
    timeout: 30_000,
  });

  // The same link does not work for a second person, who is still turned away.
  const second = await newPerson(browser);
  await second.goto(inviteUrl);
  await second.getByRole("button", { name: "Join in browser" }).click();
  await expect(second.getByRole("alert")).toContainText("use limit", {
    timeout: 30_000,
  });
  await second.goto(`http://${host}/c/${host}`);
  await expect(second.getByTestId("community-invite-only")).toBeVisible({
    timeout: 30_000,
  });

  // The owner opens the community: the person who was turned away gets in, and it is in the public directory.
  await setAccess(owner, "open");
  await expect.poll(listed).toContain(host);
  await second.reload();
  await expect(second.getByTestId("content-pane")).toBeVisible({
    timeout: 30_000,
  });
  await expect(second.getByTestId("community-invite-only")).toHaveCount(0);

  // And closes it again: the person who was never invited is out, the invited person stays, and the directory drops it.
  await setAccess(owner, "invite_only");
  await expect.poll(listed).not.toContain(host);
  await second.reload();
  await expect(second.getByTestId("community-invite-only")).toBeVisible({
    timeout: 30_000,
  });
  await stranger.reload();
  await expect(stranger.getByTestId("content-pane")).toBeVisible({
    timeout: 30_000,
  });
  await expect(stranger.getByTestId("community-invite-only")).toHaveCount(0);

  // The setting is the server's, not the page's: it survives a reload.
  // A fresh load of the community (a reload would keep the Org view open, and opening it again would close it).
  await owner.goto(`/c/${host}`);
  await openPeople(owner);
  await expect(owner.getByTestId("access-invite_only")).toBeChecked({
    timeout: 30_000,
  });
});

test("an invited person is not offered the owner's controls", async ({
  page: owner,
  browser,
}) => {
  test.setTimeout(240_000);
  const name = unique();
  const host = `${name}.localhost:${PORT}`;
  await signInAsNewAccount(owner);
  await owner.goto("/c");
  await owner.getByTestId("create-community").click();
  await owner.getByTestId("community-name").fill(name);
  await owner.getByTestId("community-create-submit").click();
  await owner.waitForURL(new RegExp(`/c/${name}\\.localhost`), {
    timeout: 30_000,
  });
  await openPeople(owner);
  await owner.getByTestId("invite-make").click();
  const inviteUrl = await owner.getByTestId("invite-link").inputValue({
    timeout: 30_000,
  });

  const member = await newPerson(browser);
  await member.goto(inviteUrl);
  await member.getByRole("button", { name: "Join in browser" }).click();
  await member.waitForURL((url) => url.pathname === "/", { timeout: 30_000 });
  await member.goto(`http://${host}/c/${host}`);
  await openPeople(member);

  // A member sees who is in and the setting, and nothing to change.
  await expect(member.getByTestId("person")).toHaveCount(2, {
    timeout: 30_000,
  });
  await expect(member.getByTestId("access-summary")).toContainText(
    "invite link",
  );
  await expect(member.getByTestId("access-control")).toHaveCount(0);
  await expect(member.getByTestId("invite-maker")).toHaveCount(0);
});

test("an owner can end an invite that is still out there, and remove a person who joined", async ({
  page: owner,
  browser,
}) => {
  test.setTimeout(240_000);
  const name = unique();
  const host = `${name}.localhost:${PORT}`;
  await signInAsNewAccount(owner);
  await owner.goto("/c");
  await owner.getByTestId("create-community").click();
  await owner.getByTestId("community-name").fill(name);
  await owner.getByTestId("community-create-submit").click();
  await owner.waitForURL(new RegExp(`/c/${name}\\.localhost`), {
    timeout: 30_000,
  });
  await openPeople(owner);

  // A link for anyone who has it, listed as still working, then ended.
  await owner.getByTestId("invite-uses").selectOption("any");
  await owner.getByTestId("invite-make").click();
  const endedUrl = await owner.getByTestId("invite-link").inputValue({
    timeout: 30_000,
  });
  await expect(owner.getByTestId("active-invite")).toHaveCount(1, {
    timeout: 30_000,
  });
  await expect(owner.getByTestId("active-invite")).toContainText("0 used");
  await owner.getByTestId("invite-end").click();
  await expect(owner.getByTestId("active-invite")).toHaveCount(0, {
    timeout: 30_000,
  });

  // The ended link no longer lets anyone in.
  const late = await newPerson(browser);
  await late.goto(endedUrl);
  await late.getByRole("button", { name: "Join in browser" }).click();
  await expect(late.getByRole("alert")).toContainText("expired", {
    timeout: 30_000,
  });

  // A fresh link lets one person in; the owner then removes them and they are out.
  await owner.getByTestId("invite-uses").selectOption("one");
  await owner.getByTestId("invite-make").click();
  await expect
    .poll(() => owner.getByTestId("invite-link").inputValue(), {
      timeout: 30_000,
    })
    .not.toBe(endedUrl);
  const freshUrl = await owner.getByTestId("invite-link").inputValue();
  const joiner = await newPerson(browser);
  await joiner.goto(freshUrl);
  await joiner.getByRole("button", { name: "Join in browser" }).click();
  await joiner.waitForURL((url) => url.pathname === "/", { timeout: 30_000 });
  await joiner.goto(`http://${host}/c/${host}`);
  await expect(joiner.getByTestId("content-pane")).toBeVisible({
    timeout: 30_000,
  });

  await owner.goto(`/c/${host}`);
  await openPeople(owner);
  await expect(owner.getByTestId("person")).toHaveCount(2, {
    timeout: 30_000,
  });
  await owner.getByTestId("person-remove").click();
  await owner.getByTestId("person-remove-yes").click();
  await expect(owner.getByTestId("person")).toHaveCount(1, {
    timeout: 30_000,
  });

  await joiner.reload();
  await expect(joiner.getByTestId("community-invite-only")).toBeVisible({
    timeout: 30_000,
  });
});

test("someone with no account at all can make one from the invite link, join, and be named in the list", async ({
  page: owner,
  browser,
}) => {
  test.setTimeout(240_000);
  const name = unique();
  const host = `${name}.localhost:${PORT}`;
  await signInAsNewAccount(owner);
  await createCommunity(owner, name);
  await openPeople(owner);
  const inviteUrl = await makeInviteLink(owner);

  // No account, no extension, no passkey: just the link.
  const newcomer = await joinAsNewcomer(
    browser,
    inviteUrl,
    host,
    "Robin Reyes",
  );
  await newcomer.goto(`http://${host}/c/${host}`);
  await expect(newcomer.getByTestId("content-pane")).toBeVisible({
    timeout: 30_000,
  });
  await expect(newcomer.getByTestId("community-invite-only")).toHaveCount(0);

  // The owner sees them in the list, by the name they gave.
  await owner.goto(`/c/${host}`);
  await openPeople(owner);
  await expect(owner.getByTestId("person")).toHaveCount(2, {
    timeout: 30_000,
  });
  await expect(
    owner.getByTestId("person").filter({ hasText: "Robin Reyes" }),
  ).toBeVisible({ timeout: 30_000 });
});
