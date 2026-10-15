import assert from "node:assert/strict";
import test from "node:test";

import {
  codeHashOf,
  exchangeCheckNote,
  parseCodeHash,
  verifyExchange,
} from "./exchange-verify.ts";

const ADDR = {
  amm: "0x00000000000000000000000000000000000000a1",
  hook: "0x00000000000000000000000000000000000000a2",
  registry: "0x00000000000000000000000000000000000000a3",
  poolType: "0x00000000000000000000000000000000000000a4",
};
const CODE = {
  [ADDR.amm]: "0x6001",
  [ADDR.hook]: "0x6002",
  [ADDR.registry]: "0x6003",
  [ADDR.poolType]: "0x6004",
};
const pins = () => ({
  amm: codeHashOf("0x6001"),
  hook: codeHashOf("0x6002"),
  registry: codeHashOf("0x6003"),
  poolType: codeHashOf("0x6004"),
});

test("a code hash is keccak256 of the runtime bytes", () => {
  assert.equal(
    codeHashOf("0x"),
    "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
  );
  // As `cast keccak` gives them.
  assert.equal(
    codeHashOf("0x6001"),
    "0x309c67890bde4c575dc23d2cc3b5c3a3d599e312e980e9b61b5bc8f3cd87c8bb",
  );
  assert.notEqual(codeHashOf("0x6001"), codeHashOf("0x6002"));
  assert.equal(codeHashOf("6001"), codeHashOf("0x6001"));
});

test("a pin is 32 bytes of hex, lower-cased, or nothing", () => {
  const h = `0x${"AB".repeat(32)}`;
  assert.equal(parseCodeHash(h), h.toLowerCase());
  assert.equal(parseCodeHash("0x1234"), null);
  assert.equal(parseCodeHash(`0x${"zz".repeat(32)}`), null);
  assert.equal(parseCodeHash(5), null);
});

test("every contract matching its pin is verified", async () => {
  const check = await verifyExchange(ADDR, pins(), async (a) => CODE[a]);
  assert.equal(check.state, "verified");
  assert.equal(exchangeCheckNote(check), "");
});

test("one contract with different code is unverified, and named", async () => {
  const check = await verifyExchange(ADDR, pins(), async (a) =>
    a === ADDR.hook ? "0x60ff" : CODE[a],
  );
  assert.equal(check.state, "unverified");
  assert.deepEqual(check.mismatched, ["hook"]);
  assert.match(
    exchangeCheckNote(check),
    /not the ones this build was made to trust/,
  );
});

test("an address with no code is unverified, not skipped", async () => {
  const check = await verifyExchange(ADDR, pins(), async (a) =>
    a === ADDR.amm ? "0x" : CODE[a],
  );
  assert.equal(check.state, "unverified");
  assert.deepEqual(check.empty, ["amm"]);
});

test("a node that cannot answer is unreadable, never verified", async () => {
  const check = await verifyExchange(ADDR, pins(), async (a) => {
    if (a === ADDR.registry) throw new Error("rpc down");
    return CODE[a];
  });
  assert.equal(check.state, "unreadable");
  assert.match(exchangeCheckNote(check), /could not be asked/);
});

test("a pin for the wrong contract fails even when every contract has code", async () => {
  const swapped = { ...pins(), amm: codeHashOf("0x6002") };
  const check = await verifyExchange(ADDR, swapped, async (a) => CODE[a]);
  assert.equal(check.state, "unverified");
  assert.deepEqual(check.mismatched, ["amm"]);
});
