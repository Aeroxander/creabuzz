import assert from "node:assert/strict";
import { test } from "node:test";

import {
  finishName,
  nameProblem,
  pickApiOrigin,
  previewHost,
  tidyName,
} from "./community-name.ts";

test("what is typed is tidied as it goes: lower case, hyphens for spaces, nothing a name cannot hold", () => {
  assert.equal(tidyName("My Film"), "my-film");
  assert.equal(tidyName("night_sky  2026"), "night-sky-2026");
  assert.equal(tidyName("Café!"), "caf");
  assert.equal(tidyName("a--b---c"), "a-b-c");
  assert.equal(tidyName("a.b/c"), "abc");
});

test("a hyphen at the end survives typing, and is taken off when the name is finished", () => {
  assert.equal(tidyName("my-"), "my-");
  assert.equal(finishName("my-"), "my");
  assert.equal(finishName("  -My Film- "), "my-film");
  assert.equal(finishName(""), "");
});

test("the problems are the ones the server would raise, in plain words", () => {
  assert.match(nameProblem(""), /Pick a name/);
  assert.match(nameProblem("ab"), /at least 3/);
  assert.match(nameProblem("a".repeat(33)), /at most 32/);
  assert.match(nameProblem("ab--cd"), /third and fourth/);
  assert.equal(nameProblem("acme"), null);
  assert.equal(nameProblem("a".repeat(32)), null);
  assert.equal(nameProblem("abc"), null);
});

test("the limits the server reports are the ones used", () => {
  assert.equal(
    nameProblem("abcd", { min: 5, max: 10 }),
    "Names need at least 5 letters or numbers.",
  );
  assert.equal(
    nameProblem("abcdefghijk", { min: 5, max: 10 }),
    "Names can be at most 10 letters or numbers.",
  );
});

test("no message talks in protocol terms", () => {
  const all = [
    nameProblem(""),
    nameProblem("ab"),
    nameProblem("a".repeat(40)),
    nameProblem("ab--cd"),
  ].join(" ");
  assert.doesNotMatch(all, /slug|relay|host|dns|label/i);
});

test("a name becomes an address under the server's domain", () => {
  assert.equal(previewHost("acme", "creaton.example"), "acme.creaton.example");
  assert.equal(previewHost("acme", "localhost:3000"), "acme.localhost:3000");
});

test("the signed request goes to the configured origin, else to the app's own, and never to something that is not an origin", () => {
  assert.equal(
    pickApiOrigin(undefined, "http://localhost:3000"),
    "http://localhost:3000",
  );
  assert.equal(
    pickApiOrigin("", "http://localhost:3000"),
    "http://localhost:3000",
  );
  assert.equal(
    pickApiOrigin("https://creaton.example/", "http://localhost:3000"),
    "https://creaton.example",
  );
  assert.equal(
    pickApiOrigin("https://creaton.example/api", "http://localhost:3000"),
    null,
  );
  assert.equal(
    pickApiOrigin("javascript:alert(1)", "http://localhost:3000"),
    null,
  );
  assert.equal(pickApiOrigin("not a url", "http://localhost:3000"), null);
  assert.equal(
    pickApiOrigin("https://creaton.example?x=1", "http://localhost:3000"),
    null,
  );
});
