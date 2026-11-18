import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chainKeyFromTags,
  chainKeyOf,
  numbersBelongTo,
  withChainKey,
  projectIdOf,
} from "./project-chain.ts";

// The day-45 record of milestone 5's real loop: anvil's second account launched it.
const FOUNDER = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const M5_PROJECT_ID =
  "0x5c186cdb2fc8a83f07601478d83a41afffaef603bbff5494414b6fd2cbfa481d";
const M5_KEY =
  "0x23ae9e81940f353d5fc623414c6b2604fdffc87ac3d53e7f45aa2fbef7804db3";

test("the chain key is the contracts' keyOf (milestone 5's record)", () => {
  assert.equal(chainKeyOf(FOUNDER, M5_PROJECT_ID), M5_KEY);
  assert.equal(
    chainKeyOf(FOUNDER.toUpperCase().replace("0X", "0x"), M5_PROJECT_ID),
    M5_KEY,
  );
});

test("the id on the chain is the hash of the record's address", () => {
  // keccak256("") is the well-known empty hash; a real address hashes to 32 bytes of hex.
  assert.equal(
    projectIdOf(""),
    "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
  );
  assert.match(projectIdOf(`37001:${"a".repeat(64)}:demo`), /^0x[0-9a-f]{64}$/);
});

test("a record's chain key tag is read in lower case; a malformed one is none", () => {
  assert.equal(
    chainKeyFromTags([["chain-key", M5_KEY.toUpperCase().replace("0X", "0x")]]),
    M5_KEY,
  );
  assert.equal(chainKeyFromTags([["chain-key", "0x12"]]), null);
  assert.equal(chainKeyFromTags([["d", "x"]]), null);
});

test("numbers belong to a project only when key, founder, id and record all agree", () => {
  const coordinate = `37001:${"b".repeat(64)}:demo`;
  const projectId = projectIdOf(coordinate);
  const key = chainKeyOf(FOUNDER, projectId);
  const good = {
    d: key,
    founder: FOUNDER,
    projectId,
    chainKey: key,
    coordinate,
  };
  assert.equal(numbersBelongTo(good), true);
  // Someone else's record pointing at this launch.
  assert.equal(
    numbersBelongTo({ ...good, coordinate: `37001:${"c".repeat(64)}:demo` }),
    false,
  );
  // A launch made for this record by another wallet, while the record names this one.
  const other = chainKeyOf(
    "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc",
    projectId,
  );
  assert.equal(
    numbersBelongTo({
      ...good,
      d: other,
      founder: "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc",
    }),
    false,
  );
  // The record carries a founder that does not hash to its key.
  assert.equal(
    numbersBelongTo({
      ...good,
      founder: "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc",
    }),
    false,
  );
  assert.equal(numbersBelongTo({ ...good, projectId: 7 }), false);
});

test("a record names its launch with one chain-key tag, replacing any earlier one", () => {
  const key = `0x${"Ab".repeat(32)}`;
  const tags = [
    ["d", "lantern"],
    ["chain-key", `0x${"11".repeat(32)}`],
    ["t", "lamps"],
  ];
  const out = withChainKey(tags, key);
  assert.deepEqual(out, [
    ["d", "lantern"],
    ["t", "lamps"],
    ["chain-key", key.toLowerCase()],
  ]);
  assert.equal(chainKeyFromTags(out), key.toLowerCase());
  assert.throws(() => withChainKey(tags, "0x1234"));
});
