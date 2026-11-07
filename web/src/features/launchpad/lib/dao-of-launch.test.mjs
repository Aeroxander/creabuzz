import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { daoOfLaunch, launchOfDao } from "./dao-of-launch.ts";

const DAO_A = `0x${"ab".repeat(20)}`;
const DAO_B = `0x${"cd".repeat(20)}`;

const launch = (over = {}) => ({
  record: {
    id: "l1",
    chainId: "31337",
    treasury: null,
    tokenPlan: null,
    ...over.record,
  },
  bids: [],
  updates: [],
  proposals: [],
  receipts: over.receipts ?? [],
});

describe("daoOfLaunch", () => {
  it("is the treasury of a launch that settled into its own DAO", () => {
    const l = launch({
      record: {
        treasury: DAO_A.toUpperCase().replace("0X", "0x"),
        tokenPlan: { mode: "dao" },
      },
    });
    assert.equal(daoOfLaunch(l), DAO_A);
  });

  it("is the DAO a summon receipt names, when the treasury is not one", () => {
    const l = launch({
      receipts: [
        {
          table: "dao-launch",
          payload: { dao: DAO_B },
          tx: "0x1",
          createdAt: 5,
        },
      ],
    });
    assert.equal(daoOfLaunch(l), DAO_B);
  });

  it("is null for a launch that has neither, or whose treasury is just a wallet", () => {
    assert.equal(daoOfLaunch(launch()), null);
    assert.equal(
      daoOfLaunch(
        launch({ record: { treasury: DAO_A, tokenPlan: { mode: "token" } } }),
      ),
      null,
    );
    assert.equal(
      daoOfLaunch(
        launch({ record: { treasury: "0x12", tokenPlan: { mode: "dao" } } }),
      ),
      null,
    );
  });
});

describe("launchOfDao", () => {
  const a = launch({
    record: {
      id: "a",
      chainId: "31337",
      treasury: DAO_A,
      tokenPlan: { mode: "dao" },
    },
  });
  const b = launch({
    record: {
      id: "b",
      chainId: "1",
      treasury: DAO_B,
      tokenPlan: { mode: "dao" },
    },
  });

  it("finds the launch on the same chain, whatever the case of the address", () => {
    assert.equal(
      launchOfDao([a, b], 31337, DAO_A.toUpperCase().replace("0X", "0x"))
        ?.record.id,
      "a",
    );
  });

  it("does not match a DAO on another chain, or one no launch names", () => {
    assert.equal(launchOfDao([a, b], 31337, DAO_B), null);
    assert.equal(launchOfDao([a, b], 1, DAO_A), null);
    assert.equal(launchOfDao([a, b], 31337, `0x${"ee".repeat(20)}`), null);
    assert.equal(launchOfDao([], 31337, DAO_A), null);
  });
});
