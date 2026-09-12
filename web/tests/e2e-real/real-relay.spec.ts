import { expect, test, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { mintInvite } from "./invite.mjs";
import { publishAs } from "./publish.mjs";

/**
 * The client against a real relay: real NIP-42 auth, real ingest, real
 * Postgres reads. Everything else in this suite mocks all of that, which is why
 * this file exists — it has already found bugs the mocks could not:
 *
 *  * the theme bootstrap sat at the dist root, and the relay serves only
 *    `/assets/*` from the web directory, so it was answered with the SPA shell;
 *    the browser parsed HTML as JavaScript and the bootstrap never ran;
 *  * `GET /` returns NIP-11 JSON unless the request asks for HTML.
 *
 * See `tests/e2e-real/README.md` for the setup.
 */

const DEV_NSEC =
  "3dbaebadb5dfd777ff25149ee230d907a15a9e1294b40b830661e65bb42f6c03";
const COMMUNITY = process.env.BUZZ_REAL_RELAY_HOST ?? "localhost:3199";

test.use({ viewport: { width: 1280, height: 900 } });

/**
 * Send a message, waiting out the relay's per-identity write rate limit.
 *
 * The dev relay refuses bursts, so a suite that posts several messages in a few
 * seconds can have one refused outright. The composer only clears when the relay
 * accepted the write, which is the signal this waits for.
 */
async function sendMessage(page: Page, text: string) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await page.getByTestId("composer-input").fill(text);
    await expect(page.getByTestId("composer-send")).toBeEnabled();
    await page.getByTestId("composer-send").click();
    try {
      await expect(page.getByTestId("composer-input")).toHaveValue("", {
        timeout: 10_000,
      });
      return;
    } catch {
      const refused = page
        .locator("[data-sonner-toast]")
        .filter({ hasText: /couldn't send/i });
      await expect(refused).toBeVisible({ timeout: 10_000 });
      await page.waitForTimeout(20_000);
    }
  }
  throw new Error(`the relay refused "${text}" four times`);
}

interface Fixture {
  relay: string;
  channelName: string;
  ownerPubkey: string;
  ownerNsec: string;
  mentionNsec: string;
  mentionPubkey: string;
}

/**
 * The fixture `seed.mjs` writes. Tests that need a second identity skip with
 * instructions rather than failing when the file is missing, so the rest of the
 * suite still runs on a minimal setup.
 */
function fixtureOrSkip(): Fixture {
  const path = join(dirname(fileURLToPath(import.meta.url)), ".fixture.json");
  if (!existsSync(path)) {
    test.skip(
      true,
      "run `node tests/e2e-real/seed.mjs` to write .fixture.json (see README.md)",
    );
  }
  return JSON.parse(readFileSync(path, "utf8")) as Fixture;
}

test("the relay serves the client's scripts from /assets", async ({
  request,
}) => {
  // The relay serves only `/assets/*` from the web directory; everything else
  // falls back to the SPA shell. A script at the dist root is therefore served
  // as HTML, fails to parse, and silently stops the theme bootstrap running —
  // which is exactly what happened before this test existed.
  const boot = await request.get("/assets/theme-boot.js");
  expect(boot.status()).toBe(200);
  expect(boot.headers()["content-type"] ?? "").toContain("javascript");

  const shell = await request.get("/", { headers: { Accept: "text/html" } });
  expect(shell.headers()["content-type"] ?? "").toContain("html");
  expect(await shell.text()).toContain("Content-Security-Policy");
});

test("the client loads from the relay without page errors", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.addInitScript(
    ([nsec]) => window.localStorage.setItem("buzz.identity.nsec", nsec),
    [DEV_NSEC],
  );
  await page.goto(`/c/${COMMUNITY}`);
  // The shell is served, the SPA route resolves, and the relay's own endpoints
  // answer JSON rather than the shell (the "Unexpected token '<'" failure).
  await expect(page.getByText(/Creaton|All communities/).first()).toBeVisible({
    timeout: 20_000,
  });
  expect(pageErrors, pageErrors.join(" | ")).toEqual([]);
});

test("a message is stored by the relay and survives a reload", async ({
  page,
}) => {
  // The dev relay rate-limits writes per identity, so a send issued in a burst
  // can be accepted after this test's own reload window; hence the slow marker
  // and the generous timeouts.
  test.slow();
  // The whole point of the real-relay run: the message must be in Postgres, not
  // echoed by the page. A reload drops every client-side copy, so what is still
  // on screen afterwards came from the relay.
  await page.addInitScript(
    ([nsec]) => window.localStorage.setItem("buzz.identity.nsec", nsec),
    [DEV_NSEC],
  );
  const body = `real relay check ${Date.now()}`;
  await page.goto(`/c/${COMMUNITY}`);
  await page
    .getByRole("button", { name: /general/ })
    .first()
    .click();
  await sendMessage(page, body);
  // Assert on rendered text, not `getByText`: that engine also matches a
  // textbox's value, so it would happily match the draft still sitting in the
  // composer and pass without the relay ever storing anything.
  await expect
    .poll(() => page.locator("body").innerText(), { timeout: 30_000 })
    .toContain(body);

  await page.reload();
  await page
    .getByRole("button", { name: /general/ })
    .first()
    .click();
  await expect
    .poll(() => page.locator("body").innerText(), { timeout: 30_000 })
    .toContain(body);
});

test("a wiki page is stored by the relay and is still there after a reload", async ({
  page,
}) => {
  // The wiki's local cache uses SQLite-WASM over OPFS, which the relay only
  // enables for a cross-origin-isolated document (COOP/COEP headers). This is
  // the only place that combination is exercised, and the page must survive
  // without any local cache anyway: the relay is the source of truth.
  test.slow();
  await page.addInitScript(
    ([nsec]) => window.localStorage.setItem("buzz.identity.nsec", nsec),
    [DEV_NSEC],
  );
  const slug = `verify-${Date.now().toString(36)}`;
  const body = `Wiki body written against a real relay ${slug}`;

  await page.goto(`/c/${COMMUNITY}`);
  await page.getByTestId("wiki-toggle").click();
  await page.getByTestId("wiki-new-page").click();
  await page.getByTestId("page-name-input").fill(slug);
  await page.getByTestId("page-name-confirm").click();

  const editor = page.getByTestId("wiki-wysiwyg").locator(".ProseMirror");
  await editor.click();
  await page.keyboard.type(body);
  await page.getByTestId("wiki-save").click();
  await expect(page.getByText("Page saved")).toBeVisible({ timeout: 20_000 });

  await page.reload();
  await page.getByTestId("wiki-toggle").click();
  await expect(page.getByTestId(`wiki-page-${slug}`)).toBeVisible({
    timeout: 20_000,
  });
  await page.getByTestId(`wiki-page-${slug}`).click();
  await expect(
    page
      .getByTestId("wiki-wysiwyg")
      .locator(".ProseMirror")
      .filter({ hasText: body }),
  ).toBeVisible({ timeout: 20_000 });
});

test("a mention from another person raises the bell for the mentioned identity", async ({
  page,
}) => {
  // Two things meet here that only a real relay can test: the relay authorizes
  // a p-gated read against the authenticated identity (a subscription sent
  // before the NIP-42 handshake is refused, which is why the clients retry),
  // and `#p` filters are not fanned out, so the bell can only learn about the
  // mention by polling.
  test.slow();
  const fixture = fixtureOrSkip();
  await page.addInitScript(
    ([nsec]) => window.localStorage.setItem("buzz.identity.nsec", nsec),
    [fixture.mentionNsec],
  );

  await page.goto(`/c/${COMMUNITY}`);
  await page
    .getByRole("button", { name: new RegExp(fixture.channelName) })
    .first()
    .click();
  await expect(page.getByTestId("composer-input")).toBeVisible({
    timeout: 20_000,
  });

  // Kind 9 is channel-scoped on this relay (it requires an `h` tag), so the
  // mention goes into the channel this tab actually opened.
  const channelId = await page.evaluate(() =>
    new URL(window.location.href).searchParams.get("channel"),
  );
  expect(channelId, "the app exposes the open channel in the URL").toBeTruthy();

  const marker = `mention check ${Date.now()}`;
  const result = await publishAs(
    fixture.ownerNsec,
    {
      kind: 9,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["h", String(channelId)],
        ["p", fixture.mentionPubkey],
      ],
      content: `@${fixture.mentionPubkey.slice(0, 8)} ${marker}`,
    },
    fixture.relay,
  );
  expect(result.accepted, result.reason).toBe(true);

  // The bell polls, so this arrives without a reload. Assert the marker, not
  // just a badge: this identity is reused between runs, so a count > 0 can come
  // from an older mention.
  await page.getByTestId("notifications-bell").click();
  await expect(page.getByText(marker)).toBeVisible({ timeout: 40_000 });
});

test("an edit and a delete survive a reload on the real relay", async ({
  page,
}) => {
  // The mock relay replays what the client stored; it does not model the
  // relay's own storage rules for edits (kind 40003 overlays) and deletions
  // (kind 5 tombstones). This is where those meet the real thing.
  test.slow();
  await page.addInitScript(
    ([nsec]) => window.localStorage.setItem("buzz.identity.nsec", nsec),
    [DEV_NSEC],
  );

  const open = Date.now();
  const original = `edit target ${open}`;
  const edited = `edited ${open}`;

  await page.goto(`/c/${COMMUNITY}`);
  await page
    .getByRole("button", { name: /general/ })
    .first()
    .click();
  await sendMessage(page, original);
  await expect
    .poll(() => page.locator("body").innerText(), { timeout: 30_000 })
    .toContain(original);

  // Rows are located by their own text: the first row is the relay's
  // channel-created event, and an edited row no longer matches its old text.
  const rowWith = (text: string) =>
    page.getByTestId("message-row").filter({ hasText: text });

  await rowWith(original).hover();
  await rowWith(original).getByTestId("edit-button").click();
  await page.getByTestId("composer-input").fill(edited);
  await page.getByTestId("composer-send").click();
  await expect
    .poll(() => page.locator("body").innerText(), { timeout: 30_000 })
    .toContain(edited);

  // Then delete it, and reload: the tombstone has to come back from the relay.
  await rowWith(edited).hover();
  await rowWith(edited).getByTestId("delete-button").click();
  await page.getByRole("button", { name: "Delete message" }).click();
  await expect(page.getByText("Message deleted")).toBeVisible({
    timeout: 20_000,
  });

  await page.reload();
  await page
    .getByRole("button", { name: /general/ })
    .first()
    .click();
  await expect(page.getByTestId("content-pane")).toBeVisible({
    timeout: 20_000,
  });
  await expect
    .poll(() => page.locator("body").innerText(), { timeout: 30_000 })
    .not.toContain(edited);
});

test("two people editing one wiki page converge through the real relay", async ({
  browser,
}) => {
  // The wiki's cross-client path is a whole-page snapshot saved to the relay and
  // polled back every few seconds. The mocked suite covers the merge logic; this
  // is where it meets a real relay, real NIP-42 auth for a second identity, and
  // the polling interval.
  test.slow();
  const fixture = fixtureOrSkip();
  const slug = `shared-${Date.now().toString(36)}`;
  const mine = `written by the owner ${slug}`;
  const theirs = `and by the second reader ${slug}`;

  const first = await browser.newContext();
  const second = await browser.newContext();
  const owner = await first.newPage();
  const reader = await second.newPage();
  await owner.addInitScript(
    ([nsec]) => window.localStorage.setItem("buzz.identity.nsec", nsec),
    [fixture.ownerNsec],
  );
  await reader.addInitScript(
    ([nsec]) => window.localStorage.setItem("buzz.identity.nsec", nsec),
    [fixture.mentionNsec],
  );

  for (const page of [owner, reader]) {
    await page.goto(`/c/${COMMUNITY}`);
    await page.getByTestId("wiki-toggle").click();
  }

  // The owner creates the page and saves a first version.
  await owner.getByTestId("wiki-new-page").click();
  await owner.getByTestId("page-name-input").fill(slug);
  await owner.getByTestId("page-name-confirm").click();
  const ownerEditor = owner.getByTestId("wiki-wysiwyg").locator(".ProseMirror");
  await ownerEditor.click();
  await owner.keyboard.type(mine);
  await owner.getByTestId("wiki-save").click();
  await expect(owner.getByText("Page saved")).toBeVisible({ timeout: 20_000 });

  // The other client sees the page appear (its list polls the relay).
  const readerPage = reader.getByTestId(`wiki-page-${slug}`);
  await expect(readerPage).toBeVisible({ timeout: 30_000 });
  await readerPage.click();
  const readerEditor = reader
    .getByTestId("wiki-wysiwyg")
    .locator(".ProseMirror");
  await expect(readerEditor).toContainText(mine, { timeout: 30_000 });

  // The reader appends to the same page and saves.
  await readerEditor.click();
  await reader.keyboard.press("End");
  await reader.keyboard.type(` ${theirs}`);
  await reader.getByTestId("wiki-save").click();
  await expect(reader.getByText("Page saved")).toBeVisible({ timeout: 20_000 });

  // Both versions survive: the save is a read-modify-write.
  await expect(readerEditor).toContainText(mine, { timeout: 30_000 });
  await expect(readerEditor).toContainText(theirs, { timeout: 30_000 });
  await expect(ownerEditor).toContainText(theirs, { timeout: 45_000 });
  await expect(ownerEditor).toContainText(mine, { timeout: 30_000 });

  await first.close();
  await second.close();
});

test("an invite minted by an owner enrolls a durable identity, once", async ({
  browser,
}) => {
  // The invite path grants relay membership. Until now nothing exercised it
  // against a real relay: the mocked suites stub the HTTP endpoint, so the
  // NIP-98 signing, the mint, the claim and the membership it grants were all
  // unverified. A single-use invite makes the claim observable: if the first
  // claim were not recorded, the second would succeed.
  test.slow();
  const fixture = fixtureOrSkip();
  const invite = await mintInvite({
    nsec: fixture.ownerNsec,
    baseUrl: `http://${COMMUNITY}`,
    body: JSON.stringify({ max_uses: 1 }),
  });
  expect(invite.url, JSON.stringify(invite)).toContain("/invite/");
  const invitePath = invite.url.replace(`http://${COMMUNITY}`, "");

  /** A fresh identity, with no extension: what this app creates for a reader. */
  const freshNsec = () =>
    `${Date.now().toString(16).padStart(8, "0")}${"ab".repeat(28)}`.slice(
      0,
      64,
    );

  const joiner = await browser.newContext();
  const joinerPage = await joiner.newPage();
  await joinerPage.addInitScript(
    ([nsec]) => window.localStorage.setItem("buzz.identity.nsec", nsec),
    [freshNsec()],
  );
  await joinerPage.goto(invitePath);
  // The button must be offered at all: it used to require a browser extension,
  // which left browser readers with no way to join.
  const join = joinerPage.getByRole("button", { name: "Join in browser" });
  await expect(join).toBeVisible({ timeout: 20_000 });
  await join.click();
  await expect(joinerPage).toHaveURL("/", { timeout: 30_000 });

  // A second identity, same code: the relay must have spent the single use.
  const latecomer = await browser.newContext();
  const latecomerPage = await latecomer.newPage();
  await latecomerPage.addInitScript(
    ([nsec]) => window.localStorage.setItem("buzz.identity.nsec", nsec),
    [freshNsec()],
  );
  await latecomerPage.goto(invitePath);
  await latecomerPage.getByRole("button", { name: "Join in browser" }).click();
  await expect(latecomerPage.getByText(/reached its use limit/i)).toBeVisible({
    timeout: 30_000,
  });

  await joiner.close();
  await latecomer.close();
});
