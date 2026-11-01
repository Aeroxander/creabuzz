import { expect, type Page, test } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";

import { COMMUNITY_HOST, createMockRelay } from "./mock-relay";

/**
 * The room composer's @-list by keyboard: Enter while suggestions are open picks the highlighted person and never sends
 * the half-typed name, and a mention deleted before sending tells nobody (no `p` tag). The rules themselves are pinned
 * in `src/features/channels/ui/composer-mentions.test.mjs`; this runs them in the real room.
 */

const CHANNEL_ID = "0f0f0f0f-1111-2222-3333-444444444444";
const NSEC = "a1".repeat(32);
const ME = getPublicKey(
  Uint8Array.from(NSEC.match(/.{2}/g) ?? [], (b) => Number.parseInt(b, 16)),
);
const ALICE = "e".repeat(64);

function seedRoom(relay: ReturnType<typeof createMockRelay>) {
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
    id: "1".repeat(64),
    pubkey: ALICE,
    created_at: 200,
    kind: 9,
    tags: [["h", CHANNEL_ID]],
    content: "Morning all",
    sig: "sig",
  });
  relay.seed({
    id: "2".repeat(64),
    pubkey: ALICE,
    created_at: 150,
    kind: 0,
    tags: [],
    content: JSON.stringify({ name: "alice", display_name: "Alice Archer" }),
    sig: "sig",
  });
}

async function openRoom(page: Page) {
  const relay = createMockRelay();
  seedRoom(relay);
  await page.addInitScript((nsec) => {
    window.localStorage.setItem("buzz.identity.nsec", nsec);
    window.localStorage.setItem("buzz.identity.backedUp", "1");
  }, NSEC);
  await relay.install(page);
  await page.goto(`/c/${COMMUNITY_HOST}?channel=${CHANNEL_ID}`);
  await expect(page.getByText("Morning all")).toBeVisible({ timeout: 20_000 });
  return relay;
}

const mine = (relay: ReturnType<typeof createMockRelay>) =>
  relay.events.filter((e) => e.kind === 9 && e.pubkey === ME);

test("Enter with the @-list open picks the person, and the sent message tags them", async ({
  page,
}) => {
  const relay = await openRoom(page);
  const box = page.getByTestId("composer-input");
  await box.click();
  await box.pressSequentially("hi @Ali");
  await expect(
    page.getByRole("option", { name: /Alice Archer/ }),
  ).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(box).toHaveValue("hi @Alice Archer ");
  expect(mine(relay)).toHaveLength(0);

  await box.pressSequentially("welcome");
  await page.keyboard.press("Enter");
  await expect.poll(() => mine(relay).length).toBe(1);
  const sent = mine(relay)[0];
  expect(sent.content).toBe("hi @Alice Archer welcome");
  expect(sent.tags).toContainEqual(["p", ALICE]);
});

test("Escape closes the @-list; a mention deleted before sending tells nobody", async ({
  page,
}) => {
  const relay = await openRoom(page);
  const box = page.getByTestId("composer-input");
  await box.click();
  await box.pressSequentially("@Ali");
  await expect(
    page.getByRole("option", { name: /Alice Archer/ }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("listbox", { name: "Mention suggestions" }),
  ).toHaveCount(0);
  await box.fill("");

  await box.pressSequentially("@Ali");
  await expect(
    page.getByRole("option", { name: /Alice Archer/ }),
  ).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(box).toHaveValue("@Alice Archer ");
  // The reader changes their mind and writes something else.
  await box.fill("never mind");
  await page.keyboard.press("Enter");
  await expect.poll(() => mine(relay).length).toBe(1);
  expect(mine(relay)[0].tags.filter((t) => t[0] === "p")).toEqual([]);
});
