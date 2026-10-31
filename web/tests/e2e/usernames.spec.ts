import { getPublicKey } from "nostr-tools/pure";
import { expect, test } from "@playwright/test";

import { createMockRelay } from "./mock-relay";
import { truncatePubkey } from "../../src/shared/lib/pubkey";

/**
 * Usernames in the web client.
 *
 * Every person is labelled with a username — `display_name`, the kind-0 `name`,
 * then the community NIP-05 username — and is "Someone" (your own account: "Your
 * account") when they have set none, never a short key. These bind that contract
 * to the surfaces that render it.
 */

const CHANNEL_ID = "0f0f0f0f-1111-2222-3333-444444444444";
const NSEC = "1".repeat(64);

function identityPubkey(nsec: string): string {
  return getPublicKey(
    Uint8Array.from(nsec.match(/.{2}/g) ?? [], (byte) =>
      Number.parseInt(byte, 16),
    ),
  );
}

const SELF = identityPubkey(NSEC);
/** Somebody else in the community — a decoy whose profile is newer than SELF's. */
const TEAMMATE = "c".repeat(64);

async function mountWithProfile(
  page: import("@playwright/test").Page,
  content: Record<string, unknown>,
) {
  await page.addInitScript(
    ([key]) => window.localStorage.setItem("buzz.identity.nsec", key),
    [NSEC],
  );
  const relay = createMockRelay();
  relay.seed({
    id: "chan-event-1",
    pubkey: "b".repeat(64),
    created_at: 100,
    kind: 39000,
    tags: [
      ["d", CHANNEL_ID],
      ["name", "general"],
    ],
    content: "",
    sig: "sig",
  });
  relay.seed({
    id: "profile-1",
    pubkey: SELF,
    created_at: 200,
    kind: 0,
    tags: [],
    content: JSON.stringify(content),
    sig: "sig",
  });
  // A newer profile for somebody else. Profile reads ask by `authors` with
  // `limit = author count`, so a mock that ignored the filter would answer the
  // one-author query with this event and leave the identity under test
  // nameless — a failure that would say nothing about the app.
  relay.seed({
    id: "profile-decoy",
    pubkey: TEAMMATE,
    created_at: 300,
    kind: 0,
    tags: [],
    content: JSON.stringify({
      display_name: "Decoy",
      nip05: "decoy@alpha.example.com",
    }),
    sig: "sig",
  });
  await relay.install(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/c/alpha.example.com?channel=${CHANNEL_ID}`);
  await page.getByTestId("content-pane").waitFor();
  await page.getByTestId("user-chip").waitFor();
}

test("the user chip shows the community username when the identity has one", async ({
  page,
}) => {
  await mountWithProfile(page, {
    display_name: "Tessa",
    nip05: "tessa@alpha.example.com",
  });

  const chip = page.getByTestId("user-chip");
  await expect(chip).toContainText("Tessa");
  await expect(chip).not.toContainText("Decoy");
  // The username, not the pubkey: a reader can use `tessa@alpha.example.com`;
  // the hex only identifies.
  await expect(page.getByTestId("user-chip-username")).toHaveText(
    "tessa@alpha.example.com",
  );
  await expect(chip).not.toContainText(truncatePubkey(SELF));
  // The identity that signs is still reachable, on the tooltip.
  await expect(page.getByTestId("user-chip-username")).toHaveAttribute(
    "title",
    SELF,
  );
});

test("an identity with a name and no username shows no key beside the name", async ({
  page,
}) => {
  await mountWithProfile(page, { display_name: "Tessa" });

  const chip = page.getByTestId("user-chip");
  await expect(chip).toContainText("Tessa");
  await expect(chip).not.toContainText("Decoy");
  // A short key is not a handle: printed beside a real name it reads as one.
  await expect(page.getByTestId("user-chip-username")).toHaveText("");
  await expect(chip).not.toContainText(truncatePubkey(SELF));
  // The identity that signs is still reachable, on the tooltip.
  await expect(page.getByTestId("user-chip-username")).toHaveAttribute(
    "title",
    SELF,
  );
});

test("an identity with no name is Your account to its owner, never a key", async ({
  page,
}) => {
  await mountWithProfile(page, { about: "no name yet" });

  const chip = page.getByTestId("user-chip");
  await expect(chip).toContainText("Your account");
  await expect(chip).not.toContainText(truncatePubkey(SELF));
});

test("the profile menu header shows the username", async ({ page }) => {
  await mountWithProfile(page, {
    display_name: "Tessa",
    nip05: "tessa@alpha.example.com",
  });

  await page.getByTestId("user-chip").click();
  await expect(page.getByTestId("profile-menu-username")).toHaveText(
    "tessa@alpha.example.com",
  );
});
