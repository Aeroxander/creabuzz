import assert from "node:assert/strict";
import { test } from "node:test";

import { encodeParameters, selectorOf } from "./evmAbi.ts";
import {
  bondActions,
  encodePostBond,
  readRemixBond,
  recordKey,
  REMIX_BOND_SIGNATURES,
  TOPIC_BOND_POSTED,
} from "./remixBond.ts";

const BONDS = `0x${"b0".repeat(20)}`;
const REMIX = `37001:${"a".repeat(64)}:docs-commons`;
const PARENT_DAO = `0x${"da".repeat(20)}`;
const FOUNDER = `0x${"f0".repeat(20)}`;

test("the bond's calls and its event are the contract's (cast goldens)", () => {
  const sig = (s) => selectorOf(s);
  assert.equal(sig(REMIX_BOND_SIGNATURES.post), "0x871dc261");
  assert.equal(sig(REMIX_BOND_SIGNATURES.openCase), "0x2073b17c");
  assert.equal(sig(REMIX_BOND_SIGNATURES.release), "0x37bdc99b");
  assert.equal(sig(REMIX_BOND_SIGNATURES.payParent), "0xf36f3776");
  assert.equal(sig(REMIX_BOND_SIGNATURES.bonds), "0x5f1c17c0");
  assert.equal(
    TOPIC_BOND_POSTED,
    "0x1cb44f6c9167a31b60228b516da05e5d2624da7b9b379cd807cf22e3bef04306",
  );
  assert.equal(
    recordKey(REMIX),
    "0xc71be61cffb0caaa47f585d5905d49b7c3c404b86f3835cd0394573219b0e1dd",
  );
  const post = (over) =>
    encodePostBond({
      remix: REMIX,
      parent: REMIX,
      parentDao: PARENT_DAO,
      terms: "t",
      amount: 1n,
      days: 90,
      ...over,
    });
  assert.ok(post({}).startsWith("0x871dc261"));
  assert.throws(() => post({ days: 29 }), /30 to 730 days/);
  assert.throws(() => post({ days: 731 }), /30 to 730 days/);
  assert.throws(() => post({ parentDao: "" }), /no DAO/);
  assert.throws(() => post({ amount: 0n }), /above zero/);
});

const bond = (over = {}) => ({
  id: 1n,
  poster: FOUNDER,
  parentDao: PARENT_DAO,
  releasesAt: 1_000,
  state: "held",
  openCase: 0,
  amount: 10n,
  terms: "t",
  ...over,
});

test("a held bond can go to the court until its term ends, then home; a forfeited one to the parent", () => {
  assert.deepEqual(bondActions(bond(), 999), {
    openCase: true,
    release: false,
    payParent: false,
  });
  assert.deepEqual(bondActions(bond(), 1_000), {
    openCase: false,
    release: true,
    payParent: false,
  });
  assert.deepEqual(bondActions(bond({ openCase: 3 }), 2_000), {
    openCase: false,
    release: false,
    payParent: false,
  });
  assert.deepEqual(bondActions(bond({ state: "forfeited" }), 0), {
    openCase: false,
    release: false,
    payParent: true,
  });
});

test("a remix's latest bond is read from its posting and the bond's record", async () => {
  const data = (terms) =>
    encodeParameters(
      ["address", "address", "uint256", "uint64", "string"],
      [FOUNDER, PARENT_DAO, 10n, 1_000n, terms],
    );
  const chain = {
    logs: async ({ topics }) => {
      assert.equal(topics[0], TOPIC_BOND_POSTED);
      assert.equal(topics[2], recordKey(REMIX));
      return [
        {
          topics: [
            TOPIC_BOND_POSTED,
            `0x${"0".repeat(63)}1`,
            topics[2],
            `0x${"0".repeat(64)}`,
          ],
          data: data("old"),
        },
        {
          topics: [
            TOPIC_BOND_POSTED,
            `0x${"0".repeat(63)}2`,
            topics[2],
            `0x${"0".repeat(64)}`,
          ],
          data: data("Credit us."),
        },
      ];
    },
    call: async () =>
      encodeParameters(
        [
          "address",
          "address",
          "uint64",
          "uint8",
          "uint64",
          "uint128",
          "bytes32",
          "bytes32",
          "bytes32",
        ],
        [
          FOUNDER,
          PARENT_DAO,
          1_000n,
          1n,
          0n,
          10n,
          `0x${"0".repeat(64)}`,
          `0x${"0".repeat(64)}`,
          `0x${"0".repeat(64)}`,
        ],
      ),
  };
  assert.deepEqual(
    await readRemixBond(chain, BONDS, REMIX),
    bond({ id: 2n, terms: "Credit us." }),
  );
  assert.equal(
    await readRemixBond(
      { logs: async () => [], call: async () => "0x" },
      BONDS,
      REMIX,
    ),
    null,
  );
});
