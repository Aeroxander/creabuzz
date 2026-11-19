// The ABI codec: calls by name and arity, calls read back, tuples, revert data and the errors of every contract.
// Run with: node --experimental-strip-types --test src/pot/abi-codec.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { encodeParameters, selectorOf } from "../launchpad/evmAbi.ts";
import {
  abiTypeOf,
  decodeCall,
  decodeReturn,
  decodeRevert,
  encodeCall,
  errorSignatures,
  functionOf,
  signatureOf,
} from "./abi-codec.ts";
import {
  LAUNCHER_ABI,
  PAIR_ABI,
  PLAY_DOLLAR_ABI,
  SHARE_TOKEN_ABI,
  TREASURY_ABI,
  VESTER_ABI,
} from "./abis.generated.ts";

const A = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const B = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";

test("a function is found by name, and by argument count when two share a name", () => {
  assert.equal(
    signatureOf(functionOf(PLAY_DOLLAR_ABI, "transferAndCall", 3)),
    "transferAndCall(address,uint256,bytes)",
  );
  assert.equal(
    signatureOf(functionOf(PLAY_DOLLAR_ABI, "transferAndCall", 2)),
    "transferAndCall(address,uint256)",
  );
  assert.throws(
    () => functionOf(PLAY_DOLLAR_ABI, "transferAndCall"),
    /More than one/,
  );
  assert.throws(() => functionOf(TREASURY_ABI, "doesNotExist"), /No function/);
});

test("a tuple is spelled out in the signature", () => {
  assert.equal(
    signatureOf(functionOf(LAUNCHER_ABI, "launch")),
    "launch(bytes32,string,string,(uint32,uint256),bytes32)",
  );
});

test("a call is encoded as cast encodes it, and read back", () => {
  // cast calldata "leave(uint256,uint256,address)" 2e18 1000000 <A>
  const data = encodeCall(TREASURY_ABI, "leave", [
    2n * 10n ** 18n,
    1_000_000n,
    A,
  ]);
  assert.equal(
    data,
    "0x8674b8670000000000000000000000000000000000000000000000001bc16d674ec8000000000000000000000000000000000000000000000000000000000000000f4240000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb92266",
  );
  const back = decodeCall(TREASURY_ABI, data);
  assert.equal(back.name, "leave");
  assert.deepEqual(back.args, [2n * 10n ** 18n, 1_000_000n, A]);
});

test("a call to a function the ABI does not have reads back as null", () => {
  assert.equal(decodeCall(TREASURY_ABI, "0x12345678"), null);
  assert.equal(decodeCall(TREASURY_ABI, "not hex"), null);
  assert.equal(decodeCall(TREASURY_ABI, "0x1234"), null);
});

test("a tuple answer is read back by position", () => {
  const fn = functionOf(VESTER_ABI, "grantOf");
  const types = fn.outputs.map(abiTypeOf);
  const answer = encodeParameters(types, [[A, false, 0n, 0n, 5n, 1n, 2n, 0n]]);
  const [grant] = decodeReturn(VESTER_ABI, "grantOf", answer);
  assert.deepEqual(grant, [A, false, 0n, 0n, 5n, 1n, 2n, 0n]);
});

test("a too-short answer throws instead of inventing numbers", () => {
  assert.throws(() =>
    decodeReturn(TREASURY_ABI, "quoteBack", `0x${"00".repeat(64)}`),
  );
  assert.throws(() => decodeReturn(TREASURY_ABI, "quoteBack", "0x"));
});

test("every error of every contract is read back from its own revert data", () => {
  let walked = 0;
  for (const abi of [
    TREASURY_ABI,
    VESTER_ABI,
    LAUNCHER_ABI,
    PAIR_ABI,
    SHARE_TOKEN_ABI,
    PLAY_DOLLAR_ABI,
  ]) {
    for (const item of abi.filter((i) => i.type === "error")) {
      const args = (item.inputs ?? []).map((i) =>
        i.type === "address" ? A : 7n,
      );
      const data =
        selectorOf(signatureOf(item)) +
        encodeParameters(item.inputs.map(abiTypeOf), args).slice(2);
      const found = decodeRevert(
        [
          TREASURY_ABI,
          VESTER_ABI,
          LAUNCHER_ABI,
          PAIR_ABI,
          SHARE_TOKEN_ABI,
          PLAY_DOLLAR_ABI,
        ],
        data,
      );
      assert.equal(found?.name, item.name, signatureOf(item));
      walked += 1;
    }
  }
  assert.ok(walked > 40, `walked ${walked} errors`);
});

test("revert data that is no custom error of ours reads back as null", () => {
  assert.equal(decodeRevert([TREASURY_ABI], "0x08c379a0"), null); // Error(string) selector
  assert.equal(decodeRevert([TREASURY_ABI], undefined), null);
  assert.equal(decodeRevert([TREASURY_ABI], "0x"), null);
  assert.equal(decodeRevert([TREASURY_ABI], { data: "0x" }), null);
});

test("the error lists name what the contracts say", () => {
  assert.ok(errorSignatures(TREASURY_ABI).includes("DoorShut()"));
  assert.ok(
    errorSignatures(TREASURY_ABI).includes("TooLittleCash(uint256,uint256)"),
  );
  assert.ok(errorSignatures(VESTER_ABI).includes("NothingToClaim()"));
  assert.ok(B);
});

test("a type the shared encoder cannot carry is refused loudly", () => {
  assert.throws(() => abiTypeOf({ type: "bytes4" }));
  assert.throws(() => abiTypeOf({ type: "uint256[3]" }));
  assert.deepEqual(abiTypeOf({ type: "uint256[]" }), { array: "uint256" });
});
