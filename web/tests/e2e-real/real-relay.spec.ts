import { expect, test } from "@playwright/test";

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

test.fixme("a message is stored by the relay and survives a reload", async ({
  page,
}) => {
  // Needs a channel that the relay itself recognises: channel metadata
  // (kind 39000) is relay-authored — a client publishing it is rejected as
  // "unknown event kind" — and a SQL-seeded channel did not get discovery
  // events from `BUZZ_RECONCILE_CHANNELS` in this environment. Create the
  // channel through the relay's own path (e.g. `buzz channels create`), then
  // enable this: post a message, reload, and assert it is still there, which
  // proves the relay accepted and stored it rather than the page echoing it.
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
  await page.getByTestId("composer-input").fill(body);
  await page.getByTestId("composer-send").click();
  await expect(page.getByText(body)).toBeVisible({ timeout: 20_000 });

  await page.reload();
  await page
    .getByRole("button", { name: /general/ })
    .first()
    .click();
  await expect(page.getByText(body)).toBeVisible({ timeout: 20_000 });
});
