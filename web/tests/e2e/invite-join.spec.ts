import { expect, test, type Page } from "@playwright/test";
import { verifyEvent } from "nostr-tools/pure";

import { expectAccessible } from "../helpers/a11y";
import { createMockRelay } from "./mock-relay";

/**
 * Joining a community from an invite link as someone with no account yet. The server's two routes are answered here, so
 * the spec checks what the app does: it makes an account in this browser, claims the invite signed by that account,
 * points the browser at the community, and only then publishes the person's name (a private community would refuse a
 * stranger's profile).
 */

const HOST = "127.0.0.1:4173";

interface Setup {
  claims: {
    authorization: string | undefined;
    body: Record<string, unknown>;
  }[];
  relay: ReturnType<typeof createMockRelay>;
}

async function open(
  page: Page,
  options: {
    claimAnswer?: { status: number; json: unknown };
    identity?: boolean;
  } = {},
): Promise<Setup> {
  const { claimAnswer, identity = false } = options;
  const relay = createMockRelay();
  await relay.install(page);
  if (identity) {
    await page.addInitScript(() => {
      window.localStorage.setItem("buzz.identity.nsec", "66".repeat(32));
    });
  }
  await page.route("**/api/join-policy", (route) =>
    route.fulfill({ json: {} }),
  );
  const claims: Setup["claims"] = [];
  await page.route("**/api/invites/claim", async (route) => {
    claims.push({
      authorization: route.request().headers().authorization,
      body: JSON.parse(route.request().postData() ?? "{}"),
    });
    const answer = claimAnswer ?? {
      status: 200,
      json: {
        status: "joined",
        community_id: "00000000-0000-0000-0000-000000000001",
        host: HOST,
        role: "member",
      },
    };
    await route.fulfill({ status: answer.status, json: answer.json });
  });
  await page.goto("/invite/some-code");
  return { claims, relay };
}

test("someone with no account is offered to make one, and the button for people who have one is not shown", async ({
  page,
}) => {
  await open(page);
  await expect(page.getByTestId("invite-new-account")).toBeVisible({
    timeout: 20_000,
  });
  await expect(
    page.getByRole("button", { name: "Join in browser" }),
  ).toHaveCount(0);
  await expectAccessible(page, "invite (no account)");
});

test("someone with an account sees the usual button and is not asked to make another", async ({
  page,
}) => {
  await open(page, { identity: true });
  await expect(
    page.getByRole("button", { name: "Join in browser" }),
  ).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("invite-new-account")).toHaveCount(0);
});

test("making an account and joining: the claim is signed by the new account, the browser is pointed at the community, and the name is published after", async ({
  page,
}) => {
  const { claims, relay } = await open(page);
  await page.getByTestId("invite-name").fill("  Robin  ");
  await page.getByTestId("invite-create-and-join").click();
  await page.waitForURL("**/", { timeout: 20_000 });

  // An account now exists in this browser, and the claim was signed by it.
  expect(claims).toHaveLength(1);
  const header = claims[0].authorization ?? "";
  const event = JSON.parse(atob(header.slice("Nostr ".length)));
  expect(verifyEvent(event)).toBe(true);
  const stored = await page.evaluate(() =>
    window.localStorage.getItem("buzz.identity.nsec"),
  );
  expect(stored).toBeTruthy();
  expect(claims[0].body).toEqual({ code: "some-code" });

  // The browser now points at the community the invite was for.
  expect(
    await page.evaluate(() => window.localStorage.getItem("buzz.relayUrl")),
  ).toBe(`ws://${HOST}`);

  // The name is published after the join, signed by the same account, trimmed.
  await expect
    .poll(() => relay.events.filter((e) => e.kind === 0).length)
    .toBe(1);
  const profile = relay.events.find((e) => e.kind === 0);
  expect(profile?.pubkey).toBe(event.pubkey);
  expect(JSON.parse(profile?.content ?? "{}").name).toBe("Robin");
});

test("a name is optional: without one the person still joins and nothing is published", async ({
  page,
}) => {
  const { claims, relay } = await open(page);
  await page.getByTestId("invite-create-and-join").click();
  await page.waitForURL("**/", { timeout: 20_000 });
  expect(claims).toHaveLength(1);
  await page.waitForTimeout(300);
  expect(relay.events.filter((e) => e.kind === 0)).toHaveLength(0);
});

test("an invite that cannot be used says why in words, and the person stays on the page with an account to try again", async ({
  page,
}) => {
  await open(page, {
    claimAnswer: { status: 403, json: { error: "invite_expired" } },
  });
  await page.getByTestId("invite-create-and-join").click();
  await expect(page.getByRole("alert")).toContainText(
    "This invite has expired",
  );
  // Still on the invite page. The account made along the way is theirs, so the usual button is there now.
  await expect(page).toHaveURL(/\/invite\/some-code/);
  await expect(
    page.getByRole("button", { name: "Join in browser" }),
  ).toBeEnabled();
});
