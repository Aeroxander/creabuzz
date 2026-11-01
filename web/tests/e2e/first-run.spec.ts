import { expect, test } from "@playwright/test";

import { expectAccessible } from "../helpers/a11y";
import { COMMUNITY_HOST, createMockRelay } from "./mock-relay";

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
  await page.goto(`/c/${COMMUNITY_HOST}`);
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

test("an account made before any community answers keeps its name, and saves it once one does", async ({
  page,
}) => {
  // The first person on a fresh deployment has no community to write to, and cannot make one without an account.
  let answering = false;
  const relay = createMockRelay({
    refuse: (event) =>
      !answering && event.kind === 0
        ? "error: no community is configured for this host"
        : undefined,
  });
  relay.seed(channel);
  await relay.install(page);
  await page.route("http://127.0.0.1:8545/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x10" }),
    }),
  );

  await page.goto("/");
  await page.getByTestId("create-identity-cta").first().click();
  await page.getByTestId("onboarding-name").fill("Frida Founder");
  await page.getByTestId("onboarding-create").click();

  // The account is made, and signed in, though nothing could be saved.
  await expect(page.getByTestId("user-chip")).toBeVisible({ timeout: 20_000 });
  expect(relay.events.filter((event) => event.kind === 0)).toHaveLength(0);

  // A community answers: the name typed at sign-up is saved, once.
  answering = true;
  await page.reload();
  await expect
    .poll(() =>
      relay.events
        .filter((event) => event.kind === 0)
        .map((event) => JSON.parse(event.content).name),
    )
    .toEqual(["Frida Founder"]);

  // And it is not saved again on the next load.
  await page.reload();
  await page.getByTestId("user-chip").waitFor();
  await page.waitForTimeout(1_000);
  expect(relay.events.filter((event) => event.kind === 0)).toHaveLength(1);
});

test("a person who joins another community is given their profile there, once, and a profile it already has is left alone", async ({
  page,
}) => {
  const first = createMockRelay();
  first.seed(channel);
  await first.install(page);
  await page.route("http://127.0.0.1:8545/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x10" }),
    }),
  );
  await page.goto("/");
  await page.getByTestId("create-identity-cta").first().click();
  await page.getByTestId("onboarding-name").fill("Frida Founder");
  await page.getByTestId("onboarding-create").click();
  await expect(page.getByTestId("user-chip")).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(() => first.events.filter((event) => event.kind === 0).length)
    .toBe(1);
  const pubkey = first.events.find((event) => event.kind === 0)?.pubkey ?? "";

  // A second community knows nothing about this person: they are given their profile there, and only once.
  await page.unrouteAll({ behavior: "wait" });
  await page.route("http://127.0.0.1:8545/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x10" }),
    }),
  );
  const second = createMockRelay();
  second.seed(channel);
  await second.install(page);
  await page.reload();
  await expect
    .poll(() =>
      second.events
        .filter((event) => event.kind === 0)
        .map((event) => JSON.parse(event.content).name),
    )
    .toEqual(["Frida Founder"]);
  await page.reload();
  await page.getByTestId("user-chip").waitFor();
  await page.waitForTimeout(1_000);
  expect(second.events.filter((event) => event.kind === 0)).toHaveLength(1);

  // A third community that already has a profile for them keeps it: theirs there is not replaced by the remembered one.
  await page.unrouteAll({ behavior: "wait" });
  await page.route("http://127.0.0.1:8545/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x10" }),
    }),
  );
  const third = createMockRelay();
  third.seed(channel);
  third.seed({
    id: "their-profile",
    pubkey,
    kind: 0,
    created_at: 50,
    tags: [],
    content: JSON.stringify({ name: "Frida the Founder" }),
    sig: "sig",
  });
  await third.install(page);
  await page.reload();
  await page.getByTestId("user-chip").waitFor();
  await page.waitForTimeout(1_500);
  expect(
    third.events
      .filter((event) => event.kind === 0)
      .map((event) => JSON.parse(event.content).name),
  ).toEqual(["Frida the Founder"]);
});

test("the top bar says Testnet beside the logo while the build cannot reach real money", async ({
  page,
}) => {
  const relay = createMockRelay();
  relay.seed(channel);
  await relay.install(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  const chip = page.getByTestId("testnet-chip");
  await expect(chip).toBeVisible();
  await expectAccessible(page, "Home with the Testnet tag");
  await expect(chip).toHaveText("Testnet");
  // Beside the logo, not somewhere else in the bar.
  const logo = await page
    .getByRole("link", { name: /home$/i })
    .first()
    .boundingBox();
  const tag = await chip.boundingBox();
  expect(logo && tag && tag.x >= logo.x + logo.width - 1).toBe(true);
  expect(Math.abs((logo?.y ?? 0) - (tag?.y ?? 0))).toBeLessThan(40);
});
