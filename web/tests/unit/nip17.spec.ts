import { expect, test } from "@playwright/test";
import {
  finalizeEvent,
  generateSecretKey,
  getEventHash,
  getPublicKey,
} from "nostr-tools/pure";
import * as nip44 from "nostr-tools/nip44";
import { createWrap } from "nostr-tools/nip59";

import type { DirectMessageSigner } from "../../src/shared/lib/nostr-signer";
import {
  type DirectMessage,
  createDirectMessageWraps,
  groupConversations,
  openGiftWrap,
} from "../../src/features/messages/nip17";

/** A signer backed by a raw secret key, standing in for a passkey/NIP-07 signer. */
function signerFor(sk: Uint8Array): DirectMessageSigner {
  return {
    pubkey: getPublicKey(sk),
    signEvent: async (template) =>
      finalizeEvent(
        {
          ...template,
          created_at: template.created_at ?? Math.floor(Date.now() / 1000),
        },
        sk,
      ),
    nip44Encrypt: async (peer, text) =>
      nip44.encrypt(text, nip44.getConversationKey(sk, peer)),
    nip44Decrypt: async (peer, text) =>
      nip44.decrypt(text, nip44.getConversationKey(sk, peer)),
  };
}

const alice = signerFor(generateSecretKey());
const bob = signerFor(generateSecretKey());
const mallory = signerFor(generateSecretKey());

test("recipient and sender can each open their own wrap", async () => {
  const { toRecipient, toSelf } = await createDirectMessageWraps(
    alice,
    bob.pubkey,
    "hello bob",
  );

  const received = await openGiftWrap(bob, toRecipient);
  expect(received).toMatchObject({
    from: alice.pubkey,
    peer: alice.pubkey,
    content: "hello bob",
  });

  const sent = await openGiftWrap(alice, toSelf);
  expect(sent).toMatchObject({
    from: alice.pubkey,
    peer: bob.pubkey,
    content: "hello bob",
  });
  expect(sent?.id).toBe(received?.id);
});

test("wraps hide the sender and are addressed with a p tag", async () => {
  const { toRecipient } = await createDirectMessageWraps(
    alice,
    bob.pubkey,
    "x",
  );
  expect(toRecipient.kind).toBe(1059);
  expect(toRecipient.pubkey).not.toBe(alice.pubkey);
  expect(toRecipient.tags).toEqual([["p", bob.pubkey]]);
  expect(toRecipient.content).not.toContain('x"');
});

test("a third party cannot open someone else's wrap", async () => {
  const { toRecipient } = await createDirectMessageWraps(
    alice,
    bob.pubkey,
    "secret",
  );
  expect(await openGiftWrap(mallory, toRecipient)).toBeNull();
});

test("a rumor claiming another sender than the seal signer is rejected", async () => {
  // Mallory signs the seal but the inner rumor says it is from Alice.
  const rumor = {
    kind: 14,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["p", bob.pubkey]],
    content: "send me money",
    pubkey: alice.pubkey,
  };
  const forged = { ...rumor, id: getEventHash(rumor) };
  const seal = await mallory.signEvent({
    kind: 13,
    tags: [],
    content: await mallory.nip44Encrypt(bob.pubkey, JSON.stringify(forged)),
  });
  expect(await openGiftWrap(bob, createWrap(seal, bob.pubkey))).toBeNull();
});

test("group DMs (more than one other participant) are skipped", async () => {
  const rumor = {
    kind: 14,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["p", bob.pubkey],
      ["p", mallory.pubkey],
    ],
    content: "group",
    pubkey: alice.pubkey,
  };
  const seal = await alice.signEvent({
    kind: 13,
    tags: [],
    content: await alice.nip44Encrypt(
      bob.pubkey,
      JSON.stringify({ ...rumor, id: getEventHash(rumor) }),
    ),
  });
  expect(await openGiftWrap(bob, createWrap(seal, bob.pubkey))).toBeNull();
});

test("conversations de-duplicate by rumor id and sort newest first", () => {
  const m = (id: string, peer: string, at: number): DirectMessage => ({
    id,
    wrapId: `w-${id}-${at}`,
    from: peer,
    peer,
    content: id,
    at,
  });
  const groups = groupConversations([
    m("1", "bob", 10),
    m("1", "bob", 10), // same rumor delivered twice (recipient + self wrap)
    m("2", "bob", 30),
    m("3", "carol", 40),
    m("4", "carol", 20),
  ]);
  expect(groups.map((g) => g.peer)).toEqual(["carol", "bob"]);
  expect(groups[0].messages.map((x) => x.id)).toEqual(["4", "3"]);
  expect(groups[1].messages.map((x) => x.id)).toEqual(["1", "2"]);
  expect(groups[1].last.id).toBe("2");
});
