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
  await page.getByTestId("composer-input").fill(body);
  // Let the controlled draft commit before submitting; the dev relay also
  // rate-limits writes, so a send can be refused if tests post in a burst.
  await expect(page.getByTestId("composer-send")).toBeEnabled();
  await page.getByTestId("composer-send").click();
  await expect(
    page.locator("[data-sonner-toast]").filter({ hasText: /couldn't send/i }),
  ).toHaveCount(0);
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
