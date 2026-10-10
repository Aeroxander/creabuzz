import { expect, test } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";

import { createMockRelay } from "./mock-relay";

/**
 * Home's "Get started" list for someone who has just signed up. Every box is
 * ticked only for something that really happened in this browser, the first
 * three are the way in, and the last two are for later and never hold the list
 * open.
 */

const OWNER_NSEC = "55".repeat(32);
const OWNER = getPublicKey(
  Uint8Array.from(OWNER_NSEC.match(/.{2}/g) ?? [], (b) =>
    Number.parseInt(b, 16),
  ),
);

async function openHome(
  page: import("@playwright/test").Page,
  storage: Record<string, string> = {},
) {
  const relay = createMockRelay();
  relay.seed({
    id: "profile-1",
    pubkey: OWNER,
    created_at: 100,
    kind: 0,
    tags: [],
    content: JSON.stringify({ name: "Mira Okafor" }),
    sig: "sig",
  });
  await relay.install(page);
  await page.route("http://127.0.0.1:8545/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x10" }),
    }),
  );
  await page.addInitScript(
    ([nsec, extra]) => {
      window.localStorage.setItem("buzz.identity.nsec", nsec);
      for (const [key, value] of Object.entries(extra)) {
        window.localStorage.setItem(key, value);
      }
    },
    [OWNER_NSEC, storage] as const,
  );
  await page.goto("/");
}

test("a new account is asked to start a project and run a helper, and nothing is pre-ticked", async ({
  page,
}) => {
  await openHome(page);
  const list = page.getByTestId("home-getting-started");
  await expect(list).toBeVisible({ timeout: 20_000 });
  // The name is real (the profile above), the rest has not happened.
  await expect(list).toContainText("1 of 3 done");
  await expect(
    list.getByText("Start a project with a ready-made team"),
  ).toBeVisible();
  await expect(list.getByText("Put an AI helper to work")).toBeVisible();
  // The later steps are shown, marked as optional, and not counted.
  await expect(list.getByText("Optional. Their posts")).toBeVisible();
  await expect(
    list.getByText("Optional, for when you're ready."),
  ).toBeVisible();
  // A project and a helper both point at the communities, where they are made.
  await expect(list.getByRole("link", { name: "Go" }).first()).toHaveAttribute(
    "href",
    "/c",
  );
});

test("a helper started here ticks its box, and the list goes away when the way in is done", async ({
  page,
}) => {
  await openHome(page, { "creaton.first-steps": JSON.stringify(["project"]) });
  const list = page.getByTestId("home-getting-started");
  // Name and project are done; the helper is what is left. Seeing this first
  // is what makes the list's later absence mean something.
  await expect(list).toContainText("2 of 3 done", { timeout: 20_000 });

  // Run a helper (its key appears in this browser), then come back to Home.
  await page.evaluate(() =>
    window.localStorage.setItem("buzz.agent.nsec", "ab".repeat(32)),
  );
  await page.getByRole("link", { name: "Social" }).click();
  await expect(page).toHaveURL(/\/social/);
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Home", exact: true })
    .click();
  await expect(page.getByTestId("user-chip")).toBeVisible();
  await expect(page.getByTestId("home-getting-started")).toHaveCount(0);
});

test("with only the project done, the list says what is left", async ({
  page,
}) => {
  await openHome(page, { "creaton.first-steps": JSON.stringify(["project"]) });
  const list = page.getByTestId("home-getting-started");
  await expect(list).toContainText("2 of 3 done", { timeout: 20_000 });
});
