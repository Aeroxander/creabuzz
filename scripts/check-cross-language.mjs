#!/usr/bin/env node
// check-cross-language.mjs: the numbers and word lists that exist in two languages (Rust on the server, TypeScript in the app and
// in the service worker), each tied by one check (docs/next-version/STEP3-PLAN.md, section 9.2, X3). It reads the sources as text
// (and runs the service worker file in an isolated context, as a browser does), so a change on one side that the other did not
// follow fails here and not on a person's phone.
//
//   1. the room's character limit: the server's `BODY_CHARS_MAX` (and the number in its refusal sentence) equals the app's
//      `MAX_POST_CHARS`, which the composer uses;
//   2. the alert kinds: the server's alert maker (`web_push::Kind::as_str`), the service worker (`app/public/sw.js`) and the
//      app's push words (`push-words.ts`) hold the same three kinds, and the worker's three sentences are the app's;
//   3. the message the server sends has the keys the worker reads (`v`, `k`, `r`);
//   4. the sponsor's refusal words: the server's list of words the app recognises is the app's own pattern (the same words, in
//      the same sense), and each of the server's two refusals holds one of them.
//
// Usage: node --experimental-strip-types scripts/check-cross-language.mjs      Exit 0 and "N checks passed" when all hold.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const text = (path) => readFileSync(join(ROOT, path), "utf8");
let passed = 0;
const failures = [];
function same(what, got, want) {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a === b) {
    passed += 1;
    console.log(`ok    ${what}: ${a}`);
  } else {
    failures.push(`${what}: got ${a}, expected ${b}`);
  }
}
function must(what, value) {
  if (value) {
    passed += 1;
    console.log(`ok    ${what}`);
  } else failures.push(what);
}
function grab(source, pattern, what) {
  const match = pattern.exec(source);
  if (!match) throw new Error(`cannot find ${what}: the source changed shape`);
  return match;
}

// 1. The room's character limit.
const room = text("crates/buzz-relay/src/handlers/room_write.rs");
const rustLimit = Number(
  grab(room, /pub\(crate\) const BODY_CHARS_MAX: usize = (\d+);/, "BODY_CHARS_MAX")[1],
);
const rustSentence = Number(
  grab(room, /pub\(crate\) const TOO_LONG: &str = "invalid: a room post is at most (\d+) characters";/, "TOO_LONG")[1],
);
const appLimit = Number(
  grab(
    text("packages/creaton-core/src/social/feed/feed-events.ts"),
    /export const MAX_POST_CHARS = (\d+);/,
    "MAX_POST_CHARS",
  )[1],
);
same("the room's limit on the server equals the app's MAX_POST_CHARS", rustLimit, appLimit);
same("the number in the server's refusal sentence is the same limit", rustSentence, appLimit);
must(
  "the app's composer takes its limit from MAX_POST_CHARS (no second number)",
  /MAX_POST_CHARS/.test(text("app/src/features/room/RoomComposer.tsx") || ""),
);

// 2. The alert kinds.
const kindsRust = [
  ...grab(
    text("crates/buzz-relay/src/web_push/mod.rs"),
    /pub fn as_str\(self\) -> &'static str \{([\s\S]*?)\n    \}/,
    "Kind::as_str",
  )[1].matchAll(/=> "([a-z]+)"/g),
].map((m) => m[1]);
same("the server makes alerts of exactly three kinds", [...kindsRust].sort(), ["ended", "planned", "taken"]);
const workerSource = text("app/public/sw.js");
const scope = {
  addEventListener: () => {},
  location: { origin: "http://localhost" },
  registration: {},
  clients: {},
  skipWaiting: async () => undefined,
};
const context = vm.createContext({ self: scope, caches: {}, URL, Response, Request, Object, JSON, Promise });
const worker = vm.runInContext(`${workerSource}\n;({ PUSH_TITLE, PUSH_WORDS })`, context);
same("the service worker shows exactly the server's kinds", Object.keys(worker.PUSH_WORDS).sort(), [...kindsRust].sort());
const words = await import(pathToFileURL(join(ROOT, "app/src/features/alerts/push/push-words.ts")).href);
same("the app's push words hold the server's kinds", Object.keys(words.PUSH_WORDS).sort(), [...kindsRust].sort());
same("the worker's three sentences are the app's, word for word", { ...worker.PUSH_WORDS }, { ...words.PUSH_WORDS });
same("the worker's title is the app's", worker.PUSH_TITLE, words.PUSH_TITLE);

// 3. The message's keys.
const messageKeys = [
  ...grab(
    text("crates/buzz-relay/src/web_push/mod.rs"),
    /pub fn message\([^)]*\) -> String \{\s*serde_json::json!\(\{([^}]*)\}\)/,
    "web_push::message",
  )[1].matchAll(/"([a-z])":/g),
].map((m) => m[1]);
same("the message the server sends has the keys v, k and r", [...messageKeys].sort(), ["k", "r", "v"]);
must(
  "the worker reads those three keys (version, kind, link) and no other",
  /\.v\b/.test(workerSource) && /\.k\b|kind/.test(workerSource) && /\.r\b|ref/.test(workerSource),
);

// 4. The sponsor's refusal words.
const sponsor = text("crates/buzz-relay/src/api/sponsor.rs");
const appWordsRust = [
  ...grab(sponsor, /pub const APP_WORDS: \[&str; \d+\] = \[([\s\S]*?)\];/, "APP_WORDS")[1].matchAll(/"([^"]+)"/g),
].map((m) => m[1]);
const pattern = grab(
  text("packages/creaton-core/src/aa/zerodev.ts"),
  /function looksLikePolicyDenial\(message: string\): boolean \{\s*return \/([^/]+)\/i\.test\(message\);/,
  "looksLikePolicyDenial",
)[1];
same("the server's list of words the app recognises is the app's own pattern", [...appWordsRust].sort(), pattern.split("|").sort());
const appRegex = new RegExp(pattern, "i");
for (const name of ["LIMIT_EXCEEDED", "NOT_ALLOWED"]) {
  const sentence = grab(sponsor, new RegExp(`pub const ${name}: &str = "([^"]+)";`), name)[1];
  must(`the server's refusal "${sentence}" is recognised by the app as a refusal of the sponsor`, appRegex.test(sentence));
}
must(
  "the server's \"not reachable\" answer is not mistaken for a refusal",
  !appRegex.test(grab(sponsor, /const UPSTREAM_DOWN: &str = "([^"]+)";/, "UPSTREAM_DOWN")[1]),
);

if (failures.length > 0) {
  for (const f of failures) console.error(`FAIL  ${f}`);
  console.error(`check-cross-language: ${failures.length} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`check-cross-language: ${passed} checks passed.`);
