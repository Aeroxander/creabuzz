import { expect, test, type Page } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";

import { expectAccessible } from "../helpers/a11y";
import { createMockRelay } from "./mock-relay";

/**
 * Getting in and the profile (the social audit's "signup" should-fix items, D143).
 *
 * - A passkey account can join from an invite: the invite page has no other way to unlock it, so it offers the unlock
 *   itself, and someone with no account can make a passkey account there, then save its recovery key.
 * - The invite page says when the server's terms could not be loaded (with Try again), loads them again when they
 *   changed, and says other refusals in words.
 * - The account menu's Edit profile can upload a picture, and the Get started list ticks the name step only for a
 *   name the person chose.
 */

const PORT = process.env.E2E_PORT ?? "4173";
/** Passkeys need a host name, not an IP address, so the passkey cases open the same preview on localhost. */
const LOCALHOST = `http://localhost:${PORT}`;

const CLAIMED = {
  status: "joined",
  community_id: "00000000-0000-0000-0000-000000000001",
  host: `localhost:${PORT}`,
  role: "member",
};

async function addVirtualAuthenticator(page: Page) {
  const client = await page.context().newCDPSession(page);
  await client.send("WebAuthn.enable");
  await client.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
      hasPrf: true,
    },
  });
}

/** The account a claim was signed by: the pubkey of its `Authorization: Nostr …` event. */
function signerOf(authorization: string | undefined): string {
  const event = JSON.parse(atob((authorization ?? "").slice("Nostr ".length)));
  return event.pubkey as string;
}

/** Answer the invite routes; every claim is recorded with who signed it. */
async function answerInvite(
  page: Page,
  policy: () => { status: number; json: unknown } = () => ({
    status: 200,
    json: {},
  }),
) {
  const claims: { signer: string; body: Record<string, unknown> }[] = [];
  let policyLoads = 0;
  await page.route("**/api/join-policy", async (route) => {
    policyLoads += 1;
    const answer = policy();
    await route.fulfill({ status: answer.status, json: answer.json });
  });
  await page.route("**/api/invites/claim", async (route) => {
    claims.push({
      signer: signerOf(route.request().headers().authorization),
      body: JSON.parse(route.request().postData() ?? "{}"),
    });
    await route.fulfill({ status: 200, json: CLAIMED });
  });
  return { claims, policyLoads: () => policyLoads };
}

/** Make a passkey account from an invite, as someone with no account: the recovery key is offered once they are in. */
async function joinWithNewPasskey(page: Page, code: string) {
  await page.goto(`${LOCALHOST}/invite/${code}`);
  await page.getByTestId("invite-passkey-create").click();
  const backup = page.getByTestId("backup-dialog");
  await expect(backup).toBeVisible({ timeout: 20_000 });
  return backup;
}

test("someone with no account can make a passkey account on the invite page, join with it, and is offered its recovery key", async ({
  page,
}) => {
  await addVirtualAuthenticator(page);
  const { claims } = await answerInvite(page);
  const backup = await joinWithNewPasskey(
    page,
    "v2.first-codeAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  );

  // The claim is signed by the passkey account, and no browser key was made beside it.
  const stored = await page.evaluate(() => ({
    account: localStorage.getItem("buzz.passkey.pubkey"),
    mode: localStorage.getItem("buzz.passkey.mode"),
    nsec: localStorage.getItem("buzz.identity.nsec"),
  }));
  expect(stored.mode).toBe("prf");
  expect(stored.nsec).toBeNull();
  expect(claims).toHaveLength(1);
  expect(claims[0].signer).toBe(stored.account);

  // The key offered is this account's own, ready to save while the passkey is unlocked.
  await expect(backup).toContainText("You're in.");
  await expect(page.getByTestId("backup-download")).toBeVisible();
  await expect(page.getByTestId("backup-unavailable")).toHaveCount(0);
  await expectAccessible(page, "invite (recovery key after a passkey join)");

  await page.getByTestId("backup-close").click();
  await page.waitForURL(`${LOCALHOST}/`);
});

test("a passkey account that is locked unlocks on the invite page and joins with the same account", async ({
  page,
}) => {
  await addVirtualAuthenticator(page);
  const { claims } = await answerInvite(page);
  await joinWithNewPasskey(
    page,
    "v2.first-codeAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  );
  const account = await page.evaluate(() =>
    localStorage.getItem("buzz.passkey.pubkey"),
  );

  // A new page load: the passkey's key is gone from memory, and this page has no account menu to unlock it from.
  await page.goto(
    `${LOCALHOST}/invite/v2.second-codeAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
  );
  await expect(page.getByTestId("invite-passkey-locked")).toBeVisible({
    timeout: 20_000,
  });
  const unlock = page.getByRole("button", { name: "Unlock with your passkey" });
  await expect(unlock).toBeEnabled();
  // Not asked to make a second account.
  await expect(page.getByTestId("invite-new-account")).toHaveCount(0);

  await unlock.click();
  await page.waitForURL(`${LOCALHOST}/`, { timeout: 20_000 });
  expect(claims).toHaveLength(2);
  expect(claims[1].body.code).toBe(
    "v2.second-codeAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  );
  expect(claims[1].signer).toBe(account);
});

test("signing up with a passkey says a recovery key is still needed elsewhere, and offers to save it right away", async ({
  page,
}) => {
  await addVirtualAuthenticator(page);
  const relay = createMockRelay();
  await relay.install(page);
  // The page is on localhost for the passkey; the mock server answers on the loopback address.
  await page.addInitScript(
    (url) => window.localStorage.setItem("buzz.relayUrl", url),
    `ws://127.0.0.1:${PORT}`,
  );
  await page.goto(`${LOCALHOST}/`);
  await page.getByTestId("create-identity-cta").first().click();
  await expect(page.getByTestId("onboarding-passkey-note")).toContainText(
    "On another device you need your recovery key",
  );
  await page.getByTestId("onboarding-name").fill("Mira Okafor");
  await page.getByTestId("onboarding-passkey").click();

  const backup = page.getByTestId("backup-dialog");
  await expect(backup).toContainText("Your account is ready.", {
    timeout: 20_000,
  });
  const account = await page.evaluate(() =>
    localStorage.getItem("buzz.passkey.pubkey"),
  );
  // Saving it counts as backed up for this account (D111); closing does not.
  await page.getByTestId("backup-download").click();
  expect(
    await page.evaluate(() => localStorage.getItem("buzz.identity.backedUp")),
  ).toBe(account);
  await page.getByTestId("backup-close").click();
  await expect(backup).toHaveCount(0);
  await expect(page.getByTestId("user-chip").first()).toBeVisible();
});

test("the recovery key offered after a passkey sign-up from a reply box stays open while the page updates, and closing it reloads", async ({
  page,
}) => {
  // The reply box (like every composer) shows its sign-up only while nobody is signed in, so the first re-render after
  // the passkey exists unmounts it. The offer must not go with it.
  test.setTimeout(90_000);
  await addVirtualAuthenticator(page);
  const relay = createMockRelay();
  const post = {
    id: "ab".repeat(32),
    pubkey: OWNER,
    created_at: Math.floor(Date.now() / 1000) - 60,
    kind: 1,
    tags: [],
    content: "What are you making this week?",
    sig: "sig",
  };
  relay.seed(post);
  await relay.install(page);
  await page.addInitScript(
    (url) => window.localStorage.setItem("buzz.relayUrl", url),
    `ws://127.0.0.1:${PORT}`,
  );
  await page.goto(`${LOCALHOST}/social/post/${post.id}`);
  await page.getByTestId("social-reply-composer-sign-in").click();
  await page.getByTestId("onboarding-name").fill("Mira Okafor");
  await page.getByTestId("onboarding-passkey").click();
  const backup = page.getByTestId("backup-dialog");
  await expect(backup).toContainText("Your account is ready.", {
    timeout: 20_000,
  });
  // Focus moves into the offer, which opened unasked.
  await expect(page.getByRole("dialog")).toBeFocused();

  // The thread polls: a reply arriving re-renders the page (and its reply box) under the open offer.
  relay.seed({
    id: "cd".repeat(32),
    pubkey: OWNER,
    created_at: post.created_at + 1,
    kind: 1,
    tags: [["e", post.id, "", "root"]],
    content: "A reply that arrived while the key was on screen",
    sig: "sig",
  });
  await expect(
    page.getByText("A reply that arrived while the key was on screen"),
  ).toBeAttached({ timeout: 40_000 });
  await expect(backup).toBeVisible();
  await expect(page.getByTestId("backup-download")).toBeVisible();

  // Closing it runs what the reply box asked for: a reload, so the page shows the new account.
  await page.evaluate(() => {
    (window as unknown as { beforeClose?: boolean }).beforeClose = true;
  });
  await page.getByTestId("backup-close").click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { beforeClose?: boolean }).beforeClose,
      ),
    )
    .toBeUndefined();
  await expect(backup).toHaveCount(0);
});

const POLICY = {
  policy: {
    terms_markdown: "# Terms\n\nBe kind.",
    age_attestation_required: false,
    version: "v1",
  },
};

test("terms that could not be loaded say so with Try again; terms that changed load again and ask for a new tick", async ({
  page,
}) => {
  const relay = createMockRelay();
  await relay.install(page);
  await page.addInitScript(() =>
    window.localStorage.setItem("buzz.identity.nsec", "66".repeat(32)),
  );
  let failTerms = true;
  const { claims, policyLoads } = await answerInvite(page, () =>
    failTerms ? { status: 503, json: {} } : { status: 200, json: POLICY },
  );
  const acceptances: Record<string, unknown>[] = [];
  await page.route("**/api/invites/accept-policy", async (route) => {
    acceptances.push(JSON.parse(route.request().postData() ?? "{}"));
    // The first agreement is to terms the server has since replaced.
    if (acceptances.length === 1) {
      await route.fulfill({
        status: 400,
        json: { error: "join_policy_not_accepted" },
      });
    } else {
      await route.fulfill({ json: { receipt: "receipt-1" } });
    }
  });
  await page.goto("/invite/v2.some-codeAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");

  const failed = page.getByTestId("invite-policy-failed");
  await expect(failed).toBeVisible({ timeout: 20_000 });
  await expect(failed.getByRole("alert")).toContainText(
    "Couldn't load this server's terms.",
  );
  const join = page.getByRole("button", { name: "Join this community" });
  await expect(join).toBeDisabled();
  await expectAccessible(page, "invite (terms could not be loaded)");

  failTerms = false;
  await page.getByTestId("invite-policy-retry").click();
  const agree = page.getByRole("checkbox", { name: /I agree to the/ });
  // The box is drawn by its label (the input itself is visually hidden), so it is ticked the way a person does.
  const tick = () =>
    page
      .locator("label")
      .filter({ hasText: "I agree to the Creaton" })
      .click({ position: { x: 8, y: 8 } });
  await expect(agree).toBeVisible();
  await expect(failed).toHaveCount(0);
  await tick();
  await expect(join).toBeEnabled();

  const loadsBefore = policyLoads();
  await join.click();
  await expect(page.getByRole("alert")).toHaveText(
    "The terms changed. Read them and tick the box again.",
  );
  // Loaded again, the tick cleared, nothing claimed on the old agreement.
  await expect.poll(policyLoads).toBe(loadsBefore + 1);
  await expect(agree).not.toBeChecked();
  await expect(join).toBeDisabled();
  expect(claims).toHaveLength(0);

  await tick();
  await join.click();
  await expect.poll(() => claims.length).toBe(1);
  expect(claims[0].body.policy_receipt).toBe("receipt-1");
});

test("a refusal the page does not know is said plainly, with the server's words under Technical details", async ({
  page,
}) => {
  const relay = createMockRelay();
  await relay.install(page);
  await page.addInitScript(() =>
    window.localStorage.setItem("buzz.identity.nsec", "66".repeat(32)),
  );
  await page.route("**/api/join-policy", (route) =>
    route.fulfill({ json: {} }),
  );
  await page.route("**/api/invites/claim", (route) =>
    route.fulfill({
      status: 500,
      json: { error: "internal server error" },
    }),
  );
  await page.goto("/invite/v2.some-codeAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  await page.getByRole("button", { name: "Join this community" }).click();
  const problem = page.getByTestId("invite-join-problem");
  await expect(problem.getByRole("alert")).toHaveText(
    /^Couldn't join with this invite\./,
  );
  await expect(problem.getByText("internal server error")).toBeHidden();
  await problem.getByText("Technical details").click();
  await expect(problem.getByText("internal server error")).toBeVisible();
});

const OWNER_NSEC = "55".repeat(32);
const OWNER = getPublicKey(
  Uint8Array.from(OWNER_NSEC.match(/.{2}/g) ?? [], (b) =>
    Number.parseInt(b, 16),
  ),
);
/** A 1×1 PNG. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

async function openAsOwner(
  page: Page,
  profile: Record<string, unknown>,
  options: Parameters<typeof createMockRelay>[0] = {},
) {
  const relay = createMockRelay(options);
  relay.seed({
    id: "profile-1",
    pubkey: OWNER,
    created_at: 100,
    kind: 0,
    tags: [],
    content: JSON.stringify(profile),
    sig: "sig",
  });
  await relay.install(page);
  await page.route("http://127.0.0.1:8545/**", (route) =>
    route.fulfill({
      json: { jsonrpc: "2.0", id: 1, result: "0x10" },
    }),
  );
  await page.addInitScript((nsec) => {
    window.localStorage.setItem("buzz.identity.nsec", nsec);
  }, OWNER_NSEC);
  return relay;
}

test("Edit profile in the account menu uploads a picture, shows it, and saves it without losing the rest of the profile", async ({
  page,
}) => {
  const relay = await openAsOwner(page, {
    name: "Mira Okafor",
    about: "I paint.",
    website: "https://mira.example",
  });
  const uploads: { authorization: string | undefined; type: string }[] = [];
  const pictureUrl = `http://127.0.0.1:${PORT}/media/${"ab".repeat(32)}.png`;
  await page.route("**/upload", async (route) => {
    uploads.push({
      authorization: route.request().headers().authorization,
      type: route.request().headers()["content-type"] ?? "",
    });
    await route.fulfill({
      json: {
        url: pictureUrl,
        sha256: "ab".repeat(32),
        size: PNG.length,
        type: "image/png",
        uploaded: 1,
      },
    });
  });
  await page.route("**/media/**", (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: PNG }),
  );
  await page.goto("/");
  await page.getByTestId("user-chip").first().click();
  await page.getByRole("button", { name: "Edit profile" }).click();

  const field = page.getByTestId("profile-menu-picture");
  await expect(
    field.getByRole("button", { name: "Choose a picture" }),
  ).toBeVisible();
  await expect(field.getByLabel("Or paste a link to a picture")).toBeVisible();

  // A file that is not a picture is turned away before anything is sent.
  await field.getByTestId("profile-menu-picture-file").setInputFiles({
    name: "notes.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4"),
  });
  await expect(field.getByRole("alert")).toContainText("isn't a picture");
  expect(uploads).toHaveLength(0);

  await field.getByTestId("profile-menu-picture-file").setInputFiles({
    name: "me.png",
    mimeType: "image/png",
    buffer: PNG,
  });
  await expect(field.getByRole("img", { name: "Your picture" })).toBeVisible();
  expect(uploads).toHaveLength(1);
  expect(uploads[0].type).toBe("image/png");
  await expect(field.getByLabel("Or paste a link to a picture")).toHaveValue(
    pictureUrl,
  );

  await page.getByTestId("profile-save").click();
  await expect
    .poll(() =>
      relay.events
        .filter(
          (e) => e.kind === 0 && e.pubkey === OWNER && e.id !== "profile-1",
        )
        .map((e) => JSON.parse(e.content)),
    )
    .toEqual([
      expect.objectContaining({
        name: "Mira Okafor",
        about: "I paint.",
        website: "https://mira.example",
        picture: pictureUrl,
      }),
    ]);
});

test("Get started does not tick the name step for a profile that has no name", async ({
  page,
}) => {
  await openAsOwner(page, { about: "I paint." });
  await page.goto("/");
  const list = page.getByTestId("home-getting-started");
  await expect(list).toBeVisible({ timeout: 20_000 });
  await expect(list).toContainText("0 of 3 done");
  await expect(list.getByTestId("home-step-name")).toContainText(
    "Add your name and a picture",
  );
});

test("Edit profile on the profile page offers the same picture upload, and keeps a link as the fallback", async ({
  page,
}) => {
  const relay = await openAsOwner(page, { name: "Mira Okafor" });
  const pictureUrl = `http://127.0.0.1:${PORT}/media/${"cd".repeat(32)}.png`;
  await page.route("**/upload", (route) =>
    route.fulfill({
      json: {
        url: pictureUrl,
        sha256: "cd".repeat(32),
        size: PNG.length,
        type: "image/png",
        uploaded: 1,
      },
    }),
  );
  await page.route("**/media/**", (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: PNG }),
  );
  await page.goto(`/u/${OWNER}`);
  await page.getByTestId("profile-edit").click();
  const dialog = page.getByTestId("social-edit-profile");
  // No bare "Avatar link" field any more: the link is the fallback beside the upload.
  await expect(dialog.getByLabel("Avatar link")).toHaveCount(0);
  const link = dialog.getByLabel("Or paste a link to a picture");
  await link.fill("not a link");
  await expect(dialog.getByRole("alert")).toContainText("isn't a web address");
  await expect(dialog.getByTestId("social-edit-profile-save")).toBeDisabled();

  await dialog.getByTestId("social-profile-picture-file").setInputFiles({
    name: "me.png",
    mimeType: "image/png",
    buffer: PNG,
  });
  await expect(dialog.getByRole("img", { name: "Your picture" })).toBeVisible();
  await expect(link).toHaveValue(pictureUrl);
  await dialog.getByTestId("social-edit-profile-save").click();
  await expect
    .poll(() =>
      relay.events
        .filter(
          (e) => e.kind === 0 && e.pubkey === OWNER && e.id !== "profile-1",
        )
        .map((e) => JSON.parse(e.content).picture),
    )
    .toEqual([pictureUrl]);
});

test("the recovery key dialog keeps Tab inside it while open, closes the account menu under it, and gives focus back to the account button", async ({
  page,
}) => {
  await openAsOwner(page, { name: "Mira Okafor" });
  await page.goto("/");
  const chip = page.getByTestId("user-chip").first();
  await chip.click();
  const opener = page.getByRole("button", {
    name: /^(Save a recovery key|Recovery key)$/,
  });
  await opener.click();
  const backup = page.getByTestId("backup-dialog");
  await expect(backup).toBeVisible();
  // The dialog takes over from the menu: it does not stay open underneath (on a phone it showed below the dialog).
  await expect(page.getByTestId("profile-popover")).toHaveCount(0);
  // Focus starts on the dialog itself, so its title is read first.
  await expect(backup.getByRole("dialog")).toBeFocused();

  const focusInDialog = () =>
    page.evaluate(() =>
      Boolean(
        document
          .querySelector("[data-testid='backup-dialog']")
          ?.contains(document.activeElement),
      ),
    );
  // Round the dialog's buttons more than once, both ways: focus never reaches the page behind it.
  for (let step = 0; step < 8; step += 1) {
    await page.keyboard.press("Tab");
    expect(await focusInDialog()).toBe(true);
  }
  await backup.getByRole("dialog").focus();
  for (let step = 0; step < 8; step += 1) {
    await page.keyboard.press("Shift+Tab");
    expect(await focusInDialog()).toBe(true);
  }
  await expect(page.getByTestId("backup-close")).toBeVisible();

  const focused = () =>
    page.evaluate(
      () => (document.activeElement as HTMLElement | null)?.dataset.testid,
    );
  // Escape closes the dialog, and focus is back on the account button the menu hangs from.
  await page.keyboard.press("Escape");
  await expect(backup).toHaveCount(0);
  await expect.poll(focused).toBe("user-chip");

  // Closed by pointer, the same.
  await chip.click();
  await opener.click();
  await expect(backup).toBeVisible();
  await page.getByTestId("backup-close").click();
  await expect(backup).toHaveCount(0);
  await expect.poll(focused).toBe("user-chip");
});

test("a profile the server could not save says so in plain words, with the server's under Technical details", async ({
  page,
}) => {
  await openAsOwner(
    page,
    { name: "Mira Okafor" },
    {
      refuse: (event) =>
        event.kind === 0 ? "error: database error: down" : null,
    },
  );
  await page.goto("/");
  await page.getByTestId("user-chip").first().click();
  await page.getByRole("button", { name: "Edit profile" }).click();
  await page.getByTestId("profile-save").click();

  await expect(page.getByTestId("profile-save-error")).toHaveText(
    "Couldn't save your profile. Try again.",
    { timeout: 15_000 },
  );
  const details = page.getByTestId("profile-save-error-details");
  await expect(details).toHaveJSProperty("open", false);
  await details.locator("summary").click();
  await expect(details).toContainText("error: database error: down");
});
