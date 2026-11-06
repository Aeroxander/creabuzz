/**
 * Every way this page sends a change to the server as the person must stop while changed terms are not agreed to
 * (`action-guard.ts`: "every send goes through assertMayAct first").
 *
 * Sending over the relay connection is guarded once, in `publish-event.ts`. This reads the source for the other kind:
 * a file that signs as the person (or builds their login header) and then makes a POST, PUT, PATCH or DELETE request
 * itself. Each must call `assertMayAct` the number of times listed, or be listed in READS_OR_SIGN_UP with the reason
 * it is not a change made as a person who may have to agree first. A new sender in an unlisted file fails here.
 * Run under `node --test`; no alias or browser is needed.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../../", import.meta.url));

/** Files that guard their own writes, and how many guard calls each holds (one per exported sender). */
const GUARDED = {
  "shared/lib/upload-blob.ts": 1,
  "features/communities/use-access.ts": 2, // make an invite, end an invite
  "features/communities/use-self-serve.ts": 1, // start a community
  "features/identity/lib/siwe.ts": 2, // connect a wallet, disconnect it
  "features/moderation/use-escalated-reports.ts": 1, // acting on a report
};

/** Files that sign and POST but change nothing as a person who must have agreed, with why. */
const READS_OR_SIGN_UP = {
  "shared/lib/http-query.ts":
    "a POST that only reads (the server's query route)",
  "features/channels/use-unread-rooms.ts":
    "a POST that only keeps this person's own read marks",
  "features/invite/invite-api.ts":
    "joining with an invite: the join page asks for the terms first, and the person has no account to block before it",
  "features/launchpad/ask-ai.ts":
    "asks the AI service for a draft; nothing is posted or changed as the person",
  "features/fleet/browser-agent.ts":
    "asks the AI service for the next step; every change it makes goes through the guarded relay connection",
};

function sourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) out.push(path);
  }
  return out;
}

/** Source without comments, so a name in prose is not taken for a call. */
function code(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** True for a file that signs as the person and makes a changing request itself. */
function isDirectSender(text) {
  const src = code(text);
  return (
    /\b(signAsUser|makeNip98AuthHeader)\(/.test(src) &&
    /\b(fetch|timedFetch|timedFetchStreamed)\(/.test(src) &&
    /["'](POST|PUT|PATCH|DELETE)["']/.test(src)
  );
}

const all = new Map(
  sourceFiles(SRC).map((path) => [
    relative(SRC, path).split("\\").join("/"),
    readFileSync(path, "utf8"),
  ]),
);

describe("every change sent as the person stops while changed terms are not agreed to", () => {
  it("finds the direct senders (the scan itself works)", () => {
    const found = [...all].filter(([, text]) => isDirectSender(text));
    assert.ok(found.length >= Object.keys(GUARDED).length);
    assert.ok(found.some(([file]) => file === "shared/lib/upload-blob.ts"));
  });

  it("lists every direct sender", () => {
    const listed = new Set([
      ...Object.keys(GUARDED),
      ...Object.keys(READS_OR_SIGN_UP),
    ]);
    const strays = [...all]
      .filter(([file, text]) => !listed.has(file) && isDirectSender(text))
      .map(([file]) => file);
    assert.deepEqual(
      strays,
      [],
      "A file that signs as the person and makes a changing request must call assertMayAct (see action-guard.ts), or be listed in READS_OR_SIGN_UP with why not.",
    );
  });

  for (const [file, calls] of Object.entries(GUARDED)) {
    it(`${file}: calls assertMayAct ${calls} time(s)`, () => {
      const text = all.get(file);
      assert.ok(text, `${file} exists`);
      const src = code(text);
      assert.match(
        src,
        /import \{[^}]*\bassertMayAct\b[^}]*\} from "[^"]*action-guard(\.ts)?"/,
        `${file} imports assertMayAct`,
      );
      assert.equal(
        (src.match(/\bassertMayAct\(\)/g) ?? []).length,
        calls,
        `${file}: every sender must call assertMayAct() before it signs`,
      );
    });
  }
});
