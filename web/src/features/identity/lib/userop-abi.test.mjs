/**
 * ABI encoder/decoder golden tests.
 *
 * Vectors derived with Foundry `cast` 1.4.3 (commands recorded inline); any
 * encoder drift must fail these exact bytes. Tuple-array vectors cover the
 * head/tail offset rules for `Install[]` and `PackedUserOperation[]`.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  abiEncode,
  abiEncodeCall,
  decodeAddressError,
  decodeAddressWord,
  functionSelector,
} from "./userop-abi.ts";

test("functionSelector matches cast sig for every wired call", () => {
  // $ cast sig "handleOps(((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes))[],address)"
  assert.equal(
    functionSelector(
      "handleOps(((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes))[],address)",
    ),
    "0x449fd934",
  );
  // $ cast sig "getSenderAddress(bytes)"
  assert.equal(functionSelector("getSenderAddress(bytes)"), "0x9b249f69");
  // $ cast sig "SenderAddressResult(address)"
  assert.equal(functionSelector("SenderAddressResult(address)"), "0x6ca7b806");
  // $ cast sig "deploy((uint256,address,bytes,bytes)[],uint256)"
  assert.equal(
    functionSelector("deploy((uint256,address,bytes,bytes)[],uint256)"),
    "0x0609747b",
  );
  // $ cast sig "getAddress((uint256,address,bytes,bytes)[],uint256)"
  assert.equal(
    functionSelector("getAddress((uint256,address,bytes,bytes)[],uint256)"),
    "0x0e027ecd",
  );
  // $ cast sig "execute(bytes32,bytes)"
  assert.equal(functionSelector("execute(bytes32,bytes)"), "0xe9ae5c53");
  // $ cast sig "onInstall(bytes)"
  assert.equal(functionSelector("onInstall(bytes)"), "0x6d61fe70");
});

test("deploy calldata matches cast calldata (tuple[] with dynamic members)", () => {
  // $ cast calldata "deploy((uint256,address,bytes,bytes)[],uint256)" \
  //     "[(1,0x4444444444444444444444444444444444444444,0xaabb,0x)]" 5
  const expected =
    "0x0609747b" +
    "0000000000000000000000000000000000000000000000000000000000000040" +
    "0000000000000000000000000000000000000000000000000000000000000005" +
    "0000000000000000000000000000000000000000000000000000000000000001" +
    "0000000000000000000000000000000000000000000000000000000000000020" +
    "0000000000000000000000000000000000000000000000000000000000000001" +
    "0000000000000000000000004444444444444444444444444444444444444444" +
    "0000000000000000000000000000000000000000000000000000000000000080" +
    "00000000000000000000000000000000000000000000000000000000000000c0" +
    "0000000000000000000000000000000000000000000000000000000000000002" +
    "aabb000000000000000000000000000000000000000000000000000000000000" +
    "0000000000000000000000000000000000000000000000000000000000000000";
  const actual = abiEncodeCall(
    "deploy((uint256,address,bytes,bytes)[],uint256)",
    [
      {
        kind: "tuple[]",
        items: [
          [
            { kind: "uint", value: 1n },
            {
              kind: "address",
              value: "0x4444444444444444444444444444444444444444",
            },
            { kind: "bytes", value: "0xaabb" },
            { kind: "bytes", value: "0x" },
          ],
        ],
      },
      { kind: "uint", value: 5n },
    ],
  );
  assert.equal(actual, expected);
});

test("two tuple[] elements place offsets past both tuple bodies", () => {
  // $ cast calldata "deploy((uint256,address,bytes,bytes)[],uint256)" \
  //     "[(1,0x4444444444444444444444444444444444444444,0xaabb,0x),(2,0x4444444444444444444444444444444444444444,0xccdd,0x)]" 5
  const expected =
    "0x0609747b" +
    "0000000000000000000000000000000000000000000000000000000000000040" +
    "0000000000000000000000000000000000000000000000000000000000000005" +
    "0000000000000000000000000000000000000000000000000000000000000002" +
    "0000000000000000000000000000000000000000000000000000000000000040" +
    "0000000000000000000000000000000000000000000000000000000000000120" +
    "0000000000000000000000000000000000000000000000000000000000000001" +
    "0000000000000000000000004444444444444444444444444444444444444444" +
    "0000000000000000000000000000000000000000000000000000000000000080" +
    "00000000000000000000000000000000000000000000000000000000000000c0" +
    "0000000000000000000000000000000000000000000000000000000000000002" +
    "aabb000000000000000000000000000000000000000000000000000000000000" +
    "0000000000000000000000000000000000000000000000000000000000000000" +
    "0000000000000000000000000000000000000000000000000000000000000002" +
    "0000000000000000000000004444444444444444444444444444444444444444" +
    "0000000000000000000000000000000000000000000000000000000000000080" +
    "00000000000000000000000000000000000000000000000000000000000000c0" +
    "0000000000000000000000000000000000000000000000000000000000000002" +
    "ccdd000000000000000000000000000000000000000000000000000000000000" +
    "0000000000000000000000000000000000000000000000000000000000000000";
  const actual = abiEncodeCall(
    "deploy((uint256,address,bytes,bytes)[],uint256)",
    [
      {
        kind: "tuple[]",
        items: [
          [
            { kind: "uint", value: 1n },
            {
              kind: "address",
              value: "0x4444444444444444444444444444444444444444",
            },
            { kind: "bytes", value: "0xaabb" },
            { kind: "bytes", value: "0x" },
          ],
          [
            { kind: "uint", value: 2n },
            {
              kind: "address",
              value: "0x4444444444444444444444444444444444444444",
            },
            { kind: "bytes", value: "0xccdd" },
            { kind: "bytes", value: "0x" },
          ],
        ],
      },
      { kind: "uint", value: 5n },
    ],
  );
  assert.equal(actual, expected);
});

test("WebAuthnAuth tuple matches cast abi-encode (bytes,string,uint256,uint256,bytes32,bytes32)", () => {
  // $ cast abi-encode "f(bytes,string,uint256,uint256,bytes32,bytes32)" \
  //     0x1234 "hello" 3 4 \
  //     0x0000000000000000000000000000000000000000000000000000000000000005 \
  //     0x0000000000000000000000000000000000000000000000000000000000000006
  const expected =
    "0x00000000000000000000000000000000000000000000000000000000000000c0" +
    "0000000000000000000000000000000000000000000000000000000000000100" +
    "0000000000000000000000000000000000000000000000000000000000000003" +
    "0000000000000000000000000000000000000000000000000000000000000004" +
    "0000000000000000000000000000000000000000000000000000000000000005" +
    "0000000000000000000000000000000000000000000000000000000000000006" +
    "0000000000000000000000000000000000000000000000000000000000000002" +
    "1234000000000000000000000000000000000000000000000000000000000000" +
    "0000000000000000000000000000000000000000000000000000000000000005" +
    "68656c6c6f000000000000000000000000000000000000000000000000000000";
  assert.equal(
    abiEncode([
      { kind: "bytes", value: "0x1234" },
      { kind: "string", value: "hello" },
      { kind: "uint", value: 3n },
      { kind: "uint", value: 4n },
      { kind: "bytes32", value: `0x${"00".repeat(31)}05` },
      { kind: "bytes32", value: `0x${"00".repeat(31)}06` },
    ]),
    expected,
  );
});

test("decodeAddressWord decodes clean words and rejects dirty prefixes", () => {
  assert.equal(
    decodeAddressWord(
      `0x${"00".repeat(12)}2222222222222222222222222222222222222222`,
    ),
    "0x2222222222222222222222222222222222222222",
  );
  assert.throws(() => decodeAddressWord("0x1234"), /too short/);
  assert.throws(
    () =>
      decodeAddressWord(
        `0x${"00".repeat(11)}012222222222222222222222222222222222222222`,
      ),
    /non-zero 12-byte prefix/,
  );
});

test("decodeAddressError parses SenderAddressResult and rejects other selectors", () => {
  const payload =
    "0x6ca7b806" + `000000000000000000000000${"22".repeat(20)}`.slice(0, 64);
  assert.equal(
    decodeAddressError(payload, "SenderAddressResult(address)"),
    `0x${"22".repeat(20)}`,
  );
  assert.equal(
    decodeAddressError("0xdeadbeef", "SenderAddressResult(address)"),
    null,
  );
  assert.equal(decodeAddressError("0x", "SenderAddressResult(address)"), null);
  assert.throws(
    () =>
      decodeAddressError(
        `0x6ca7b806${"00".repeat(31)}`,
        "SenderAddressResult(address)",
      ),
    /payload must be one word/,
  );
});

test("encoder rejects malformed inputs loudly", () => {
  assert.throws(
    () => abiEncode([{ kind: "address", value: "0x1234" }]),
    /address must be 20 bytes/,
  );
  assert.throws(
    () => abiEncode([{ kind: "bytes32", value: "0x1234" }]),
    /exactly 32 bytes/,
  );
  assert.throws(
    () => abiEncode([{ kind: "bytes4", value: "0x123456" }]),
    /exactly 4 bytes/,
  );
  assert.throws(
    () => abiEncode([{ kind: "uint", value: -1n }]),
    /out of range/,
  );
  assert.throws(
    () => abiEncode([{ kind: "uint", value: 1n << 256n }]),
    /out of range/,
  );
  assert.throws(
    () => abiEncode([{ kind: "bytes", value: "0x123" }]),
    /even number/,
  );
});
