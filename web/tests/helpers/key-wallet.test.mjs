import assert from "node:assert/strict";
import test from "node:test";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

import {
  newWalletAttestation,
  recoverWallet,
  walletAttestationDigest,
  walletTypedData,
} from "../../src/features/identity/lib/wallet-proof.ts";
import {
  addressOf,
  encodeType,
  hashStruct,
  newKeyWallet,
  personalSign,
  rlp,
  signTypedData,
  typedDataDigest,
  walletFromKey,
} from "./key-wallet.ts";

// Public Anvil development key (account 0): not a person's.
const ANVIL0 =
  "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ANVIL0_ADDRESS = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";

test("an address is derived from a key the way Ethereum does", () => {
  assert.equal(walletFromKey(ANVIL0).address, ANVIL0_ADDRESS);
  const fresh = newKeyWallet();
  assert.match(fresh.address, /^0x[0-9a-f]{40}$/);
  assert.notEqual(fresh.address, newKeyWallet().address, "every wallet is new");
  assert.equal(addressOf(fresh.privateKey), fresh.address);
});

test("personal_sign is an EIP-191 signature that recovers to the signer", () => {
  const wallet = newKeyWallet();
  const text = "localhost wants you to sign in with your Ethereum account";
  const signature = personalSign(wallet.privateKey, text);
  const bytes = utf8ToBytes(text);
  const digest = keccak_256(
    new Uint8Array([
      ...utf8ToBytes(`\x19Ethereum Signed Message:\n${bytes.length}`),
      ...bytes,
    ]),
  );
  assert.equal(recoverWallet(digest, signature), wallet.address);
  // 0x hex is signed as bytes, text as text.
  const asBytes = personalSign(wallet.privateKey, `0x${bytesToHex(bytes)}`);
  assert.equal(asBytes, signature);
});

// The EIP-712 reference example ("Ether Mail"), whose digest and signature are published with the standard.
const MAIL = {
  types: {
    EIP712Domain: [
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ],
    Person: [
      { name: "name", type: "string" },
      { name: "wallet", type: "address" },
    ],
    Mail: [
      { name: "from", type: "Person" },
      { name: "to", type: "Person" },
      { name: "contents", type: "string" },
    ],
  },
  primaryType: "Mail",
  domain: {
    name: "Ether Mail",
    version: "1",
    chainId: 1,
    verifyingContract: "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC",
  },
  message: {
    from: { name: "Cow", wallet: "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826" },
    to: { name: "Bob", wallet: "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB" },
    contents: "Hello, Bob!",
  },
};

test("typed data hashes to the EIP-712 reference vectors, nested structs included", () => {
  assert.equal(
    encodeType("Mail", MAIL.types),
    "Mail(Person from,Person to,string contents)Person(string name,address wallet)",
  );
  assert.equal(
    bytesToHex(hashStruct("EIP712Domain", MAIL.domain, MAIL.types)),
    "f2cee375fa42b42143804025fc449deafd50cc031ca257e0b194a650a912090f",
  );
  assert.equal(
    bytesToHex(hashStruct("Mail", MAIL.message, MAIL.types)),
    "c52c0ee5d84264471806290a3f2c4cecfc5490626bf912d01f240d7a274b371e",
  );
  assert.equal(
    bytesToHex(typedDataDigest(MAIL)),
    "be609aee343fb3c4b28e1df9e632fca64fcfaede20f02e86244efddf30957bd2",
  );
});

test("the reference signature is reproduced exactly (signing is deterministic)", () => {
  const cow = keccak_256(utf8ToBytes("cow"));
  assert.equal(addressOf(cow), "0xcd2a3d9f938e13cd947ec05abc7fe734df8dd826");
  assert.equal(
    signTypedData(cow, MAIL),
    "0x4355c47d63924e8a72e509b65029052eb6c299d53a04e167c5775fd466751c9d07299936d304c153f6443dfa05f40ff007d72911b6f72307f996231605b915621c",
  );
});

test("the app's own wallet-link typed data is signed so that it recovers to the wallet, by an independent check", () => {
  const wallet = newKeyWallet();
  const attestation = newWalletAttestation(
    wallet.address,
    "2a".repeat(32),
    31337,
    1_800_000_000,
    5,
  );
  const signature = signTypedData(
    wallet.privateKey,
    walletTypedData(attestation),
  );
  // The app computes this digest its own way (and it is pinned to a Foundry vector in wallet-proof.test.mjs).
  assert.equal(
    recoverWallet(walletAttestationDigest(attestation), signature),
    wallet.address,
  );
});

test("RLP encodes the way the yellow paper does", () => {
  const enc = (item) => bytesToHex(rlp(item));
  assert.equal(enc(new Uint8Array()), "80");
  assert.equal(enc(hexToBytes("0f")), "0f");
  assert.equal(enc(hexToBytes("0400")), "820400");
  assert.equal(enc([]), "c0");
  assert.equal(enc([hexToBytes("00"), []]), "c200c0");
  // A string of 56 bytes takes a length of its own.
  assert.equal(enc(new Uint8Array(56).fill(0x61)).slice(0, 4), "b838");
  // The yellow-paper example: ["cat", "dog"].
  assert.equal(
    enc([utf8ToBytes("cat"), utf8ToBytes("dog")]),
    "c88363617483646f67",
  );
});
