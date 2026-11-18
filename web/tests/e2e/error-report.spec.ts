import { expect, test } from "@playwright/test";

import { createMockRelay } from "./mock-relay";

/**
 * Error reporting in a real browser. Opt-in: the collector's address is baked into the build, so
 * `scripts/web-error-report-e2e.sh` builds the web app pointed at a stand-in address and runs this spec, which answers that
 * address itself. It checks what only a browser can: that a real uncaught error and a real unhandled rejection reach the
 * collector as small scrubbed notes, with no cookies and no query string, and that the page keeps working when the
 * collector is down.
 */

const COLLECTOR = process.env.E2E_ERROR_COLLECTOR ?? "";
const HEX = "cd".repeat(32);

test.skip(
  !COLLECTOR,
  "set E2E_ERROR_COLLECTOR (scripts/web-error-report-e2e.sh builds and runs this)",
);

test("an uncaught error and an unhandled rejection reach the collector as scrubbed notes", async ({
  page,
}) => {
  const notes: Record<string, unknown>[] = [];
  const headers: Record<string, string>[] = [];
  await page.route(COLLECTOR, async (route) => {
    notes.push(JSON.parse(route.request().postData() ?? "{}"));
    headers.push(route.request().headers());
    await route.fulfill({ status: 204 });
  });
  const relay = createMockRelay();
  await relay.install(page);
  await page.goto("/c?invite=secret-code#frag");
  await expect(
    page.getByRole("heading", { name: "Communities" }),
  ).toBeVisible();

  await page.evaluate((id) => {
    setTimeout(() => {
      throw new Error(`could not load ${id}`);
    }, 0);
    void Promise.reject(new Error("nobody listened"));
  }, HEX);

  await expect.poll(() => notes.length).toBe(2);
  const byKind = Object.fromEntries(notes.map((n) => [n.kind, n]));
  expect(byKind.error?.message).toBe("could not load [id]");
  expect(byKind.rejection?.message).toBe("nobody listened");
  for (const note of notes) {
    expect(note.page).toBe("/c");
    expect(typeof note.at).toBe("number");
    expect(Object.keys(note).sort()).toEqual([
      "at",
      "kind",
      "message",
      "page",
      "release",
      "stack",
    ]);
    expect(JSON.stringify(note)).not.toMatch(/secret-code|frag|cdcdcd/);
  }
  for (const header of headers) {
    expect(header.cookie ?? "").toBe("");
    expect(header["content-type"]).toContain("application/json");
  }
  expect(notes[0].release).toBe("e2e");
});

test("a collector that is down changes nothing for the page", async ({
  page,
}) => {
  await page.route(COLLECTOR, (route) => route.abort());
  const relay = createMockRelay();
  await relay.install(page);
  await page.goto("/c");
  await expect(
    page.getByRole("heading", { name: "Communities" }),
  ).toBeVisible();
  await page.evaluate(() => {
    setTimeout(() => {
      throw new Error("something broke");
    }, 0);
  });
  // The page is still usable after the failed send.
  await page.waitForTimeout(300);
  await expect(
    page.getByRole("heading", { name: "Communities" }),
  ).toBeVisible();
});
