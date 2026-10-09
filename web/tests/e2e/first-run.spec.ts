import { expect, test } from "@playwright/test";

import { createMockRelay } from "./mock-relay";

/**
 * The very first visit, as a person with no account and no saved anything:
 * sign up, find your way into the community, start an organization, and come
 * back to it after closing the tab. Everything here is a click a newcomer has
 * to make; nothing is signed in ahead of time.
 *
 * It also fails on any uncaught error or console error along the way, because
 * the first visit is where a broken page costs the most.
 */

const CHANNEL_ID = "0f0f0f0f-1111-2222-3333-444444444444";

const channel = {
  id: "chan-1",
  pubkey: "b".repeat(64),
  created_at: 100,
  kind: 39000,
  tags: [
    ["d", CHANNEL_ID],
    ["name", "general"],
  ],
  content: "",
  sig: "sig",
};

test("a newcomer can sign up, start an organization, and find it again", async ({
  page,
}) => {
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`console: ${message.text()}`);
  });

  page.on("requestfailed", (request) =>
    problems.push(`request failed: ${request.url()}`),
  );

  const relay = createMockRelay();
  relay.seed(channel);
  await relay.install(page);
  // The page reads the chain head on the front page; answer it so the visit
  // stays on this machine and anything else that fails is a real finding.
  await page.route("http://127.0.0.1:8545/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x10" }),
    }),
  );

  // 1. The front page offers sign-up, and signing up needs only a name.
  await page.goto("/");
  await page.getByTestId("create-identity-cta").first().click();
  await expect(page.getByTestId("onboarding-dialog")).toBeVisible();
  await page.getByTestId("onboarding-name").fill("Mira Okafor");
  await page.getByTestId("onboarding-create").click();

  // 2. The page reloads signed in, and the name reached the server.
  await expect(page.getByTestId("user-chip")).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(() =>
      relay.events
        .filter((event) => event.kind === 0)
        .map((event) => JSON.parse(event.content).name),
    )
    .toContain("Mira Okafor");

  // The account menu works with a mouse: an item opens its form instead of the
  // menu closing under the pointer.
  await page.getByTestId("user-chip").click();
  await page.getByRole("button", { name: "Edit profile" }).click();
  await expect(page.getByTestId("profile-name-input")).toHaveValue(
    "Mira Okafor",
  );
  await page.keyboard.press("Escape");

  // 3. Into the community, start an organization with one name and no helpers.
  await page.goto("/c/alpha.example.com");
  await page.getByTestId("content-pane").waitFor();
  await page.getByTestId("org-toggle").click();
  await expect(page.getByTestId("org-setup")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("org-setup-name").fill("Mira Films");
  await page.getByTestId("org-setup-next").click();
  await page.getByTestId("org-setup-next").click();
  await page.getByTestId("org-setup-next").click();
  await page.getByTestId("org-setup-create").click();
  await expect(page.getByTestId("org-setup")).toHaveCount(0, {
    timeout: 20_000,
  });
  await expect(page.getByText("Mira Films", { exact: true })).toBeVisible();

  // 4. Coming back later: still signed in, and the organization is there.
  await page.reload();
  await page.getByTestId("content-pane").waitFor();
  await expect(page.getByTestId("user-chip")).toBeVisible();
  // The page reopens on the view it was left on.
  await expect(page.getByText("Mira Films", { exact: true })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId("org-setup")).toHaveCount(0);

  expect(
    problems,
    "nothing may throw or log an error on a first visit",
  ).toEqual([]);
});
