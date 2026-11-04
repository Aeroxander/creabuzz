import { test, type Browser, type Page } from "@playwright/test";

/**
 * A page that lives in a browser of its own.
 *
 * This host's Chromium only runs `--single-process` (the only mode its sandbox
 * permits), and a second context in one browser kills the whole browser — the
 * spec sees `browserContext.newPage: Target page, context or browser has been
 * closed`. A journey that shows two people at once therefore needs two browsers.
 *
 * The browser is launched from the project's own `launchOptions`, so the same
 * executable and sandbox flags the rest of the run uses apply to it too, and
 * `closeOwnPages` (register it with `test.afterEach`) closes every one however
 * the test ends.
 */
const launched: Browser[] = [];

export async function ownPage(
  browser: Browser,
  options: { viewport?: { width: number; height: number } } = {},
): Promise<Page> {
  const own = await browser
    .browserType()
    .launch(test.info().project.use.launchOptions);
  launched.push(own);
  const context = await own.newContext(
    options.viewport === undefined ? {} : { viewport: options.viewport },
  );
  return context.newPage();
}

/** Close every browser `ownPage` launched. Register with `test.afterEach`. */
export async function closeOwnPages(): Promise<void> {
  await Promise.all(launched.splice(0).map((own) => own.close()));
}
