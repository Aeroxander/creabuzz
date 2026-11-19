import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CLAIM_READS,
  cancelHolderData,
  claimFragment,
  consentData,
  consentDigest,
  consentTypedData,
  deliverData,
  fingerprintOf,
  leafOf,
  parseClaimFragment,
  parseEntry,
} from "./earlier-claim.ts";

// Made-up values; every expected string below was produced with `cast` (keccak, abi-encode, calldata).
const HOLDER = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const OTHER = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc";
const SALT = `0x${"11".repeat(32)}`;
const TEXT = `0x${"22".repeat(32)}`;
const FIVE = 5_000_000_000_000_000_000n;

test("a leaf is the keccak of the entry, holder, amount and salt", () => {
  assert.equal(
    leafOf(2n, HOLDER, FIVE, SALT),
    "0xbe6febbd0c91cdb63eba009226b4092ddb99e8f89afe87abfa331a0e64300d67",
  );
});

test("a fingerprint is the keccak of the UTF-8 text", () => {
  assert.equal(
    fingerprintOf("hello"),
    "0x1c8aff950685c2ed4bc3174f3472287b56d9517b9c948127319a09a7a36deac8",
  );
});

test("consent in person and with a signature match cast calldata", () => {
  assert.equal(
    consentData({
      entry: 2n,
      holder: HOLDER,
      amount: FIVE,
      salt: SALT,
      receiver: OTHER,
      textHash: TEXT,
      validUntil: 1_900_000_000n,
    }),
    "0x1409685f000000000000000000000000000000000000000000000000000000000000000200000000000000000000000070997970c51812dc3a010c7d01b50e0d17dc79c80000000000000000000000000000000000000000000000004563918244f4000011111111111111111111111111111111111111111111111111111111111111110000000000000000000000003c44cdddb6a900fa2b585dd299e03d12fa4293bc222222222222222222222222222222222222222222222222222222222222222200000000000000000000000000000000000000000000000000000000713fb30000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000000",
  );
  assert.equal(
    consentData({
      entry: 2n,
      holder: HOLDER,
      amount: FIVE,
      salt: SALT,
      receiver: HOLDER,
      textHash: TEXT,
      validUntil: 1_900_000_000n,
      signature: "0xaabbcc",
    }),
    "0x1409685f000000000000000000000000000000000000000000000000000000000000000200000000000000000000000070997970c51812dc3a010c7d01b50e0d17dc79c80000000000000000000000000000000000000000000000004563918244f40000111111111111111111111111111111111111111111111111111111111111111100000000000000000000000070997970c51812dc3a010c7d01b50e0d17dc79c8222222222222222222222222222222222222222222222222222222222222222200000000000000000000000000000000000000000000000000000000713fb30000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000003aabbcc0000000000000000000000000000000000000000000000000000000000",
  );
});

test("cancel and deliver match cast calldata", () => {
  assert.equal(
    cancelHolderData(2n, FIVE, SALT),
    "0x6fba390500000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000004563918244f400001111111111111111111111111111111111111111111111111111111111111111",
  );
  assert.equal(
    deliverData(2n),
    "0x3bd5d1730000000000000000000000000000000000000000000000000000000000000002",
  );
});

test("the typed data names the contract's domain and every field of the message", () => {
  const m = {
    entry: 2n,
    holder: HOLDER,
    amount: FIVE,
    receiver: HOLDER,
    project: TEXT,
    textHash: TEXT,
    textVersion: 1n,
    summary: "A one-line summary.",
    holderVersion: 0n,
    validUntil: 1_900_000_000n,
  };
  const typed = consentTypedData(31337, OTHER, m);
  assert.equal(typed.primaryType, "Consent");
  assert.equal(typed.domain.name, "Creaton earlier backers");
  assert.equal(typed.domain.version, "1");
  assert.equal(typed.domain.chainId, "31337");
  assert.deepEqual(
    typed.types.Consent.map((f) => f.name),
    Object.keys(typed.message),
  );
  // The digest depends on the chain and the contract: the same message elsewhere is not the same signature.
  assert.notEqual(consentDigest(31337, OTHER, m), consentDigest(1, OTHER, m));
  assert.notEqual(
    consentDigest(31337, OTHER, m),
    consentDigest(31337, HOLDER, m),
  );
});

test("the read for one entry carries that entry's index and no other", () => {
  assert.equal(
    CLAIM_READS.entryOf(3n),
    `0x${CLAIM_READS.entryOf(3n).slice(2, 10)}${"0".repeat(63)}3`,
  );
  assert.equal(CLAIM_READS.due(3n).slice(-64), `${"0".repeat(63)}3`);
});

test("an entry is read from its eleven words; zero addresses are none", () => {
  const word = (n) => n.toString(16).padStart(64, "0");
  const data = `0x${[
    word(0n),
    word(1n),
    word(1_700_000_000n),
    HOLDER.slice(2).padStart(64, "0"),
    word(0n),
    word(0n),
    word(0n),
    word(0n),
    OTHER.slice(2).padStart(64, "0"),
    word(FIVE),
    word(0n),
  ].join("")}`;
  const e = parseEntry(data);
  assert.equal(e.holder, null);
  assert.equal(e.signer, HOLDER);
  assert.equal(e.receiver, OTHER);
  assert.equal(e.consentAt, 1_700_000_000n);
  assert.equal(e.amount, FIVE);
  assert.equal(e.pending, null);
  assert.throws(() => parseEntry("0x1234"));
});

test("a link's fragment round-trips; anything half-written is none", () => {
  const link = { entry: 2n, holder: HOLDER, amount: FIVE, salt: SALT };
  assert.deepEqual(parseClaimFragment(claimFragment(link)), link);
  assert.equal(parseClaimFragment(""), null);
  assert.equal(
    parseClaimFragment("#entry=2&holder=0x12&amount=5&salt=0x1"),
    null,
  );
  assert.equal(
    parseClaimFragment(`#entry=2&holder=${HOLDER}&amount=0&salt=${SALT}`),
    null,
  );
  assert.equal(
    parseClaimFragment(`#entry=-1&holder=${HOLDER}&amount=5&salt=${SALT}`),
    null,
  );
});
