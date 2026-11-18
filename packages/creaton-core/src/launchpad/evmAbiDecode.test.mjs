import assert from "node:assert/strict";
import { test } from "node:test";

import { decodeParameters, encodeParameters } from "./evmAbi.ts";

const ADDRESS = "0x00000000000000000000000000000000000000aa";
const WORD = `0x${"22".repeat(32)}`;

test("signed integers encode as two's complement, exactly as cast does", () => {
  // cast abi-encode "f(int24,int128,int256)" -200 7 -1
  assert.equal(
    encodeParameters(["int24", "int128", "int256"], [-200n, 7n, -1n]),
    "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff380000000000000000000000000000000000000000000000000000000000000007ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
  );
  assert.throws(() => encodeParameters(["int8"], [128n]), /out of range/);
  assert.throws(() => encodeParameters(["int8"], [-129n]), /out of range/);
  assert.equal(
    encodeParameters(["int8"], [-128n]),
    "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff80",
  );
});

test("what the encoder writes, the decoder reads back, including tuples inside arrays", () => {
  const types = [
    "address",
    { array: { tuple: ["uint256", "bytes"] } },
    "bytes32",
    "string",
  ];
  const values = [
    ADDRESS,
    [
      [5n, "0x1234"],
      [6n, "0x"],
    ],
    WORD,
    "hello",
  ];
  // cast abi-encode "f(address,(uint256,bytes)[],bytes32,string)" 0x…aa "[(5,0x1234),(6,0x)]" 0x2222… "hello"
  const encoded = encodeParameters(types, values);
  assert.equal(
    encoded,
    "0x00000000000000000000000000000000000000000000000000000000000000aa0000000000000000000000000000000000000000000000000000000000000080222222222222222222222222222222222222222222222222222222222222222200000000000000000000000000000000000000000000000000000000000001c00000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000c00000000000000000000000000000000000000000000000000000000000000005000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000021234000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000568656c6c6f000000000000000000000000000000000000000000000000000000",
  );
  assert.deepEqual(decodeParameters(types, encoded), values);
});

test("signed values decode back negative", () => {
  const encoded = encodeParameters(["int24", "int128"], [-200n, -7n]);
  assert.deepEqual(decodeParameters(["int24", "int128"], encoded), [
    -200n,
    -7n,
  ]);
});

test("data that does not hold what is asked is refused, never filled in", () => {
  assert.throws(
    () => decodeParameters(["uint256", "uint256"], "0x00"),
    /ends before/,
  );
  // An offset that points past the data.
  const pointsOut = `0x${"0".repeat(63)}${"f"}${"0".repeat(64)}`;
  assert.throws(() => decodeParameters(["bytes"], pointsOut));
  // A value too wide for its type: 256 does not fit a uint8.
  assert.throws(
    () => decodeParameters(["uint8"], `0x${"0".repeat(61)}100`),
    /out of range/,
  );
  // A hostile array length.
  const huge = encodeParameters(["uint256", "uint256"], [32n, 1_000_000n]);
  assert.throws(
    () => decodeParameters([{ array: "uint256" }], huge),
    /longer than/,
  );
});
