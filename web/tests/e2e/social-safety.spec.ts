import { expect, test } from "@playwright/test";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import * as nip44 from "nostr-tools/nip44";

import { createDirectMessageWraps } from "../../src/features/social/lib/nip17.ts";
import { createMockRelay } from "./mock-relay";

/**
 * What a reader can do about another person: tell the moderators about them and stop seeing them, from a private
 * conversation and from their profile. A mute changes only what this reader sees (their conversation leaves the inbox and
 * comes back when they unmute); a report goes to the moderators and nothing else.
 */

const hexKey = (hex: string) =>
  Uint8Array.from(hex.match(/.{2}/g) ?? [], (b) => Number.parseInt(b, 16));
const ME_NSEC = "88".repeat(32);
const ME = getPublicKey(hexKey(ME_NSEC));
const ALICE_NSEC = "99".repeat(32);
const ALICE = getPublicKey(hexKey(ALICE_NSEC));
const now = () => Math.floor(Date.now() / 1000);

async function relayWithConversation() {
  const relay = createMockRelay();
  relay.seed({
    id: "a".repeat(64),
    pubkey: ALICE,
    kind: 0,
    created_at: now() - 500,
    tags: [],
    content: JSON.stringify({ name: "alice", display_name: "Alice Archer" }),
    sig: "sig",
  });
  const signer = {
    pubkey: ALICE,
    sign: async (template: {
      kind: number;
      tags: string[][];
      content: string;
    }) =>
      finalizeEvent(
        { created_at: now() - 60, ...template },
        hexKey(ALICE_NSEC),
      ),
    encrypt: async (peer: string, text: string) =>
      nip44.encrypt(text, nip44.getConversationKey(hexKey(ALICE_NSEC), peer)),
    decrypt: async (peer: string, text: string) =>
      nip44.decrypt(text, nip44.getConversationKey(hexKey(ALICE_NSEC), peer)),
  };
  const dm = await createDirectMessageWraps(
    signer as never,
    ME,
    "Hi, buy my coin at example dot com",
  );
  relay.seed(dm.toRecipient as never);
  return relay;
}

async function open(
  page: import("@playwright/test").Page,
  relay: ReturnType<typeof createMockRelay>,
  path: string,
) {
  await relay.install(page);
  await page.addInitScript((nsec) => {
    window.localStorage.setItem("buzz.identity.nsec", nsec);
    window.localStorage.setItem("buzz.identity.backedUp", "1");
  }, ME_NSEC);
  await page.goto(path);
}

test("a conversation can be reported, and muting it takes it out of the inbox until they are unmuted", async ({
  page,
}) => {
  const relay = await relayWithConversation();
  await open(page, relay, "/social/messages");
  const inbox = page.getByTestId("social-conversation");
  await expect(inbox).toContainText("Alice Archer", { timeout: 20_000 });

  await inbox.click();
  await expect(page.getByTestId("social-thread-messages")).toContainText(
    "buy my coin",
    { timeout: 20_000 },
  );

  // Report: the reason is chosen first, and what is sent names the person, with the reason on the tag.
  await page.getByTestId("conversation-report").click();
  await expect(page.getByRole("dialog")).toContainText("Report Alice Archer");
  await expect(page.getByTestId("report-submit")).toBeDisabled();
  await page.getByTestId("report-reason-spam").check();
  await page.getByTestId("report-submit").click();
  await expect(page.getByTestId("report-form")).toHaveCount(0);
  const reports = relay.events.filter((event) => event.kind === 1984);
  expect(reports).toHaveLength(1);
  expect(reports[0].tags).toEqual([["p", ALICE, "spam"]]);
  expect(reports[0].pubkey).toBe(ME);

  // Mute: the mute list names them, and the conversation leaves the inbox.
  await page.getByTestId("conversation-mute").click();
  await expect
    .poll(
      () =>
        relay.events.some(
          (event) =>
            event.kind === 10000 &&
            event.pubkey === ME &&
            event.tags.some((tag) => tag[0] === "p" && tag[1] === ALICE),
        ),
      { timeout: 15_000 },
    )
    .toBe(true);
  await page.getByRole("link", { name: "Back to messages" }).click();
  await expect(page.getByTestId("social-conversation")).toHaveCount(0);
  await expect(page.getByTestId("social-muted-hidden")).toContainText(
    "Hidden: 1 conversation with people you muted",
  );

  // Unmute from their profile: the conversation is back.
  await page.goto(`/u/${ALICE}`);
  await expect(page.getByTestId("profile-mute")).toHaveAttribute(
    "aria-pressed",
    "true",
    { timeout: 20_000 },
  );
  await page.getByTestId("profile-mute").click();
  await expect(page.getByTestId("profile-mute")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await page.getByRole("link", { name: "Messages" }).first().click();
  await expect(page.getByTestId("social-conversation")).toContainText(
    "Alice Archer",
    { timeout: 20_000 },
  );
  await expect(page.getByTestId("social-muted-hidden")).toHaveCount(0);
});

test("a profile offers Report on someone else and not on your own", async ({
  page,
}) => {
  const relay = await relayWithConversation();
  await open(page, relay, `/u/${ALICE}`);
  await expect(page.getByTestId("profile-report")).toBeVisible({
    timeout: 20_000,
  });
  await page.getByTestId("profile-report").click();
  await expect(page.getByRole("dialog")).toContainText("Report Alice Archer");
  await page.getByTestId("report-reason-impersonation").check();
  await page.getByTestId("report-note").fill("pretending to be a founder");
  await page.getByTestId("report-submit").click();
  await expect(page.getByTestId("report-form")).toHaveCount(0);
  const reports = relay.events.filter((event) => event.kind === 1984);
  expect(reports).toHaveLength(1);
  expect(reports[0].tags).toEqual([["p", ALICE, "impersonation"]]);
  expect(reports[0].content).toBe("pretending to be a founder");

  await page.goto(`/u/${ME}`);
  await expect(page.getByTestId("profile-edit")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId("profile-report")).toHaveCount(0);
  await expect(page.getByTestId("profile-mute")).toHaveCount(0);
});
