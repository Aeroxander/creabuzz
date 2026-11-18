import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import {
  COPY_RULES,
  findCopyViolations,
} from "../../scripts/check-copy-core.mjs";
import { WEB_COPY_RULES } from "./copy-rules.mjs";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const scan = (text) =>
  findCopyViolations(ts, "x.tsx", text, [...COPY_RULES, ...WEB_COPY_RULES]).map(
    (v) => v.rule,
  );

test("the key format's name in words people read is flagged", () => {
  assert.deepEqual(
    scan('const a = <input placeholder="Public key or npub" />;'),
    ["key-format"],
  );
  assert.deepEqual(
    scan("const b = <p>That doesn't look like an npub. Check it.</p>;"),
    ["key-format"],
  );
  assert.deepEqual(scan('const c = "paste their public key (npub…)";'), [
    "key-format",
  ]);
  assert.deepEqual(scan("const d = `Send it to the NPUB now`;"), [
    "key-format",
  ]);
});

test("code that names the format, test ids and plain words pass", () => {
  assert.deepEqual(
    scan(`
      switch (decoded.type) { case "npub": break; }
      const el = <div data-testid="link-device-npub" />;
      // npub in a comment is fine
      const npubOf = (key) => key;
      const ok = <p>Search for someone, or paste their public key.</p>;
    `),
    [],
  );
});

test("the shared scan alone does not know the web rule (desktop keeps its key screens)", () => {
  assert.deepEqual(
    findCopyViolations(ts, "x.tsx", 'const a = "Public key or npub";').map(
      (v) => v.rule,
    ),
    [],
  );
});
