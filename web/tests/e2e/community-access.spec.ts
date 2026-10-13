import { expect, test, type Page } from "@playwright/test";
import { getPublicKey, verifyEvent } from "nostr-tools/pure";

import { createMockRelay } from "./mock-relay";

/**
 * Who may join a community, from the Org page: the owner chooses, an admin can only invite, a member only sees. The
 * server's own rules are covered by its tests and by `scripts/web-invite-only-e2e.sh`; here the page's two requests are
 * answered by hand, so the spec checks what the app sends (a record from the owner, a signed invite request) and what it
 * does with each answer.
 */

const NSEC = "44".repeat(32);
const ME = getPublicKey(
  Uint8Array.from(NSEC.match(/.{2}/g) ?? [], (b) => Number.parseInt(b, 16)),
);
const OTHER_OWNER = "a".repeat(64);
const NEIGHBOUR = "b".repeat(64);

const channel = {
  id: "chan-1",
  pubkey: "c".repeat(64),
  created_at: 100,
  kind: 39000,
  tags: [
    ["d", "0f0f0f0f-1111-2222-3333-444444444444"],
    ["name", "general"],
  ],
  content: "",
  sig: "sig",
};

type Role = "owner" | "admin" | "member";

interface InviteRequest {
  authorization: string | undefined;
  body: Record<string, unknown>;
  url: string;
}

async function open(
  page: Page,
  options: {
    role: Role;
    /** What the community says about who may join; absent for a server that predates it. */
    access?: "open" | "invite_only" | null;
    refuseSetAccess?: string;
    inviteAnswer?: { status: number; json: unknown };
  },
) {
  const {
    role,
    access = "invite_only",
    refuseSetAccess,
    inviteAnswer,
  } = options;
  const relay = createMockRelay({
    refuse: (event) =>
      refuseSetAccess && event.kind === 9034 ? refuseSetAccess : undefined,
  });
  relay.seed(channel);
  const owner = role === "owner" ? ME : OTHER_OWNER;
  relay.seed({
    id: "list-1",
    pubkey: "d".repeat(64),
    created_at: 200,
    kind: 13534,
    tags: [
      ["member", owner, "owner"],
      ...(role === "admin" ? [["member", ME, "admin"]] : []),
      ...(role === "member" ? [["member", ME, "member"]] : []),
      ["member", NEIGHBOUR, "member"],
    ],
    content: "",
    sig: "sig",
  });
  await relay.install(page);
  await page.addInitScript((nsec) => {
    window.localStorage.setItem("buzz.identity.nsec", nsec);
  }, NSEC);

  // The community's public information follows what has been published to it: the last accepted setting wins.
  await page.route("**/info", async (route) => {
    const latest = relay.events
      .filter((event) => event.kind === 9034)
      .at(-1)
      ?.tags.find((tag) => tag[0] === "access")?.[1];
    const current = latest ?? access;
    await route.fulfill({
      json: current === null ? {} : { access: current },
    });
  });
  const invites: InviteRequest[] = [];
  await page.route("**/api/invites", async (route) => {
    const request = route.request();
    invites.push({
      authorization: request.headers().authorization,
      body: JSON.parse(request.postData() ?? "{}"),
      url: request.url(),
    });
    const answer = inviteAnswer ?? {
      status: 200,
      json: {
        code: "v2.abc",
        url: "http://acme.example.test/invite/v2.abc",
        expires_at: Math.floor(Date.now() / 1000) + 7 * 86_400,
        max_uses: 1,
        uses_remaining: 1,
      },
    };
    await route.fulfill({ status: answer.status, json: answer.json });
  });

  await page.goto("/c/alpha.example.com");
  await page.getByTestId("content-pane").waitFor();
  await page.getByTestId("org-toggle").click();
  await expect(page.getByTestId("org-people-section")).toBeVisible({
    timeout: 20_000,
  });
  return { relay, invites };
}

test("the owner sees the current setting, and everyone in the community", async ({
  page,
}) => {
  await open(page, { role: "owner" });
  await expect(page.getByTestId("access-invite_only")).toBeChecked();
  await expect(page.getByTestId("access-open")).not.toBeChecked();
  // The owner first, then the rest; three rows would mean the same person twice.
  await expect(page.getByTestId("person")).toHaveCount(2);
  await expect(page.getByTestId("person").first()).toContainText("Owner");
  await expect(page.getByTestId("person").nth(1)).toContainText("Member");
});

test("opening a community asks first, says what it means, and then tells the server", async ({
  page,
}) => {
  const { relay } = await open(page, { role: "owner" });
  await page.getByTestId("access-open").check();
  await expect(page.getByTestId("access-confirm")).toContainText(
    "Anyone with the address",
  );
  // Nothing has been sent yet.
  expect(relay.events.filter((event) => event.kind === 9034)).toHaveLength(0);

  await page.getByTestId("access-confirm-yes").click();
  await expect(page.getByTestId("access-confirm")).toHaveCount(0);
  await expect(page.getByTestId("access-open")).toBeChecked();

  const sent = relay.events.filter((event) => event.kind === 9034);
  expect(sent).toHaveLength(1);
  expect(sent[0].tags).toContainEqual(["access", "open"]);
  expect(sent[0].pubkey).toBe(ME);
  expect(verifyEvent(sent[0] as never)).toBe(true);
});

test("closing a community warns that strangers are signed out, and cancelling sends nothing", async ({
  page,
}) => {
  const { relay } = await open(page, { role: "owner", access: "open" });
  await page.getByTestId("access-invite_only").check();
  await expect(page.getByTestId("access-confirm")).toContainText(
    "signed out right away",
  );
  await expect(page.getByTestId("access-confirm")).toContainText(
    "Members stay",
  );
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByTestId("access-confirm")).toHaveCount(0);
  // Back to what the community really is.
  await expect(page.getByTestId("access-open")).toBeChecked();
  expect(relay.events.filter((event) => event.kind === 9034)).toHaveLength(0);

  await page.getByTestId("access-invite_only").check();
  await page.getByTestId("access-confirm-yes").click();
  // The panel closes only once the server has accepted the record.
  await expect(page.getByTestId("access-confirm")).toHaveCount(0);
  await expect(page.getByTestId("access-invite_only")).toBeChecked();
  expect(
    relay.events
      .filter((event) => event.kind === 9034)
      .map((event) => event.tags.find((tag) => tag[0] === "access")?.[1]),
  ).toEqual(["invite_only"]);
});

test("when the server refuses the change, its words are shown and the setting stays as it was", async ({
  page,
}) => {
  await open(page, {
    role: "owner",
    refuseSetAccess: "actor not authorized: must be owner",
  });
  await page.getByTestId("access-open").check();
  await page.getByTestId("access-confirm-yes").click();
  await expect(page.getByTestId("access-error")).toHaveText(
    "actor not authorized: must be owner",
  );
  // The page does not claim a change that did not happen.
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByTestId("access-invite_only")).toBeChecked();
});

test("an invite link is asked for with a signed request, shown with what it allows, and can be changed", async ({
  page,
}) => {
  const { invites } = await open(page, { role: "owner" });
  await page.getByTestId("invite-make").click();
  await expect(page.getByTestId("invite-link")).toHaveValue(
    "http://acme.example.test/invite/v2.abc",
  );
  await expect(page.getByTestId("invite-made")).toContainText(
    "Works for 7 days, for one person.",
  );

  expect(invites).toHaveLength(1);
  // Defaults: a week, one person.
  expect(invites[0].body).toEqual({ ttl_secs: 604_800, max_uses: 1 });
  const header = invites[0].authorization ?? "";
  expect(header.startsWith("Nostr ")).toBe(true);
  const event = JSON.parse(atob(header.slice("Nostr ".length)));
  expect(verifyEvent(event)).toBe(true);
  expect(event.pubkey).toBe(ME);
  expect(event.tags.find((t: string[]) => t[0] === "u")?.[1]).toBe(
    invites[0].url,
  );
  expect(event.tags.find((t: string[]) => t[0] === "method")?.[1]).toBe("POST");

  // A longer-lived link for anyone: no limit is sent at all.
  await page.getByTestId("invite-lifetime").selectOption("month");
  await page.getByTestId("invite-uses").selectOption("any");
  await page.getByTestId("invite-make").click();
  await expect.poll(() => invites.length).toBe(2);
  expect(invites[1].body).toEqual({ ttl_secs: 2_592_000 });
});

test("a refused invite shows the server's words and no link", async ({
  page,
}) => {
  await open(page, {
    role: "owner",
    inviteAnswer: {
      status: 403,
      json: { error: "only relay owners and admins can create invites" },
    },
  });
  await page.getByTestId("invite-make").click();
  await expect(page.getByTestId("invite-error")).toHaveText(
    "only relay owners and admins can create invites",
  );
  await expect(page.getByTestId("invite-made")).toHaveCount(0);
});

test("an admin can invite but not change who may join, and is told the setting", async ({
  page,
}) => {
  await open(page, { role: "admin" });
  await expect(page.getByTestId("invite-maker")).toBeVisible();
  await expect(page.getByTestId("access-control")).toHaveCount(0);
  await expect(page.getByTestId("access-summary")).toContainText("invite link");
});

test("a member sees who is in and the setting, and is offered nothing to change", async ({
  page,
}) => {
  await open(page, { role: "member" });
  await expect(page.getByTestId("invite-maker")).toHaveCount(0);
  await expect(page.getByTestId("access-control")).toHaveCount(0);
  await expect(page.getByTestId("access-summary")).toBeVisible();
  await expect(page.getByTestId("person")).toHaveCount(3);
});

test("a server that does not say who may join gets no setting to change and no guess", async ({
  page,
}) => {
  await open(page, { role: "owner", access: null });
  await expect(page.getByTestId("access-control")).toHaveCount(0);
  await expect(page.getByTestId("access-summary")).toHaveCount(0);
  // Inviting people still works.
  await expect(page.getByTestId("invite-maker")).toBeVisible();
});
