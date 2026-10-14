import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { recordToInput } from "./record-input.ts";
import { STANDARD_ALLOCATION } from "./allocation.ts";

/**
 * Every field the record holds has to survive `recordToInput`, or an action
 * that only means to change one of them erases the rest on save — the defect
 * that already reset `tickSpacing` and dropped `tokenPlan` on every edit
 * (Review-Proven Rule 5: one user action, one consistent snapshot).
 *
 * This drives the production seam: `record-input.ts` only has type-only
 * imports, so node loads and runs it as written.
 */

function record(overrides = {}) {
  return {
    id: "nebula",
    eventId: "f".repeat(64),
    author: "a".repeat(64),
    createdAt: 1_700_000_000,
    name: "Nebula",
    pitch: "A pitch.",
    longPitch: "The long one.",
    ipList: ["https://example.com/ip"],
    updateCadence: "monthly",
    stage: "live",
    funding: null,
    currency: "ETH",
    floorPrice: "792281625140000",
    tickSpacing: "79228162514",
    requiredRaised: "299999999998",
    budget: "1200000000000000000",
    startBlock: 100,
    endBlock: 200,
    claimBlock: 300,
    paramsHash: null,
    website: "https://example.com",
    image: "https://example.com/cover.png",
    category: "Software",
    docs: ["https://example.com/docs"],
    channels: ["11111111-1111-1111-1111-111111111111"],
    chat: {
      team: "22222222-2222-2222-2222-222222222222",
      supporters: null,
      backers: null,
    },
    projects: [],
    team: [],
    agent: null,
    chainId: "11155111",
    auction: `0x${"1".repeat(40)}`,
    token: `0x${"2".repeat(40)}`,
    treasury: `0x${"3".repeat(40)}`,
    hooks: [],
    distributor: `0x${"4".repeat(40)}`,
    claimStake: `0x${"5".repeat(40)}`,
    verifierSet: `0x${"6".repeat(40)}`,
    admission: "curated",
    allocation: STANDARD_ALLOCATION,
    vesting: null,
    unlocks: null,
    daoAtGraduation: true,
    legalWrapper: "dao-llc",
    ipRecord: {
      v: 1,
      holder: "founders",
      licence: null,
      entity: null,
      assignment: null,
      operating: null,
      contributorTerms: null,
    },
    tokenPlan: {
      mode: "mint",
      name: "Nebula",
      symbol: "NEB",
      supply: "1000000000",
    },
    ...overrides,
  };
}

test("a save that means to change one field erases none of the others", () => {
  const source = record({
    funding: {
      stance: "planning",
      seeking: ["backers", "advisors"],
      opensAt: "2026-11-01",
      note: "Aiming for late autumn.",
    },
  });
  const input = recordToInput(source);

  // The money terms that were already burned once.
  assert.equal(input.tickSpacing, "79228162514");
  assert.deepEqual(input.tokenPlan, source.tokenPlan);
  assert.equal(input.budget, "1200000000000000000");
  assert.deepEqual(input.allocation, STANDARD_ALLOCATION);
  assert.equal(input.daoAtGraduation, true);
  assert.equal(input.longPitch, "The long one.");
  assert.deepEqual(input.ipList, ["https://example.com/ip"]);
  assert.equal(input.updateCadence, "monthly");
  assert.equal(input.image, "https://example.com/cover.png");
  assert.equal(input.category, "Software");
  assert.equal(input.startBlock, 100);
  assert.equal(input.endBlock, 200);
  assert.equal(input.claimBlock, 300);
  assert.deepEqual(input.chat, source.chat);
  assert.deepEqual(input.channels, source.channels);
});

test("the funding declaration survives a save", () => {
  const funding = {
    stance: "rolling",
    seeking: ["contributors"],
    opensAt: null,
    note: "Always open.",
  };
  const input = recordToInput(record({ funding }));
  assert.deepEqual(input.funding, funding);
});

test("an override replaces the funding declaration instead of adding a second one", () => {
  const input = recordToInput(
    record({
      funding: { stance: "planning", seeking: [], opensAt: null, note: null },
    }),
    {
      funding: {
        stance: "not-raising",
        seeking: ["advisors"],
        opensAt: null,
        note: null,
      },
    },
  );
  assert.equal(input.funding?.stance, "not-raising");
  assert.deepEqual(input.funding?.seeking, ["advisors"]);
});

test("a record that never declared funding does not grow one on save", () => {
  const input = recordToInput(record({ funding: null }));
  assert.equal(input.funding, undefined);
});

test("the legal wrapper, the IP record and the deploy tags survive a save", () => {
  const source = record();
  const input = recordToInput(source);
  assert.equal(input.legalWrapper, "dao-llc");
  assert.deepEqual(input.ipRecord, source.ipRecord);
  assert.equal(input.distributor, `0x${"4".repeat(40)}`);
  assert.equal(input.claimStake, `0x${"5".repeat(40)}`);
  assert.equal(input.verifierSet, `0x${"6".repeat(40)}`);
});

test("every field a launch can be created with is carried by a save", () => {
  // The whole interface, read from the source: a field added to
  // `CreateLaunchInput` and not carried by `recordToInput` is erased by the next
  // save, which is how the legal wrapper and the deploy tags were lost.
  const source = readFileSync(
    new URL("../use-launches.ts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("export interface CreateLaunchInput");
  const end = source.indexOf("/** Every channel the record binds");
  const fields = [
    ...source.slice(start, end).matchAll(/^ {2}([a-zA-Z]+)\??:/gm),
  ].map((match) => match[1]);
  assert.ok(fields.length > 25, "found the interface's fields");
  // Not a property of the record: how the save is signed.
  // A record that holds every optional part, so none is skipped for being empty.
  const full = record({
    funding: { stance: "rolling", seeking: [], opensAt: null, note: null },
    vesting: { tranches: [{ multiple: 2, fraction: 1 }] },
    unlocks: { kind: "none" },
  });
  const carried = Object.keys(recordToInput(full));
  const missing = fields.filter(
    (field) => field !== "asAgent" && !carried.includes(field),
  );
  assert.deepEqual(missing, []);
});
