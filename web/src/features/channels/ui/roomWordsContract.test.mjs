import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { findCopyViolations } from "../../../../../scripts/check-copy-core.mjs";

/**
 * People talk in rooms; "channel" is the protocol's word and the code's, not the one anyone reads. These files kept
 * saying "Create a channel" beside "Rooms" elsewhere, so this reads their user-visible strings (string literals,
 * template text and JSX text, never identifiers or comments, the same parser as the copy check) and fails on any that
 * still says channel. A test id ("channel-header-private") has no space in it and is not text anyone reads; a bare
 * "Channels" heading is.
 */

const require = createRequire(import.meta.url);
const ts = require("typescript");

const ROOT = new URL("../../../../", import.meta.url);

const FILES = [
  "src/features/channels/ui/ChannelSidebar.tsx",
  "src/features/channels/ui/ChannelTimeline.tsx",
  "src/features/channels/ui/CommunityShell.tsx",
  "src/features/channels/ui/CreateChannelDialog.tsx",
  "src/features/channels/lib/system-notes.ts",
];

const SAYS_CHANNEL = [
  {
    id: "room-not-channel",
    pattern: /^(?=[\s\S]*\s)[\s\S]*\bchannels?\b/i,
    why: 'say "room"',
  },
  {
    // A one-word heading or label; a lowercase "channel" alone is a key or query parameter.
    id: "room-not-channel-heading",
    pattern: /^\s*Channels?\s*$/,
    why: 'say "Rooms"',
  },
];

test('rooms are called rooms in the words people read, never "channel"', () => {
  const found = FILES.flatMap((file) =>
    findCopyViolations(
      ts,
      file,
      readFileSync(fileURLToPath(new URL(file, ROOT)), "utf8"),
      SAYS_CHANNEL,
    ).map((violation) => `${file}:${violation.line} ${violation.snippet}`),
  );
  assert.deepEqual(found, []);
});
