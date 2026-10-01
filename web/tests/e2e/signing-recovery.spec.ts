import { expect, test } from "@playwright/test";
import { wizardToPublish } from "../helpers/wizard";

import { createMockRelay } from "./mock-relay";

/**
 * The passkey gate in front of a private relay.
 *
 * A Buzz relay requires NIP-42 AUTH on every read. A registered passkey that
 * has not been unlocked this session cannot sign that challenge, so the query
 * never completes — and every surface used to report that as "the relay did
 * not answer", which sends the reader to debug their network when the only
 * fix is one sign-in tap. These tests pin the four-outcome contract:
 *
 * - locked -> `auth-required` with the sign-in action beside the refusal
 *   (launchpad, board, and the create dialog itself),
 * - signed in -> the same queries actually load,
 * - genuine empty -> the empty state, never an error.
 */

const FOUNDER_NSEC = "22".repeat(32);

const LOCKED_MESSAGE = "Unlock your passkey before this browser can sign.";

/** A registered passkey credential with nothing unlocked this session. */
function seedLockedPasskey(page: import("@playwright/test").Page) {
  return page.addInitScript(() => {
    // Public fields only: credential id, salt, pubkey — the key lives in
    // memory and there is none this session.
    window.localStorage.setItem("buzz.passkey.credentialId", "cred-1");
    window.localStorage.setItem("buzz.passkey.salt", "c2FsdA");
    window.localStorage.setItem("buzz.passkey.pubkey", "e".repeat(64));
    window.localStorage.setItem("buzz.passkey.mode", "prf");
    window.localStorage.removeItem("buzz.identity.nsec");
  });
}

function launchEvent() {
  return {
    id: "a".repeat(64),
    pubkey: "b".repeat(64),
    created_at: 1_000,
    kind: 37001,
    tags: [
      ["d", "nebula"],
      ["name", "Nebula DAO"],
      ["t", "dao-launchpad"],
      ["admission", "curated"],
    ],
    content: JSON.stringify({ pitch: "To the stars.", stage: "live" }),
    sig: "c".repeat(128),
  };
}

test("a locked passkey on the launchpad renders auth-required with the sign-in action", async ({
  page,
}) => {
  const relay = createMockRelay({ requireAuth: true });
  await seedLockedPasskey(page);
  await relay.install(page);
  await page.goto("/launchpad");

  const panel = page.getByTestId("launchpad-load-error");
  await expect(panel).toBeVisible({ timeout: 20_000 });

  // Not "did not answer": the relay required sign-in and this browser could
  // not sign the challenge.
  await expect(panel).toHaveAttribute("data-outcome", "auth-required");
  await expect(
    page.getByTestId("launchpad-load-error-description"),
  ).toContainText("This relay requires sign-in to load");
  await expect(page.getByTestId("launchpad-load-error-message")).toContainText(
    LOCKED_MESSAGE,
  );

  // Rule 6: the refusal is never terminal — the action sits beside it, and
  // the evidence (relay URL, retry) is on screen too.
  const action = panel.getByTestId("sign-recovery-action");
  await expect(action).toHaveText("Sign in with passkey");
  await expect(page.getByTestId("launchpad-load-error-relay")).toContainText(
    "ws://",
  );
  await expect(page.getByTestId("launchpad-load-error-retry")).toBeVisible();

  // The guard's own promise: no second, stray identity is minted while the
  // passkey is locked.
  const stored = await page.evaluate(() =>
    window.localStorage.getItem("buzz.identity.nsec"),
  );
  expect(stored, "a locked passkey must not mint a second key").toBeNull();
});

test("the project board renders auth-required with the sign-in action", async ({
  page,
}) => {
  const relay = createMockRelay({ requireAuth: true });
  await seedLockedPasskey(page);
  await relay.install(page);
  await page.goto("/projects");

  const panel = page.getByTestId("projects-load-error");
  await expect(panel).toBeVisible({ timeout: 20_000 });
  await expect(panel).toHaveAttribute("data-outcome", "auth-required");
  await expect(panel.getByTestId("sign-recovery-action")).toHaveText(
    "Sign in with passkey",
  );
  // The empty state must not be reachable from a failed read.
  await expect(page.getByTestId("board-empty")).toHaveCount(0);
});

test("a locked passkey's launch publish shows the recovery inside the dialog", async ({
  page,
}) => {
  const relay = createMockRelay({ requireAuth: true });
  await seedLockedPasskey(page);
  await relay.install(page);
  await page.goto("/launchpad");

  await page.getByRole("button", { name: "New launch" }).first().click();
  await page.getByTestId("launch-advanced").locator("> summary").click();
  await page.getByLabel("Launch id").fill("locked-launch");
  await page
    .getByTestId("wizard-step-token")
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Locked Launch");
  await wizardToPublish(page);
  await page.getByRole("button", { name: /Publish launch/ }).click();

  // The refusal and its way out render together, in the flow that demanded
  // the signature — no toast, no dead end, no bouncing to another page.
  await expect(page.getByTestId("launch-sign-recovery-message")).toContainText(
    LOCKED_MESSAGE,
  );
  await expect(page.getByTestId("launch-sign-recovery-action")).toHaveText(
    "Sign in with passkey",
  );
  // The dialog stays open: the reader's work is not thrown away.
  await expect(page.getByTestId("launch-as-agent")).toBeAttached();
});

test("signed in, the launchpad loads through the same AUTH challenge", async ({
  page,
}) => {
  const relay = createMockRelay({ requireAuth: true });
  relay.seed(launchEvent());
  await page.addInitScript(
    ([nsec]) => window.localStorage.setItem("buzz.identity.nsec", nsec),
    [FOUNDER_NSEC],
  );
  await relay.install(page);
  await page.goto("/launchpad");

  await expect(page.getByText("Nebula DAO")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("To the stars.")).toBeVisible();
  await expect(page.getByTestId("launchpad-load-error")).toHaveCount(0);
});

test("signed in with nothing stored, the board renders its empty state", async ({
  page,
}) => {
  // Success + zero events is a different outcome from a failure: the reader
  // is told the board is empty *and* offered the way to fill it.
  const relay = createMockRelay({ requireAuth: true });
  await page.addInitScript(
    ([nsec]) => window.localStorage.setItem("buzz.identity.nsec", nsec),
    [FOUNDER_NSEC],
  );
  await relay.install(page);
  await page.goto("/projects");

  await expect(page.getByTestId("board-empty")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId("projects-load-error")).toHaveCount(0);
});
