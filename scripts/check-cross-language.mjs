#!/usr/bin/env node
// check-cross-language.mjs: the numbers and word lists that exist in two languages (Rust on the server, TypeScript in the app), each tied by one check (docs/next-version/STEP3-PLAN.md, section 9.2, X3). It reads the sources as text, so a change on one side that the other did not
// follow fails here and not on a person's phone.
//
//   1. the room's character limit: the server's `BODY_CHARS_MAX` (and the number in its refusal sentence) equals the app's
//      `MAX_POST_CHARS`, which the composer uses;
//   2. the sponsor's refusal words: the server's list of words the app recognises is the app's own pattern (the same words, in
//      the same sense), and each of the server's two refusals holds one of them.
//
// Usage: node --experimental-strip-types scripts/check-cross-language.mjs      Exit 0 and "N checks passed" when all hold.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
  /MAX_POST_CHARS/.test(text("app/src/features/posts/Composer.tsx") || ""),
);

// 2. The sponsor's refusal words.
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
