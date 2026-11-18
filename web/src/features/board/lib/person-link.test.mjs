import assert from "node:assert/strict";
import { test } from "node:test";
import { nip19 } from "nostr-tools";

import { parsePersonOrLink } from "./person-link.ts";

const KEY = "ab".repeat(32);

test("a profile link, a key or an npub gives the person", () => {
  assert.equal(parsePersonOrLink(`https://example.com/u/${KEY}`), KEY);
  assert.equal(parsePersonOrLink(` /u/${KEY.toUpperCase()}/ `), KEY);
  assert.equal(
    parsePersonOrLink(`https://example.com/u/${KEY}?tab=posts`),
    KEY,
  );
  assert.equal(parsePersonOrLink(KEY), KEY);
  assert.equal(parsePersonOrLink(nip19.npubEncode(KEY)), KEY);
  assert.equal(
    parsePersonOrLink(`https://example.com/u/${nip19.npubEncode(KEY)}`),
    KEY,
  );
});

test("anything else is not a person", () => {
  assert.equal(parsePersonOrLink("https://example.com/b/board"), null);
  assert.equal(parsePersonOrLink("https://example.com/u/%E0%A4%A"), null);
  assert.equal(parsePersonOrLink("alice"), null);
});
