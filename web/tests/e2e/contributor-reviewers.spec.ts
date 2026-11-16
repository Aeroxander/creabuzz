import { expect, test } from "@playwright/test";

import { expectAccessible } from "../helpers/a11y";
import { createMockRelay } from "./mock-relay";

/**
 * Setting up Shares from a project started alone (D218): one reviewer is enough and the page says who then decides; a
 * server nobody has linked an account on says what to do instead of asking people to be found; a server that cannot
 * reach its network says so, in place of a wallet line that blames the account, with a way back (the walk of
 * 2026-11-16 showed both lines at once on a server with no chain node).
 */

const NSEC = "7".repeat(64);

async function openStartPage(page: import("@playwright/test").Page) {
  const relay = createMockRelay();
  await relay.install(page);
  await page.addInitScript((nsec) => {
    window.localStorage.setItem("buzz.identity.nsec", nsec);
    window.localStorage.setItem("buzz.identity.backedUp", "1");
    window.localStorage.setItem(
      "buzz.launchpad.rpc",
      `${window.location.origin}/test-rpc`,
    );
  }, NSEC);
  // The chain node refuses every call, as a server with no node behind it does.
  await page.route("**/test-rpc", (route) => route.abort("connectionrefused"));
  await page.goto("/start/contributor");
  await expect(page.getByTestId("contributor-form")).toBeVisible();
}

test("the reviewers box asks for one person and says one person decides", async ({
  page,
}) => {
  await openStartPage(page);
  const hint = page.getByText(/^Name at least one person/);
  await expect(hint).toContainText(
    "One reviewer means one person decides. Add more people later for more trust.",
  );
  await expect(page.getByTestId("contributor-form")).not.toContainText(
    /at least three|At least two must agree/,
  );
  // Nobody here linked an account: what to do, and that Shares are not needed to begin.
  const none = page.getByTestId("contributor-people-none");
  await expect(none).toContainText("Invite someone");
  await expect(none).toContainText("you do not need them to begin");
  await expect(none.getByTestId("contributor-people-leave")).toHaveText(
    "Back to Start",
  );
});

test("with no network the page says so in plain words, hides the wallet line and offers the way back", async ({
  page,
}) => {
  await openStartPage(page);
  const gate = page.getByTestId("contributor-gate");
  await expect(gate).toContainText(
    "Shares can't be set up right now: this server could not reach its network. You don't need Shares to start a project.",
    { timeout: 15_000 },
  );
  await expect(page.getByTestId("contributor-form")).not.toContainText(
    /you need a wallet|network setting/,
  );
  await expect(page.getByTestId("contributor-submit")).toBeDisabled();
  await expectAccessible(page, "contributor start page without a network");
  await gate.getByTestId("contributor-gate-leave").click();
  await expect(page).toHaveURL(/\/start$/);
});
