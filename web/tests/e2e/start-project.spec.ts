import { expect, test } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";

import { createMockRelay } from "./mock-relay";

/**
 * Starting a project from a ready-made team, in the browser: the picker, what
 * gets written (counted by kind, read back from the server), opening the first
 * channel, and what happens when the server refuses a step. The mock server
 * keeps what it is sent and derives a channel's record from its creation, as
 * the real one does.
 */

const NSEC = "44".repeat(32);
const ME = getPublicKey(
  Uint8Array.from(NSEC.match(/.{2}/g) ?? [], (b) => Number.parseInt(b, 16)),
);
const TEMPLATE = "ai-media-studio";

const general = {
  id: "chan-general",
  pubkey: "b".repeat(64),
  created_at: 100,
  kind: 39000,
  tags: [
    ["d", "0f0f0f0f-1111-2222-3333-444444444444"],
    ["name", "general"],
  ],
  content: "",
  sig: "sig",
};

async function open(
  page: import("@playwright/test").Page,
  relay: ReturnType<typeof createMockRelay>,
  { signedIn = true } = {},
) {
  await relay.install(page);
  if (signedIn) {
    await page.addInitScript((nsec) => {
      window.localStorage.setItem("buzz.identity.nsec", nsec);
    }, NSEC);
  }
  await page.goto("/c/alpha.example.com");
  await page.getByTestId("content-pane").waitFor();
  await page.getByTestId("start-project-toggle").click();
}

function count(
  relay: ReturnType<typeof createMockRelay>,
  kind: number,
  marked = true,
) {
  return relay.events.filter(
    (event) =>
      event.kind === kind &&
      (!marked || event.tags.some((t) => t[0] === "t" && t[1] === TEMPLATE)),
  ).length;
}

test("a team is picked, set up step by step, and its first channel opens", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const relay = createMockRelay({ deriveChannels: true });
  relay.seed(general);
  await open(page, relay);

  // Every bundled team is offered, and each says who it is for.
  const picker = page.getByTestId("start-project");
  await expect(picker).toBeVisible();
  await expect(
    page.getByTestId("template-option-ai-media-studio"),
  ).toBeChecked();
  await expect(picker).toContainText(
    "For filmmakers, musicians and audio storytellers",
  );
  await expect(picker).toContainText("Web & App Studio");
  await expect(picker).toContainText(
    "4 channels · 6 AI helpers · 3 shared pages",
  );

  // The preview says what will be made, in plain words.
  const preview = page.getByTestId("template-preview");
  await expect(preview).toContainText("#writers-room");
  await expect(preview).toContainText("The Writer");
  await expect(preview).toContainText(
    "Each helper can run 200 times, start 20 tasks",
  );
  await expect(preview).toContainText(
    "in this browser, on the server, or on your computer",
  );

  await page.getByTestId("start-project-confirm").click();
  await expect(page.getByTestId("start-project-done")).toBeVisible({
    timeout: 60_000,
  });

  // What was written, read back from the server.
  expect(count(relay, 9007, false)).toBe(4); // the four channels
  expect(count(relay, 9)).toBe(5); // four first messages and the welcome
  expect(count(relay, 30175)).toBe(6); // helpers
  expect(count(relay, 37010)).toBe(7); // the founder seat and six helper seats
  expect(count(relay, 37012)).toBe(1); // the default limit
  expect(count(relay, 30620)).toBe(2); // automations
  expect(count(relay, 44001)).toBe(3); // shared pages
  expect(count(relay, 30180)).toBe(1); // a skill
  // The founder seat is held by the person who set it up.
  const root = relay.events.find(
    (e) =>
      e.kind === 37010 && e.tags.some((t) => t[0] === "d" && t[1] === "root"),
  );
  expect(root?.pubkey).toBe(ME);
  expect(JSON.parse(root?.content ?? "{}").holders).toEqual([ME]);

  // The first channel opens on its first message, and the channel list has it.
  await page.getByTestId("start-project-open-channel").click();
  await expect(page.getByTestId("composer-input")).toBeVisible();
  await expect(page.getByText("Welcome to the writing table")).toBeVisible();
  await expect(page.getByText("writers-room").first()).toBeVisible();
});

test("a refused step says what to do, keeps what went through, and Try again finishes without repeating anything", async ({
  page,
}) => {
  test.setTimeout(120_000);
  let refuseOrg = true;
  const relay = createMockRelay({
    deriveChannels: true,
    refuse: (event) =>
      refuseOrg && event.kind === 37010
        ? "restricted: only the community owner may publish an org root"
        : null,
  });
  relay.seed(general);
  await open(page, relay);
  await page.getByTestId("start-project-confirm").click();

  await expect(page.getByTestId("start-project-problem-text")).toContainText(
    "Only this community's owner or an admin can set up the team",
    { timeout: 60_000 },
  );
  await expect(page.getByTestId("start-project-problem-text")).toContainText(
    "Whatever already went through is kept",
  );
  // Everything before the team went through; nothing after it was tried.
  expect(count(relay, 9007, false)).toBe(4);
  expect(count(relay, 30175)).toBe(6);
  expect(count(relay, 37010)).toBe(0);
  expect(count(relay, 44001)).toBe(0);

  refuseOrg = false;
  await page.getByTestId("start-project-retry").click();
  await expect(page.getByTestId("start-project-done")).toBeVisible({
    timeout: 60_000,
  });
  // Finished from where it stopped: nothing was written twice.
  expect(count(relay, 9007, false)).toBe(4);
  expect(count(relay, 9)).toBe(5);
  expect(count(relay, 30175)).toBe(6);
  expect(count(relay, 37010)).toBe(7);
  expect(count(relay, 44001)).toBe(3);
});

test("someone without an account is asked to create one first", async ({
  page,
}) => {
  const relay = createMockRelay();
  relay.seed(general);
  await open(page, relay, { signedIn: false });
  await expect(page.getByTestId("start-project-confirm")).toHaveCount(0);
  await page.getByTestId("start-project-sign-up").click();
  await expect(page.getByTestId("onboarding-dialog")).toBeVisible();
});
