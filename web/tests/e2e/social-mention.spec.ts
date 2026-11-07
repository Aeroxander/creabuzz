import { expect, test } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";

import { createMockRelay } from "./mock-relay";

/**
 * Choosing someone from the @-list in the post box, then carrying on typing at once. The caret has to be right behind the
 * mention in the same moment the mention is written in; a key typed in the next few milliseconds must land there, not at the
 * end of the box with the rest of the sentence then going in front of it.
 */

const NSEC = "77".repeat(32);
const ME = getPublicKey(
  Uint8Array.from(NSEC.match(/.{2}/g) ?? [], (b) => Number.parseInt(b, 16)),
);
const ALICE = "b".repeat(64);
const now = () => Math.floor(Date.now() / 1000);

test("typing straight after choosing a mention goes right behind it", async ({
  page,
}) => {
  const relay = createMockRelay();
  relay.seed({
    id: "1".repeat(64),
    pubkey: ME,
    kind: 3,
    created_at: now() - 100,
    tags: [["p", ALICE]],
    content: "",
    sig: "sig",
  });
  relay.seed({
    id: "2".repeat(64),
    pubkey: ALICE,
    kind: 0,
    created_at: now() - 100,
    tags: [],
    content: JSON.stringify({ name: "alice", display_name: "Alice Archer" }),
    sig: "sig",
  });
  await relay.install(page);
  await page.addInitScript((nsec) => {
    window.localStorage.setItem("buzz.identity.nsec", nsec);
    window.localStorage.setItem("buzz.identity.backedUp", "1");
  }, NSEC);
  await page.goto("/");

  const box = page.getByTestId("social-composer-input");
  await box.click();
  await box.pressSequentially("hello @Alic");
  await page.getByRole("option", { name: /Alice Archer/ }).click();
  // No pause: the next key arrives before the next frame.
  await box.pressSequentially("welcome to the room");

  await expect(box).toHaveValue(/^hello nostr:npub1\w+ welcome to the room$/);
});
