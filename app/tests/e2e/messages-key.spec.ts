import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { expectAccessible } from "../helpers/a11y";
import { expectNoSidewaysScroll } from "../helpers/layout";
import { PressCounter } from "../helpers/press-counter";
import { createMockRelay, PREVIEW_PORT } from "./mock-relay";
import { install } from "./helpers/world";
import { READER, READER_KEY, seedSocial } from "./helpers/social-world";

/**
 * Two small settings at phone width (360): the press that lets people on other apps message the reader here (the reader's
 * public message server list), and saving the recovery key to a file from You, behind a press, never drawn before it.
 */
test.use({ viewport: { width: 360, height: 740 } });

test("people on other apps can be let in with one press from Messages, and turned off again, keeping other servers", async ({
  page,
}) => {
  const relay = createMockRelay();
  seedSocial(relay);
  relay.seed({
    id: "f".repeat(64),
    kind: 10050,
    pubkey: READER,
    content: "",
    tags: [["relay", "wss://other.example"]],
    created_at: Math.floor(Date.now() / 1000) - 600,
    sig: "0".repeat(128),
  });
  await install(page, relay, READER_KEY);
  await page.goto("/you/messages");
  const card = page.getByTestId("message-server");
  await expect(card).toContainText(
    "This posts a public note saying which server to reach you on",
  );
  await expectAccessible(page, "message servers, off");
  const path = new PressCounter();
  await path.press(page.getByTestId("message-server-toggle"), "Turn on");
  await expect(card).toContainText(
    "People using other apps can message you here",
  );
  const list = relay.events
    .filter((e) => e.kind === 10050 && e.pubkey === READER)
    .sort((a, b) => b.created_at - a.created_at)[0];
  expect(list.tags).toEqual([
    ["relay", "wss://other.example"],
    ["relay", `ws://127.0.0.1:${PREVIEW_PORT}`],
  ]);
  // Still on after a reload, and turning off takes away only this server.
  await page.reload();
  await expect(page.getByTestId("message-server-toggle")).toHaveText(
    "Turn off",
  );
  await page.getByTestId("message-server-toggle").click();
  await expect(page.getByTestId("message-server-toggle")).toHaveText("Turn on");
  const off = relay.events
    .filter((e) => e.kind === 10050 && e.pubkey === READER)
    .sort((a, b) => b.created_at - a.created_at)[0];
  expect(off.tags).toEqual([["relay", "wss://other.example"]]);
  await expectNoSidewaysScroll(page, "messages with the server card");
});

test("the recovery key is saved to a file from You, only on a press, and is never drawn or logged before it", async ({
  page,
}) => {
  const relay = createMockRelay();
  seedSocial(relay);
  const logs: string[] = [];
  page.on("console", (message) => logs.push(message.text()));
  await install(page, relay, READER_KEY);
  await page.goto("/you");
  const path = new PressCounter();
  await path.press(page.getByRole("tab", { name: "Account" }), "Account");
  await path.press(
    page.getByRole("button", { name: "Save your recovery key" }),
    "Save your recovery key",
  );
  const key = page.getByTestId("backup-key");
  await expect(key).toBeVisible();
  // Not on the screen, not even in part, until Reveal is pressed.
  await expect(page.locator("body")).not.toContainText(READER_KEY.slice(0, 8));
  await expect(page.locator("body")).not.toContainText(READER_KEY.slice(-8));
  await expectAccessible(page, "recovery key, hidden");
  const download = page.waitForEvent("download");
  await path.press(page.getByTestId("backup-download"), "Download");
  const file = await download;
  expect(file.suggestedFilename()).toBe(
    `creaton-recovery-key-${READER.slice(0, 8)}.key`,
  );
  const path_ = await file.path();
  expect(readFileSync(path_, "utf8")).toBe(READER_KEY);
  // Saving it did not draw it.
  await expect(page.locator("body")).not.toContainText(READER_KEY.slice(0, 8));
  await page.getByTestId("backup-reveal").click();
  await expect(key).toHaveText(READER_KEY);
  await expectNoSidewaysScroll(page, "recovery key, shown");
  expect(logs.join("\n")).not.toContain(READER_KEY);
});
