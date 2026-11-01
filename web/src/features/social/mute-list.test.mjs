import assert from "node:assert/strict";
import test from "node:test";
import * as nip44 from "nostr-tools/nip44";
import { getPublicKey } from "nostr-tools/pure";

import { mutedInState, nextMuteList, readMuteState } from "./mute-list.ts";

// The same encryption the app uses for a list kept to yourself: NIP-44 with your own key as the peer.
const SECRET = Uint8Array.from(Buffer.from("4".repeat(64), "hex"));
const ME = getPublicKey(SECRET);
const KEY = nip44.v2.utils.getConversationKey(SECRET, ME);
const encrypt = async (plain) => nip44.v2.encrypt(plain, KEY);
const decrypt = async (cipher) => nip44.v2.decrypt(cipher, KEY);

const BOB = "b".repeat(64);
const CAROL = "c".repeat(64);

function list(tags, content = "") {
  return {
    id: "f".repeat(64),
    pubkey: ME,
    kind: 10000,
    created_at: 100,
    tags,
    content,
  };
}

test("a new mute is private: no public tag names the person", async () => {
  const state = await readMuteState(null, decrypt);
  const next = await nextMuteList(state, CAROL, true, encrypt);
  assert.equal(next.kind, 10000);
  assert.deepEqual(
    next.tags.filter((t) => t[0] === "p"),
    [],
    "the muted person must not be able to read their name on the list",
  );
  assert.deepEqual(JSON.parse(await decrypt(next.content)), [["p", CAROL]]);
  const reread = await readMuteState(list(next.tags, next.content), decrypt);
  assert.deepEqual([...mutedInState(reread)], [CAROL]);
});

test("old public mutes still count, and move into the private part on the next change", async () => {
  const old = await readMuteState(
    list([
      ["p", BOB],
      ["t", "spoilers"],
    ]),
    decrypt,
  );
  assert.deepEqual([...mutedInState(old)], [BOB]);
  const next = await nextMuteList(old, CAROL, true, encrypt);
  assert.deepEqual(next.tags, [["t", "spoilers"]]);
  assert.deepEqual(JSON.parse(await decrypt(next.content)), [
    ["p", BOB],
    ["p", CAROL],
  ]);
  assert.ok(next.created_at > 100, "a replacement is newer than the list");
});

test("unmuting removes the person from both parts", async () => {
  const content = await encrypt(JSON.stringify([["p", CAROL]]));
  const state = await readMuteState(list([["p", BOB]], content), decrypt);
  assert.deepEqual([...mutedInState(state)].sort(), [BOB, CAROL]);
  const withoutBob = await nextMuteList(state, BOB, false, encrypt);
  assert.deepEqual(withoutBob.tags, []);
  assert.deepEqual(JSON.parse(await decrypt(withoutBob.content)), [
    ["p", CAROL],
  ]);
  const empty = await nextMuteList(
    await readMuteState(list([], withoutBob.content), decrypt),
    CAROL,
    false,
    encrypt,
  );
  assert.equal(empty.content, "");
});

test("a private part this app cannot read is shown but never overwritten", async () => {
  const state = await readMuteState(list([["p", BOB]], "not-nip44"), decrypt);
  assert.equal(state.readable, false);
  assert.deepEqual([...mutedInState(state)], [BOB]);
  await assert.rejects(
    () => nextMuteList(state, CAROL, true, encrypt),
    /another app/,
  );
});

test("a list from another app in an older form (NIP-04) is shown but never overwritten", async () => {
  const state = await readMuteState(
    list([["p", BOB]], "c2VjcmV0?iv=aXZpdml2aXZpdml2"),
    async () => {
      throw new Error("decrypt must not be asked for a form it cannot open");
    },
  );
  assert.equal(state.readable, false);
  assert.deepEqual([...mutedInState(state)], [BOB]);
});

test("a decrypt that fails (signer refused, no key) rejects instead of reading as nobody muted", async () => {
  const content = await encrypt(JSON.stringify([["p", CAROL]]));
  await assert.rejects(
    () =>
      readMuteState(list([["p", BOB]], content), async () => {
        throw new Error("User rejected the request");
      }),
    /User rejected/,
  );
});

test("a private part that opens but is not a tag list is shown but never overwritten", async () => {
  const content = await encrypt(JSON.stringify({ not: "tags" }));
  const state = await readMuteState(list([["p", BOB]], content), decrypt);
  assert.equal(state.readable, false);
  assert.deepEqual([...mutedInState(state)], [BOB]);
  await assert.rejects(
    () => nextMuteList(state, CAROL, true, encrypt),
    /that app instead/,
  );
});
