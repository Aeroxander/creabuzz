/**
 * Deep-link shape tests for the launchpad → web money-plane handoff.
 *
 * The shape is a contract with web's route
 * (`web/src/app/routes/launchpad.$launchId.tsx`): path `/launchpad/<id>`,
 * `author` search param (web resolves the record by it), and the `action`
 * query param carrying the money-plane intent.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { launchWebUrl } from "./webLinks.ts";

const LAUNCH = {
  id: "nebula",
  author: "953d0f2a00000000000000000000000000000000000000000000000000000000",
};

test("launchWebUrl builds web's canonical detail route with author + action", () => {
  const url = new URL(
    launchWebUrl("http://localhost:3000", LAUNCH, "bid") ?? "",
  );
  assert.equal(url.origin, "http://localhost:3000");
  assert.equal(url.pathname, "/launchpad/nebula");
  assert.equal(url.searchParams.get("author"), LAUNCH.author);
  assert.equal(url.searchParams.get("action"), "bid");
});

test("launchWebUrl carries every money-plane action as a query param", () => {
  for (const action of ["bid", "exit", "claim"]) {
    const url = new URL(
      launchWebUrl("https://relay.example", LAUNCH, action) ?? "",
    );
    assert.equal(url.searchParams.get("action"), action);
    assert.equal(url.pathname, "/launchpad/nebula");
  }
});

test("launchWebUrl percent-encodes launch ids with reserved characters", () => {
  const url = new URL(
    launchWebUrl("http://localhost:3000", { ...LAUNCH, id: "a/b?c" }, "bid") ??
      "",
  );
  assert.equal(url.pathname, "/launchpad/a%2Fb%3Fc");
});

test("launchWebUrl returns null without a resolved relay origin", () => {
  assert.equal(launchWebUrl(null, LAUNCH, "bid"), null);
  assert.equal(launchWebUrl("", LAUNCH, "bid"), null);
  assert.equal(launchWebUrl("not a url", LAUNCH, "bid"), null);
});

test("launchWebUrl keeps the query style web already parses", () => {
  const raw = launchWebUrl("http://localhost:3000", LAUNCH, "exit") ?? "";
  // Query params, not hash fragments: web's validateSearch reads `author`
  // from the query string today, so `action` rides the same mechanism.
  assert.ok(!raw.includes("#"), "no fragment in the deep link");
  assert.ok(raw.includes("?author="), "author rides the query string");
  assert.ok(raw.includes("&action=exit"), "action rides the query string");
});
