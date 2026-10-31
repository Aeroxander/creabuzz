import { expect, test, type Page } from "@playwright/test";
import { getPublicKey, verifyEvent } from "nostr-tools/pure";

import { expectAccessible } from "../helpers/a11y";
import { expectNoSidewaysScroll, PHONE } from "../helpers/layout";
import { createMockRelay } from "./mock-relay";

/**
 * Starting a community of your own, from the browser. The server's two routes are answered here, so the spec checks what
 * the app sends (a request signed by the person's account, for exactly this address and body) and what it does with each
 * answer. The server's own rules are covered by its tests and by `scripts/web-self-serve-e2e.sh`.
 */

const NSEC = "22".repeat(32);
const ME = getPublicKey(
  Uint8Array.from(NSEC.match(/.{2}/g) ?? [], (b) => Number.parseInt(b, 16)),
);

type Answer =
  | { status: 201; host: string }
  | { status: 409 | 400 | 429; code: string; error: string };

interface Sent {
  authorization: string | undefined;
  body: string | null;
}

async function open(
  page: Page,
  options: {
    enabled?: boolean;
    answer?: Answer;
    signedIn?: boolean;
  } = {},
) {
  const { enabled = true, answer, signedIn = true } = options;
  const sent: Sent[] = [];
  const relay = createMockRelay();
  await relay.install(page);
  if (signedIn) {
    await page.addInitScript((nsec) => {
      window.localStorage.setItem("buzz.identity.nsec", nsec);
    }, NSEC);
  }
  await page.route("**/self-serve/communities", async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      if (!enabled) return route.fulfill({ status: 404, body: "" });
      return route.fulfill({
        json: {
          enabled: true,
          domain: "example.test",
          min_name_length: 3,
          max_name_length: 32,
        },
      });
    }
    sent.push({
      authorization: request.headers().authorization,
      body: request.postData(),
    });
    const reply = answer ?? {
      status: 201 as const,
      host: "unused.example.test",
    };
    if (reply.status === 201) {
      return route.fulfill({
        status: 201,
        json: {
          community_id: "00000000-0000-0000-0000-000000000001",
          host: reply.host,
          url: `ws://${reply.host}`,
          owner_pubkey: ME,
        },
      });
    }
    return route.fulfill({
      status: reply.status,
      json: { code: reply.code, error: reply.error },
    });
  });
  await page.goto("/c");
  return sent;
}

test("a server that offers it shows the button, tidies the name and previews the address", async ({
  page,
}) => {
  await open(page);
  await page.getByTestId("create-community").click();
  const input = page.getByTestId("community-name");
  await expect(page.getByTestId("community-address")).toContainText(
    "your name followed by example.test, like my-film.example.test",
  );
  // The button says why it is not ready yet.
  await expect(page.getByTestId("community-create-submit")).toBeDisabled();
  await expect(page.getByTestId("community-create-why")).toHaveText(
    "Give it a name first.",
  );
  await input.fill("My Film Crew!");
  await expect(input).toHaveValue("my-film-crew");
  await expect(page.getByTestId("community-address")).toContainText(
    "my-film-crew.example.test",
  );
  await expect(page.getByTestId("community-name-problem")).toHaveCount(0);
  await expect(page.getByTestId("community-create-submit")).toBeEnabled();
});

test("a new community is open by default, and the creator can choose invite-only with one press", async ({
  page,
}) => {
  const sent = await open(page, {
    answer: { status: 201, host: "town-hall.example.test" },
  });
  await page.getByTestId("create-community").click();
  // Two choices side by side, open first and already chosen.
  await expect(page.getByTestId("community-access-open")).toBeChecked();
  await expect(
    page.getByTestId("community-access-invite_only"),
  ).not.toBeChecked();

  await page.getByText("Only people I invite").click();
  await expect(page.getByTestId("community-access-invite_only")).toBeChecked();
  await expect(page.getByTestId("community-access-open")).not.toBeChecked();
  await page.getByTestId("community-name").fill("town-hall");
  await page.getByTestId("community-create-submit").click();
  await page.waitForURL(/\/c\/town-hall\.example\.test$/, { timeout: 20_000 });
  expect(JSON.parse(sent[0].body ?? "{}")).toEqual({
    name: "town-hall",
    access: "invite_only",
  });
});

test("leaving the choice alone makes an open community", async ({ page }) => {
  const sent = await open(page, {
    answer: { status: 201, host: "town-hall.example.test" },
  });
  await page.getByTestId("create-community").click();
  await page.getByTestId("community-name").fill("town-hall");
  await page.getByTestId("community-create-submit").click();
  await page.waitForURL(/\/c\/town-hall\.example\.test$/, { timeout: 20_000 });
  expect(JSON.parse(sent[0].body ?? "{}")).toEqual({
    name: "town-hall",
    access: "open",
  });
});

test("the two choices sit side by side on a desktop", async ({ page }) => {
  await open(page, { answer: { status: 201, host: "town-hall.example.test" } });
  await page.getByTestId("create-community").click();
  const left = page.getByTestId("community-access-open").locator("..");
  const right = page.getByTestId("community-access-invite_only").locator("..");
  const a = await left.boundingBox();
  const b = await right.boundingBox();
  expect(a && b && Math.abs(a.y - b.y) < 2 && b.x > a.x).toBe(true);
});

test("a name that is too short is explained and cannot be sent", async ({
  page,
}) => {
  const sent = await open(page);
  await page.getByTestId("create-community").click();
  await page.getByTestId("community-name").fill("ab");
  await expect(page.getByTestId("community-name-problem")).toContainText(
    "at least 3",
  );
  await expect(page.getByTestId("community-create-submit")).toBeDisabled();
  expect(sent).toHaveLength(0);
});

test("creating signs the request with the account, then opens the new community", async ({
  page,
}) => {
  const sent = await open(page, {
    answer: { status: 201, host: "my-film.example.test" },
  });
  await page.getByTestId("create-community").click();
  await page.getByTestId("community-name").fill("my-film");
  await page.getByTestId("community-create-submit").click();

  await page.waitForURL(/\/c\/my-film\.example\.test$/, { timeout: 20_000 });
  // This browser now points at the new community.
  expect(
    await page.evaluate(() => window.localStorage.getItem("buzz.relayUrl")),
  ).toBe("ws://my-film.example.test");

  expect(sent).toHaveLength(1);
  // Open unless the creator says otherwise.
  expect(JSON.parse(sent[0].body ?? "{}")).toEqual({
    name: "my-film",
    access: "open",
  });
  const header = sent[0].authorization ?? "";
  expect(header.startsWith("Nostr ")).toBe(true);
  const event = JSON.parse(atob(header.slice("Nostr ".length)));
  // A valid signature by this person's account, for exactly this address, method and body.
  expect(verifyEvent(event)).toBe(true);
  expect(event.pubkey).toBe(ME);
  expect(event.kind).toBe(27235);
  const tag = (name: string) =>
    event.tags.find((t: string[]) => t[0] === name)?.[1];
  expect(tag("u")).toBe(`${new URL(page.url()).origin}/self-serve/communities`);
  expect(tag("method")).toBe("POST");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(sent[0].body ?? ""),
  );
  expect(tag("payload")).toBe(
    Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(""),
  );
});

test("a name that is taken shows the server's words and leaves the dialog open", async ({
  page,
}) => {
  await open(page, {
    answer: {
      status: 409,
      code: "name_taken",
      error: "That name is taken. Pick another.",
    },
  });
  await page.getByTestId("create-community").click();
  await page.getByTestId("community-name").fill("acme");
  await page.getByTestId("community-create-submit").click();
  await expect(page.getByTestId("community-create-error")).toHaveText(
    "That name is taken. Pick another.",
  );
  await expect(page.getByTestId("community-name")).toHaveValue("acme");
  // Nothing was stored: this browser still points where it did.
  expect(
    await page.evaluate(() => window.localStorage.getItem("buzz.relayUrl")),
  ).not.toBe("ws://acme.example.test");
  // Typing again clears the old answer.
  await page.getByTestId("community-name").fill("acme2");
  await expect(page.getByTestId("community-create-error")).toHaveCount(0);
});

test("a server that does not offer it shows no button", async ({ page }) => {
  await open(page, { enabled: false });
  await expect(
    page.getByRole("heading", { name: "Communities" }),
  ).toBeVisible();
  await expect(page.getByTestId("create-community")).toHaveCount(0);
});

test("without an account the dialog says to create one and cannot be sent", async ({
  page,
}) => {
  const sent = await open(page, { signedIn: false });
  await page.getByTestId("create-community").click();
  await page.getByTestId("community-name").fill("my-film");
  await expect(page.getByTestId("community-needs-account")).toContainText(
    "Create your account",
  );
  await expect(page.getByTestId("community-create-submit")).toBeDisabled();
  expect(sent).toHaveLength(0);
});

test("the create dialog is accessible, with a name problem showing", async ({
  page,
}) => {
  await open(page);
  await page.getByTestId("create-community").click();
  await page.getByTestId("community-name").fill("ab");
  await expect(page.getByTestId("community-name-problem")).toBeVisible();
  await expectAccessible(page, "create a community");
});

test("the create dialog fits a phone", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await open(page);
  await page.getByTestId("create-community").click();
  await expect(page.getByText("Only people I invite")).toBeVisible();
  await expectNoSidewaysScroll(page, "the create dialog on a phone");
  // On a phone the two choices stack: the second is below the first, not beside it.
  const first = await page
    .getByTestId("community-access-open")
    .locator("..")
    .boundingBox();
  const second = await page
    .getByTestId("community-access-invite_only")
    .locator("..")
    .boundingBox();
  expect(first && second && second.y >= first.y + first.height - 1).toBe(true);
  // The submit button is reachable: the dialog scrolls on its own, the page does not.
  await page.getByTestId("community-create-submit").scrollIntoViewIfNeeded();
  await expect(page.getByTestId("community-create-submit")).toBeInViewport();
});
