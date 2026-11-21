// The signed picture read goes to the community's own server and nowhere else: a post's picture address names any host it
// likes, and the signed read carries the viewer's key. Run with: node --experimental-strip-types --test src/client/media-url.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { serverMediaUrl } from "./media-url.ts";

const SERVER = "https://community.example";
const SHA = "a".repeat(64);

test("a picture on the server's own media path is picked out, without its query and fragment", () => {
  assert.equal(
    serverMediaUrl(`${SERVER}/media/${SHA}.jpg?x=1#y`, SERVER),
    `${SERVER}/media/${SHA}.jpg`,
  );
  assert.equal(
    serverMediaUrl(`${SERVER}/media/${SHA}.thumb.jpg`, SERVER),
    `${SERVER}/media/${SHA}.thumb.jpg`,
  );
  assert.equal(
    serverMediaUrl(`${SERVER}/media/${SHA}`, `${SERVER}/anything`),
    `${SERVER}/media/${SHA}`,
  );
});

test("an address on another host, port or scheme never gets the signed read", () => {
  for (const url of [
    `https://attacker.invalid/media/${SHA}.jpg`,
    `https://community.example:8443/media/${SHA}.jpg`,
    `http://community.example/media/${SHA}.jpg`,
    `http://127.0.0.1:1/media/${SHA}.jpg`,
    `https://community.example.attacker.invalid/media/${SHA}.jpg`,
    `https://community.example@attacker.invalid/media/${SHA}.jpg`,
  ])
    assert.equal(serverMediaUrl(url, SERVER), null, url);
});

test("a login in the address, another path, a path that climbs, or another kind of address is refused", () => {
  for (const url of [
    `https://user:pass@community.example/media/${SHA}.jpg`,
    `https://user@community.example/media/${SHA}.jpg`,
    `${SERVER}/media/../secret`,
    `${SERVER}/media/${SHA}/more`,
    `${SERVER}/media/short.jpg`,
    `${SERVER}/other/${SHA}.jpg`,
    `javascript:alert(1)`,
    `data:image/png;base64,AAAA`,
    "not an address",
    "",
  ])
    assert.equal(serverMediaUrl(url, SERVER), null, url);
  assert.equal(serverMediaUrl(null, SERVER), null);
  assert.equal(
    serverMediaUrl(`${SERVER}/media/${SHA}.jpg`, "not an origin"),
    null,
  );
});
