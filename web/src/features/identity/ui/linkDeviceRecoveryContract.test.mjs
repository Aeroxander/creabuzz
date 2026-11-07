import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * Rule 6 contract for the device-link handoff: the "linked" screen must keep a
 * way BACK to the desktop app.
 *
 * `confirm()` fires a one-shot `window.location.assign(creaton://…)`, which
 * browsers silently drop whenever a custom-scheme navigation is blocked or no
 * handler is registered. Without a user-visible link the user is stranded on
 * "Link sent — finish in your desktop app" with nothing to do, and the
 * encrypted payload (single-use, 5-minute expiry) is wasted.
 *
 * JSX cannot render under `node --test`, so the wiring is the seam: the URL
 * must be kept in state and rendered as an `href` on the linked screen —
 * never as visible text (it carries the encrypted account key).
 */

const ROOT = new URL("../../../../", import.meta.url);

function read(relativePath) {
  return readFileSync(fileURLToPath(new URL(relativePath, ROOT)), "utf8");
}

const page = read("src/features/identity/ui/LinkDevicePage.tsx");

test("the handoff url is kept in state so the linked screen can re-offer it", () => {
  assert.match(
    page,
    /setHandoffUrl\(handoff\.url\)/,
    "confirm() must keep the callback URL — the one-shot redirect is unreliable",
  );
  assert.match(page, /handoffUrl/);
});

test("the linked screen offers an explicit link back to the desktop app", () => {
  const linked = page.slice(page.indexOf('data-testid="link-device-linked"'));
  assert.match(
    linked,
    /data-testid="link-device-open-desktop"/,
    "the linked screen needs a user-visible way to open the desktop app",
  );
  assert.match(linked, /href=\{handoffUrl\}/);
  assert.match(linked, /Open the desktop app/);
});

test("the payload url is never rendered as visible text", () => {
  // It carries the NIP-44 ciphertext of the account key: it may only ever
  // appear as an `href`, never as a JSX text node.
  const occurrences = [...page.matchAll(/\{handoffUrl\}/g)];
  assert.ok(occurrences.length > 0, "the href must reference it");
  for (const match of occurrences) {
    const before = page.slice(Math.max(0, match.index - 8), match.index);
    assert.match(
      before,
      /href=$/,
      `{handoffUrl} must only appear as href={handoffUrl} — it carries the payload`,
    );
  }
});

test("the error screen offers a way back into the app", () => {
  const err = page.slice(page.indexOf('data-testid="link-device-error"'));
  assert.match(err, /href="\/"/, "a failed link must not be a dead end");
});
