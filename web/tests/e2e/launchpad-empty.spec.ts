import { expect, test } from "@playwright/test";

import { createMockRelay } from "./mock-relay";

/**
 * The launchpad on a server where nobody has launched anything yet, which is what a first visitor sees. It says so and
 * offers the two ways forward; it does not also show a wall of filters that all read zero.
 */

test("an empty launchpad offers a way forward and no filters that would all read zero", async ({
  page,
}) => {
  const relay = createMockRelay();
  await relay.install(page);
  await page.goto("/launchpad");

  await expect(page.getByText("No launches yet. Start an idea")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId("sandbox-entry")).toBeVisible();
  await expect(page.getByTestId("start-idea")).toBeVisible();
  await expect(page.getByTestId("launch-chips")).toBeHidden();
  await expect(page.getByTestId("funding-chip-any")).toBeHidden();
});
