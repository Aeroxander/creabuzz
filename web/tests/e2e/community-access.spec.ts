import { expect, test, type Page } from "@playwright/test";
import { getPublicKey, verifyEvent } from "nostr-tools/pure";

import { expectAccessible } from "../helpers/a11y";
import { expectNoSidewaysScroll, PHONE } from "../helpers/layout";
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
const ANOTHER_ADMIN = "e".repeat(64);

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
    /** Invites the server lists as still working. */
    activeInvites?: Record<string, unknown>[];
    /** Why the server refuses to end an invite, when it does. */
    refuseRevoke?: { status: number; error: string };
    /** Why the server refuses to remove a person, when it does. */
    refuseRemove?: string;
    /** Why the server refuses to change a role, when it does. */
    refuseRole?: string;
    /** Why the server refuses to ban a person, or to lift a ban, when it does. */
    refuseBan?: string;
    refuseUnban?: string;
    /** Why the server refuses to end a mute early, when it does. */
    refuseUntimeout?: string;
    /** The server fails to give the list of banned and muted people. */
    restrictedFails?: boolean;
    /** People the server already lists as banned or muted. */
    bans?: Record<string, unknown>[];
    /** A second admin in the community's list. */
    anotherAdmin?: boolean;
    /** On a phone the sidebar is a drawer: open it first. */
    phone?: boolean;
  },
) {
  const {
    role,
    access = "invite_only",
    refuseSetAccess,
    inviteAnswer,
    refuseRemove,
    refuseRole,
    refuseBan,
    refuseUnban,
    refuseUntimeout,
    refuseRevoke,
    anotherAdmin = false,
    phone = false,
  } = options;
  const relay = createMockRelay({
    refuse: (event) => {
      if (refuseSetAccess && event.kind === 9034) return refuseSetAccess;
      if (refuseRemove && event.kind === 9031) return refuseRemove;
      if (refuseRole && event.kind === 9032) return refuseRole;
      if (refuseBan && event.kind === 9040) return refuseBan;
      if (refuseUnban && event.kind === 9041) return refuseUnban;
      if (refuseUntimeout && event.kind === 9043) return refuseUntimeout;
      return undefined;
    },
  });
  const active = [...(options.activeInvites ?? [])];
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
      ...(anotherAdmin ? [["member", ANOTHER_ADMIN, "admin"]] : []),
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

  // Invites that still work: listed on request, and an ended one leaves the list.
  const listRequests: InviteRequest[] = [];
  const revokeRequests: InviteRequest[] = [];
  await page.route("**/api/invites/list", async (route) => {
    const request = route.request();
    listRequests.push({
      authorization: request.headers().authorization,
      body: JSON.parse(request.postData() ?? "{}"),
      url: request.url(),
    });
    await route.fulfill({ json: { invites: active } });
  });
  await page.route("**/api/invites/revoke", async (route) => {
    const request = route.request();
    const body = JSON.parse(request.postData() ?? "{}");
    revokeRequests.push({
      authorization: request.headers().authorization,
      body,
      url: request.url(),
    });
    if (refuseRevoke) {
      await route.fulfill({
        status: refuseRevoke.status,
        json: { error: refuseRevoke.error },
      });
      return;
    }
    const at = active.findIndex((invite) => invite.id === body.id);
    if (at >= 0) active.splice(at, 1);
    await route.fulfill({ json: { revoked: true } });
  });

  // The people the server holds out, as it would list them: the ones it started with, then every ban and lifted ban
  // that was accepted since. An owner or admin may read it; anyone else is refused.
  const banListRequests: string[] = [];
  await page.route("**/moderation/restricted", async (route) => {
    banListRequests.push(route.request().headers().authorization ?? "");
    if (options.restrictedFails) {
      await route.fulfill({ status: 500, json: { error: "database error" } });
      return;
    }
    if (role === "member") {
      await route.fulfill({
        status: 403,
        json: { error: "moderator access required" },
      });
      return;
    }
    const rows = new Map<string, Record<string, unknown>>(
      (options.bans ?? []).map((row) => [row.pubkey as string, row]),
    );
    for (const event of relay.events) {
      const target = event.tags.find((tag) => tag[0] === "p")?.[1];
      if (!target) continue;
      // As the server keeps it: one row per person, a ban and a mute side by side, and whoever acted last.
      const row = rows.get(target);
      if (event.kind === 9040) {
        const until = event.tags.find((tag) => tag[0] === "expiration")?.[1];
        rows.set(target, {
          ...row,
          pubkey: target,
          banned: true,
          ban_expires_at: until
            ? new Date(Number(until) * 1000).toISOString()
            : null,
          ban_reason:
            event.tags.find((tag) => tag[0] === "reason")?.[1] ?? null,
          actor_pubkey: event.pubkey,
        });
      }
      const muted =
        typeof row?.muted_until === "string" &&
        Date.parse(row.muted_until) > Date.now();
      if (event.kind === 9041) {
        if (muted)
          rows.set(target, {
            ...row,
            banned: false,
            ban_expires_at: null,
            actor_pubkey: event.pubkey,
          });
        else rows.delete(target);
      }
      if (event.kind === 9043) {
        if (row?.banned === true)
          rows.set(target, {
            ...row,
            muted_until: null,
            actor_pubkey: event.pubkey,
          });
        else rows.delete(target);
      }
    }
    await route.fulfill({ json: [...rows.values()] });
  });

  await page.goto("/c/alpha.example.com");
  await page.getByTestId("content-pane").waitFor();
  if (phone) await page.getByTestId("open-channel-list").click();
  await page.getByTestId("people-toggle").click();
  await expect(page.getByTestId("people-section")).toBeVisible({
    timeout: 20_000,
  });
  return { relay, invites, listRequests, revokeRequests, banListRequests };
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
  // Plain words in main copy; the server's own words only under Technical details.
  await expect(page.getByTestId("access-error")).toHaveText(
    "The server did not change who can join, so it is as it was. Try again, or ask the community's owner.",
  );
  const details = page.getByTestId("access-error-details");
  await expect(details).toHaveJSProperty("open", false);
  await details.locator("summary").click();
  await expect(details).toContainText("actor not authorized: must be owner");
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
  // Plain words in main copy; the server's own words only under Technical details.
  await expect(page.getByTestId("invite-error")).toHaveText(
    "The server did not make an invite. Try again, or ask the community's owner.",
  );
  const details = page.getByTestId("invite-error-details");
  await expect(details).toHaveJSProperty("open", false);
  await details.locator("summary").click();
  await expect(details).toContainText(
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

const SOON = Math.floor(Date.now() / 1000) + 3 * 86_400;

test("invites that still work are listed with who made them and how much they were used, and ending one removes it", async ({
  page,
}) => {
  const { revokeRequests } = await open(page, {
    role: "owner",
    activeInvites: [
      {
        id: "11111111-1111-1111-1111-111111111111",
        created_by: ME,
        created_at: 1,
        expires_at: SOON,
        max_uses: 5,
        use_count: 2,
      },
      {
        id: "22222222-2222-2222-2222-222222222222",
        created_by: NEIGHBOUR,
        created_at: 2,
        expires_at: SOON,
        max_uses: null,
        use_count: 0,
      },
    ],
  });
  await expect(page.getByTestId("active-invite")).toHaveCount(2);
  await expect(page.getByTestId("active-invite").first()).toContainText(
    "2 of 5 used · ends in 3 days",
  );
  await expect(page.getByTestId("active-invite").nth(1)).toContainText(
    "0 used",
  );

  await page.getByTestId("invite-end").first().click();
  await expect(page.getByTestId("active-invite")).toHaveCount(1);
  expect(revokeRequests).toHaveLength(1);
  expect(revokeRequests[0].body).toEqual({
    id: "11111111-1111-1111-1111-111111111111",
  });
  // Signed by this person, for exactly this request.
  const header = revokeRequests[0].authorization ?? "";
  const event = JSON.parse(atob(header.slice("Nostr ".length)));
  expect(verifyEvent(event)).toBe(true);
  expect(event.pubkey).toBe(ME);
  expect(event.tags.find((t: string[]) => t[0] === "u")?.[1]).toBe(
    revokeRequests[0].url,
  );
});

test("when the server will not end an invite, its words are shown and the invite stays listed", async ({
  page,
}) => {
  await open(page, {
    role: "owner",
    refuseRevoke: {
      status: 404,
      error: "invite not found, or it has already ended",
    },
    activeInvites: [
      {
        id: "33333333-3333-3333-3333-333333333333",
        created_by: ME,
        created_at: 1,
        expires_at: SOON,
        max_uses: 1,
        use_count: 0,
      },
    ],
  });
  await page.getByTestId("invite-end").click();
  // Plain words in main copy; the server's own words only under Technical details.
  await expect(page.getByTestId("invite-end-error")).toHaveText(
    "The server did not end that invite. Reload to see if it is still open, then try again.",
  );
  const details = page.getByTestId("invite-end-error-details");
  await expect(details).toHaveJSProperty("open", false);
  await details.locator("summary").click();
  await expect(details).toContainText(
    "invite not found, or it has already ended",
  );
  await expect(page.getByTestId("active-invite")).toHaveCount(1);
});

test("making a link refreshes the list of invites that still work", async ({
  page,
}) => {
  const { listRequests } = await open(page, { role: "owner" });
  await expect.poll(() => listRequests.length).toBe(1);
  await page.getByTestId("invite-make").click();
  await expect(page.getByTestId("invite-made")).toBeVisible();
  await expect.poll(() => listRequests.length).toBe(2);
});

test("a member never asks for the list of invites", async ({ page }) => {
  const { listRequests } = await open(page, { role: "member" });
  await expect(page.getByTestId("person")).toHaveCount(3);
  await page.waitForTimeout(500);
  expect(listRequests).toHaveLength(0);
  await expect(page.getByTestId("active-invites")).toHaveCount(0);
});

test("the owner can remove an admin or a member after a warning, and never themselves", async ({
  page,
}) => {
  const { relay } = await open(page, { role: "owner", anotherAdmin: true });
  // Three people besides the owner's own row: the admin and the member are removable, the owner is not.
  await expect(page.getByTestId("person")).toHaveCount(3);
  await expect(page.getByTestId("person-remove")).toHaveCount(2);

  const member = page
    .locator('[data-testid="person"][data-role="member"]')
    .first();
  await member.getByTestId("person-remove").click();
  await expect(member.getByTestId("person-confirm")).toContainText(
    "signed out right away",
  );
  await expect(member.getByTestId("person-confirm")).toContainText(
    "new invite",
  );
  // Nothing is sent until it is confirmed.
  expect(relay.events.filter((event) => event.kind === 9031)).toHaveLength(0);
  await member.getByRole("button", { name: "Cancel" }).click();
  await expect(member.getByTestId("person-confirm")).toHaveCount(0);

  await member.getByTestId("person-remove").click();
  await member.getByTestId("person-remove-yes").click();
  await expect
    .poll(() => relay.events.filter((event) => event.kind === 9031).length)
    .toBe(1);
  const sent = relay.events.find((event) => event.kind === 9031);
  expect(sent?.tags).toContainEqual(["p", NEIGHBOUR]);
  expect(sent?.pubkey).toBe(ME);
});

test("an admin can remove a member but is offered nothing for the owner or another admin", async ({
  page,
}) => {
  await open(page, { role: "admin", anotherAdmin: true });
  // Owner, themselves, a member, another admin.
  await expect(page.getByTestId("person")).toHaveCount(4);
  await expect(page.getByTestId("person-remove")).toHaveCount(1);
  await expect(
    page
      .locator('[data-testid="person"][data-role="member"]')
      .getByTestId("person-remove"),
  ).toHaveCount(1);
});

test("a member is offered no way to remove anyone", async ({ page }) => {
  await open(page, { role: "member" });
  await expect(page.getByTestId("person")).toHaveCount(3);
  await expect(page.getByTestId("person-remove")).toHaveCount(0);
});

test("in an open community there is nothing to remove a person from", async ({
  page,
}) => {
  await open(page, { role: "owner", access: "open" });
  await expect(page.getByTestId("person")).toHaveCount(2);
  await expect(page.getByTestId("person-remove")).toHaveCount(0);
});

test("when the server will not remove someone, its words are shown", async ({
  page,
}) => {
  await open(page, {
    role: "owner",
    refuseRemove: "actor not authorized: admins can only remove members",
  });
  await page.getByTestId("person-remove").click();
  await page.getByTestId("person-remove-yes").click();
  // Plain words in main copy; the server's own words only under Technical details.
  await expect(page.getByTestId("person-error")).toHaveText(
    "The server did not remove them, so they are still here. Try again, or ask the community's owner.",
  );
  const details = page.getByTestId("person-error-details");
  await expect(details).toHaveJSProperty("open", false);
  await details.locator("summary").click();
  await expect(details).toContainText(
    "actor not authorized: admins can only remove members",
  );
  // They are still listed.
  await expect(page.getByTestId("person")).toHaveCount(2);
});

test("the people and access section is accessible, with the owner's panels open", async ({
  page,
}) => {
  await open(page, {
    role: "owner",
    anotherAdmin: true,
    activeInvites: [
      {
        id: "44444444-4444-4444-4444-444444444444",
        created_by: ME,
        created_at: 1,
        expires_at: Math.floor(Date.now() / 1000) + 3 * 86_400,
        max_uses: 5,
        use_count: 2,
      },
    ],
  });
  await page.getByTestId("access-open").check();
  await expect(page.getByTestId("access-confirm")).toBeVisible();
  await page.getByTestId("invite-make").click();
  await expect(page.getByTestId("invite-made")).toBeVisible();
  await page.getByTestId("person-remove").first().click();
  await expect(page.getByTestId("person-confirm")).toBeVisible();
  await expectAccessible(page, "people and access (owner)");
});

test("the people and access section fits a phone, with the owner's panels open", async ({
  page,
}) => {
  await page.setViewportSize(PHONE);
  await open(page, { role: "owner", anotherAdmin: true, phone: true });
  await page.getByTestId("access-open").check();
  await page.getByTestId("invite-make").click();
  await expect(page.getByTestId("invite-made")).toBeVisible();
  await page.getByTestId("person-remove").first().click();
  await expect(page.getByTestId("person-confirm")).toBeVisible();
  await expectNoSidewaysScroll(page, "people and access on a phone");
});

test("the owner can make a member an admin and an admin a member, and is offered neither for themselves", async ({
  page,
}) => {
  const { relay } = await open(page, { role: "owner", anotherAdmin: true });
  // The owner, a member, an admin: two role buttons, none on the owner's own row.
  await expect(page.getByTestId("person")).toHaveCount(3);
  await expect(page.getByTestId("person-role")).toHaveCount(2);
  const ownRow = page.getByTestId("person").first();
  await expect(ownRow.getByTestId("person-role")).toHaveCount(0);

  await page
    .getByTestId("person-role")
    .filter({ hasText: "Make admin" })
    .click();
  await expect
    .poll(() => relay.events.filter((event) => event.kind === 9032).length)
    .toBe(1);
  let sent = relay.events.filter((event) => event.kind === 9032).at(-1);
  expect(sent?.tags).toContainEqual(["p", NEIGHBOUR]);
  expect(sent?.tags).toContainEqual(["role", "admin"]);
  expect(sent?.pubkey).toBe(ME);

  await page
    .getByTestId("person-role")
    .filter({ hasText: "Make member" })
    .click();
  await expect
    .poll(() => relay.events.filter((event) => event.kind === 9032).length)
    .toBe(2);
  sent = relay.events.filter((event) => event.kind === 9032).at(-1);
  expect(sent?.tags).toContainEqual(["p", ANOTHER_ADMIN]);
  expect(sent?.tags).toContainEqual(["role", "member"]);
});

test("an admin or a member is offered no role changes", async ({ page }) => {
  await open(page, { role: "admin", anotherAdmin: true });
  await expect(page.getByTestId("person")).toHaveCount(4);
  await expect(page.getByTestId("person-role")).toHaveCount(0);
});

test("when the server will not change a role, its words are shown", async ({
  page,
}) => {
  await open(page, {
    role: "owner",
    refuseRole: "actor not authorized: must be owner",
  });
  await page.getByTestId("person-role").click();
  // Plain words in main copy; the server's own words only under Technical details.
  await expect(page.getByTestId("person-error")).toHaveText(
    "The server did not change their role. Try again, or ask the community's owner.",
  );
  const details = page.getByTestId("person-error-details");
  await expect(details).toHaveJSProperty("open", false);
  await details.locator("summary").click();
  await expect(details).toContainText("actor not authorized: must be owner");
});

test("the owner can ban a person for a week with a reason, after being told what it means, and the ban is listed", async ({
  page,
}) => {
  const { relay } = await open(page, { role: "owner", anotherAdmin: true });
  // The admin and the member can be banned; the owner's own row cannot.
  await expect(page.getByTestId("person-ban")).toHaveCount(2);

  const member = page
    .locator('[data-testid="person"][data-role="member"]')
    .first();
  await member.getByTestId("person-ban").click();
  await expect(member.getByTestId("ban-form")).toContainText(
    "signed out right away",
  );
  await expect(member.getByTestId("ban-form")).toContainText(
    "even with an invite link",
  );
  // The banned person is never shown the reason, so the form does not promise it.
  await expect(member.getByTestId("ban-form")).toContainText(
    "Only moderators see the reason",
  );
  await expect(member.getByTestId("ban-form")).not.toContainText(
    "told the reason",
  );
  // No length is chosen for them, so nothing can be sent until one is picked and it is confirmed.
  await expect(member.getByTestId("ban-yes")).toBeDisabled();
  expect(relay.events.filter((event) => event.kind === 9040)).toHaveLength(0);
  await member.getByRole("button", { name: "Cancel" }).click();
  await expect(member.getByTestId("ban-form")).toHaveCount(0);

  await member.getByTestId("person-ban").click();
  await member.getByTestId("ban-length").selectOption({ label: "7 days" });
  await member.getByTestId("ban-reason").fill("Selling coins in chat");
  const before = Math.floor(Date.now() / 1000);
  await member.getByTestId("ban-yes").click();
  await expect
    .poll(() => relay.events.filter((event) => event.kind === 9040).length)
    .toBe(1);
  const sent = relay.events.find((event) => event.kind === 9040);
  expect(sent?.pubkey).toBe(ME);
  expect(sent?.tags).toContainEqual(["p", NEIGHBOUR]);
  expect(sent?.tags).toContainEqual(["reason", "Selling coins in chat"]);
  const until = Number(sent?.tags.find((tag) => tag[0] === "expiration")?.[1]);
  expect(until).toBeGreaterThanOrEqual(before + 7 * 86_400);
  expect(until).toBeLessThan(before + 7 * 86_400 + 120);

  // The server's list now has them, with the reason and the time left.
  const banned = page.getByTestId("banned-person");
  await expect(banned).toHaveCount(1);
  await expect(banned).toContainText("Banned for 7 more days");
  await expect(banned).toContainText("Selling coins in chat");
});

test("a ban that is for good sends no end time, and can be lifted, which sends the lift and clears the list", async ({
  page,
}) => {
  const { relay } = await open(page, { role: "owner" });
  await page.getByTestId("person-ban").click();
  await page.getByTestId("ban-length").selectOption({ label: "For good" });
  await page.getByTestId("ban-yes").click();
  await expect(page.getByTestId("banned-person")).toHaveCount(1);
  const ban = relay.events.find((event) => event.kind === 9040);
  expect(ban?.tags.some((tag) => tag[0] === "expiration")).toBe(false);
  expect(ban?.tags.some((tag) => tag[0] === "reason")).toBe(false);
  await expect(page.getByTestId("banned-person")).toContainText(
    "Banned for good",
  );

  await page.getByTestId("ban-lift").click();
  await expect
    .poll(() => relay.events.filter((event) => event.kind === 9041).length)
    .toBe(1);
  expect(
    relay.events.find((event) => event.kind === 9041)?.tags,
  ).toContainEqual(["p", NEIGHBOUR]);
  await expect(page.getByTestId("banned-list")).toHaveCount(0);
});

test("people the server already holds out are listed when the page opens, from a signed read", async ({
  page,
}) => {
  const { banListRequests } = await open(page, {
    role: "owner",
    bans: [
      {
        pubkey: "f".repeat(64),
        banned: true,
        ban_expires_at: null,
        ban_reason: "Impersonating the founder",
        actor_pubkey: ME,
      },
      // A time-out is in the same list; it is not a ban.
      {
        pubkey: "9".repeat(64),
        banned: false,
        muted_until: new Date(Date.now() + 3_600_000).toISOString(),
      },
    ],
  });
  await expect(page.getByTestId("banned-person")).toHaveCount(1);
  await expect(page.getByTestId("banned-person")).toContainText(
    "Impersonating the founder",
  );
  // The time-out is listed on its own, as a mute.
  await expect(page.getByTestId("muted-person")).toHaveCount(1);
  await expect(page.getByTestId("muted-person")).toContainText(
    "Muted for 60 more minutes",
  );
  expect(banListRequests.length).toBeGreaterThan(0);
  for (const header of banListRequests) {
    expect(header.startsWith("Nostr ")).toBe(true);
  }
});

test("an admin can ban a member but is offered nothing for the owner or another admin", async ({
  page,
}) => {
  await open(page, { role: "admin", anotherAdmin: true });
  await expect(page.getByTestId("person")).toHaveCount(4);
  await expect(page.getByTestId("person-ban")).toHaveCount(1);
  await expect(
    page
      .locator('[data-testid="person"][data-role="member"]')
      .getByTestId("person-ban"),
  ).toHaveCount(1);
});

test("a member is offered no ban and never asks for the list of who is banned", async ({
  page,
}) => {
  const { banListRequests } = await open(page, { role: "member" });
  await expect(page.getByTestId("person")).toHaveCount(3);
  await expect(page.getByTestId("person-ban")).toHaveCount(0);
  await expect(page.getByTestId("banned-list")).toHaveCount(0);
  expect(banListRequests).toHaveLength(0);
});

test("in an open community a person can still be banned, though there is nothing to remove them from", async ({
  page,
}) => {
  await open(page, { role: "owner", access: "open" });
  await expect(page.getByTestId("person-remove")).toHaveCount(0);
  await expect(page.getByTestId("person-ban")).toHaveCount(1);
});

test("when the server will not ban someone, its words are shown and nobody is listed as banned", async ({
  page,
}) => {
  await open(page, {
    role: "owner",
    refuseBan: "actor not authorized: an admin cannot ban a fellow admin",
  });
  await page.getByTestId("person-ban").click();
  await page.getByTestId("ban-length").selectOption({ label: "For good" });
  await page.getByTestId("ban-yes").click();
  // Plain words in main copy; the server's own words only under Technical details.
  await expect(page.getByTestId("ban-error")).toHaveText(
    "The server did not ban them. Try again, or ask the community's owner.",
  );
  const details = page.getByTestId("ban-error-details");
  await expect(details).toHaveJSProperty("open", false);
  await details.locator("summary").click();
  await expect(details).toContainText(
    "actor not authorized: an admin cannot ban a fellow admin",
  );
  await expect(page.getByTestId("banned-list")).toHaveCount(0);
});

test("when the server will not lift a ban, its words are shown and the ban stays listed", async ({
  page,
}) => {
  await open(page, {
    role: "owner",
    refuseUnban: "actor not authorized: only the owner can lift this ban",
    bans: [
      {
        pubkey: NEIGHBOUR,
        banned: true,
        ban_expires_at: null,
        ban_reason: null,
        actor_pubkey: ME,
      },
    ],
  });
  await page.getByTestId("ban-lift").click();
  // Plain words in main copy; the server's own words only under Technical details.
  await expect(page.getByTestId("ban-lift-error")).toHaveText(
    "The server did not lift the ban, so it is still in place. Try again, or ask the community's owner.",
  );
  const details = page.getByTestId("ban-lift-error-details");
  await expect(details).toHaveJSProperty("open", false);
  await details.locator("summary").click();
  await expect(details).toContainText(
    "actor not authorized: only the owner can lift this ban",
  );
  await expect(page.getByTestId("banned-person")).toHaveCount(1);
});

const MUTED = {
  pubkey: NEIGHBOUR,
  banned: false,
  ban_expires_at: null,
  muted_until: new Date(Date.now() + 2 * 86_400_000).toISOString(),
  mute_reason: "Posting the same link everywhere",
  actor_pubkey: ME,
};

test("people muted everywhere are listed with how long and why, and ending a mute sends it and clears the list", async ({
  page,
}) => {
  const { relay } = await open(page, { role: "owner", bans: [MUTED] });
  const row = page.getByTestId("muted-person");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("Muted for 2 more days");
  await expect(row).toContainText("Posting the same link everywhere");
  await expect(page.getByTestId("banned-list")).toHaveCount(0);

  await row.getByTestId("mute-end").click();
  await expect
    .poll(() => relay.events.filter((event) => event.kind === 9043).length)
    .toBe(1);
  const end = relay.events.find((event) => event.kind === 9043);
  expect(end?.tags).toEqual([["p", NEIGHBOUR]]);
  expect(end?.pubkey).toBe(ME);
  expect(end && verifyEvent(end)).toBe(true);
  await expect(page.getByTestId("muted-list")).toHaveCount(0);
});

test("someone banned and muted is in both lists, and ending the mute leaves the ban", async ({
  page,
}) => {
  await open(page, {
    role: "owner",
    bans: [{ ...MUTED, banned: true, ban_reason: "Spam" }],
  });
  await expect(page.getByTestId("banned-person")).toHaveCount(1);
  await page.getByTestId("mute-end").click();
  await expect(page.getByTestId("muted-list")).toHaveCount(0);
  await expect(page.getByTestId("banned-person")).toHaveCount(1);
});

test("when the server will not end a mute, its words are shown and the mute stays listed", async ({
  page,
}) => {
  await open(page, {
    role: "owner",
    refuseUntimeout: "actor not authorized: only the owner can end this mute",
    bans: [MUTED],
  });
  await page.getByTestId("mute-end").click();
  await expect(page.getByTestId("mute-end-error")).toHaveText(
    "The server did not end the mute, so it is still in place. Try again, or ask the community's owner.",
  );
  const details = page.getByTestId("mute-end-error-details");
  await details.locator("summary").click();
  await expect(details).toContainText("only the owner can end this mute");
  await expect(page.getByTestId("muted-person")).toHaveCount(1);
});

test("a mute that ended since the list was read is said so, and the list is read again", async ({
  page,
}) => {
  const { banListRequests } = await open(page, {
    role: "owner",
    refuseUntimeout: "invalid: member is not timed out",
    bans: [MUTED],
  });
  await expect(page.getByTestId("muted-person")).toHaveCount(1);
  const before = banListRequests.length;
  await page.getByTestId("mute-end").click();
  await expect(page.getByText("mute had already ended")).toBeVisible();
  await expect.poll(() => banListRequests.length).toBeGreaterThan(before);
  await expect(page.getByTestId("mute-end-error")).toHaveCount(0);
});

test("a member never sees who is muted, and never asks", async ({ page }) => {
  const { banListRequests } = await open(page, {
    role: "member",
    bans: [MUTED],
  });
  await expect(page.getByTestId("person")).toHaveCount(3);
  await expect(page.getByTestId("muted-list")).toHaveCount(0);
  expect(banListRequests).toHaveLength(0);
});

test("lifting the ban on someone also muted leaves them muted", async ({
  page,
}) => {
  await open(page, {
    role: "owner",
    bans: [{ ...MUTED, banned: true, ban_reason: "Spam" }],
  });
  await page.getByTestId("ban-lift").click();
  await expect(page.getByTestId("banned-list")).toHaveCount(0);
  await expect(page.getByTestId("muted-person")).toHaveCount(1);
});

test("when the list of banned and muted people cannot be read, the owner is told", async ({
  page,
}) => {
  await open(page, { role: "owner", restrictedFails: true });
  await expect(page.getByTestId("restricted-error")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTestId("muted-list")).toHaveCount(0);
});

test("opening People again reads the list again, so a mute given elsewhere shows at once", async ({
  page,
}) => {
  const listed: Record<string, unknown>[] = [];
  const { banListRequests } = await open(page, { role: "owner", bans: listed });
  await expect(page.getByTestId("people-section")).toBeVisible();
  await expect(page.getByTestId("muted-list")).toHaveCount(0);
  // A moderator mutes them from a report, in another view, moments later.
  listed.push(MUTED);
  // Close People and open it again.
  await page.getByTestId("people-toggle").click();
  await expect(page.getByTestId("people-section")).toHaveCount(0);
  const before = banListRequests.length;
  await page.getByTestId("people-toggle").click();
  await expect.poll(() => banListRequests.length).toBeGreaterThan(before);
  await expect(page.getByTestId("muted-person")).toHaveCount(1);
});

test("the ban form and the lists of banned and muted people are accessible", async ({
  page,
}) => {
  await open(page, {
    role: "owner",
    bans: [
      {
        pubkey: "f".repeat(64),
        banned: true,
        ban_expires_at: null,
        ban_reason: "Spam",
        actor_pubkey: ME,
      },
      { ...MUTED, pubkey: "9".repeat(64) },
    ],
  });
  await expect(page.getByTestId("muted-person")).toHaveCount(1);
  await page
    .locator('[data-testid="person"][data-role="member"]')
    .getByTestId("person-ban")
    .click();
  await expect(page.getByTestId("ban-form")).toBeVisible();
  await expectAccessible(page, "the ban form and the list of banned people");
});

test("the ban form fits a phone", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await open(page, { role: "owner", phone: true });
  await page.getByTestId("person-ban").click();
  await expect(page.getByTestId("ban-form")).toBeVisible();
  await expectNoSidewaysScroll(page, "the ban form on a phone");
  await expect(page.getByTestId("ban-yes")).toBeInViewport();
});
