// Summon composer: `cast` goldens, cap enforcement, binding refusal, scaling.
//
// Derivation (hermit env: `. ./bin/activate-hermit`, `cast 1.4.3-stable`):
//
//   cast sig 'summon(string,string,string,uint16,bool,address,bytes32,address[],uint256[],(address,uint256,bytes)[])'
//     -> 0xfec53795
//   cast keccak "nebula"
//     -> 0x089cbc760269915c1eb29225a4c44e354733f98902f0a177cee1c1fceea75a95
//   cast calldata 'summon(string,string,string,uint16,bool,address,bytes32,address[],uint256[],(address,uint256,bytes)[])' \
//     'Nebula' 'NEB' '' 500 true 0x0000000000000000000000000000000000000000 \
//     0x089cbc760269915c1eb29225a4c44e354733f98902f0a177cee1c1fceea75a95 \
//     '[0x1111111111111111111111111111111111111111,0x2222222222222222222222222222222222222222]' \
//     '[40000000000000000000,12000000000000000000]' '[]'
//   cast calldata 'summon(...)' 'Nebula Org' 'NEB' 'ipfs://nebula' 0 false \
//     0x0000000000000000000000000000000000000000 \
//     0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef \
//     '[0x1111111111111111111111111111111111111111]' '[100000000000000000000]' '[]'
//   cast calldata 'summon(...)' 'Nebula' 'NEB' '' 500 true \
//     0x0000000000000000000000000000000000000000 \
//     0x5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f \
//     '[0x1111111111111111111111111111111111111111]' '[100000000000000000000]' \
//     '[(0xcccccccccccccccccccccccccccccccccccccccc,0,0xdeadbeef)]'
import assert from "node:assert/strict";
import test from "node:test";

import { functionSelector } from "../../identity/lib/userop-abi.ts";
import { POOL_PCT } from "./manifest.ts";
import {
  buildSummonTx,
  composeSummon,
  deriveOrgSymbol,
  encodeSummonCalldata,
  localBindingMap,
  SHARES_PER_PERCENT,
  summonReceiptContent,
  summonSalt,
  SUMMON_SELECTOR,
  SUMMON_SIGNATURE,
} from "./summon-composer.ts";

// ------------------------------------------------------------- fixtures ----

const B_A = `0x${"11".repeat(20)}`;
const B_B = `0x${"22".repeat(20)}`;
const FOUNDER_PUB = "a".repeat(64);
const ALICE_PUB = "b".repeat(64);
const BOB_PUB = "c".repeat(64);

function seat(pubkey, slug, label, pct, source = "grant") {
  return {
    pubkey,
    role: { slug, label, pct },
    pct,
    source,
    eventId: `ev-${slug}`,
  };
}

const ORG = { nodeId: "nebula", orgName: "Nebula", orgSymbol: "NEB" };

/** Enough budget headroom: 1 USDC/mo against a 6 USDC threshold (budget×6). */
const WITHIN = { budget: 1_000_000n, requiredCurrencyRaised: 6_000_000n };

function bindingsOf(entries) {
  return new Map(entries);
}

// --------------------------------------------------------- selector/salt ----

test("the pinned selector is what the encoder hashes (cast sig golden)", () => {
  assert.equal(functionSelector(SUMMON_SIGNATURE), "0xfec53795");
  assert.equal(SUMMON_SELECTOR, "0xfec53795");
});

test("summonSalt is keccak256(bytes(nodeId)) (cast keccak golden)", () => {
  assert.equal(
    summonSalt("nebula"),
    "0x089cbc760269915c1eb29225a4c44e354733f98902f0a177cee1c1fceea75a95",
  );
  assert.notEqual(summonSalt("nebula"), summonSalt("neptune"));
});

// ---------------------------------------------------------- cast goldens ----

const GOLDEN_TWO_HOLDERS =
  "0xfec53795" +
  "0000000000000000000000000000000000000000000000000000000000000140" +
  "0000000000000000000000000000000000000000000000000000000000000180" +
  "00000000000000000000000000000000000000000000000000000000000001c0" +
  "00000000000000000000000000000000000000000000000000000000000001f4" +
  "0000000000000000000000000000000000000000000000000000000000000001" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "089cbc760269915c1eb29225a4c44e354733f98902f0a177cee1c1fceea75a95" +
  "00000000000000000000000000000000000000000000000000000000000001e0" +
  "0000000000000000000000000000000000000000000000000000000000000240" +
  "00000000000000000000000000000000000000000000000000000000000002a0" +
  "0000000000000000000000000000000000000000000000000000000000000006" +
  "4e6562756c610000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000003" +
  "4e45420000000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000002" +
  "0000000000000000000000001111111111111111111111111111111111111111" +
  "0000000000000000000000002222222222222222222222222222222222222222" +
  "0000000000000000000000000000000000000000000000000000000000000002" +
  "0000000000000000000000000000000000000000000000022b1c8c1227a00000" +
  "000000000000000000000000000000000000000000000000a688906bd8b00000" +
  "0000000000000000000000000000000000000000000000000000000000000000";

const GOLDEN_ONE_HOLDER_URI =
  "0xfec53795" +
  "0000000000000000000000000000000000000000000000000000000000000140" +
  "0000000000000000000000000000000000000000000000000000000000000180" +
  "00000000000000000000000000000000000000000000000000000000000001c0" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef" +
  "0000000000000000000000000000000000000000000000000000000000000200" +
  "0000000000000000000000000000000000000000000000000000000000000240" +
  "0000000000000000000000000000000000000000000000000000000000000280" +
  "000000000000000000000000000000000000000000000000000000000000000a" +
  "4e6562756c61204f726700000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000003" +
  "4e45420000000000000000000000000000000000000000000000000000000000" +
  "000000000000000000000000000000000000000000000000000000000000000d" +
  "697066733a2f2f6e6562756c6100000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000001" +
  "0000000000000000000000001111111111111111111111111111111111111111" +
  "0000000000000000000000000000000000000000000000000000000000000001" +
  "0000000000000000000000000000000000000000000000056bc75e2d63100000" +
  "0000000000000000000000000000000000000000000000000000000000000000";

const GOLDEN_WITH_INIT_CALL =
  "0xfec53795" +
  "0000000000000000000000000000000000000000000000000000000000000140" +
  "0000000000000000000000000000000000000000000000000000000000000180" +
  "00000000000000000000000000000000000000000000000000000000000001c0" +
  "00000000000000000000000000000000000000000000000000000000000001f4" +
  "0000000000000000000000000000000000000000000000000000000000000001" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f" +
  "00000000000000000000000000000000000000000000000000000000000001e0" +
  "0000000000000000000000000000000000000000000000000000000000000220" +
  "0000000000000000000000000000000000000000000000000000000000000260" +
  "0000000000000000000000000000000000000000000000000000000000000006" +
  "4e6562756c610000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000003" +
  "4e45420000000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000001" +
  "0000000000000000000000001111111111111111111111111111111111111111" +
  "0000000000000000000000000000000000000000000000000000000000000001" +
  "0000000000000000000000000000000000000000000000056bc75e2d63100000" +
  "0000000000000000000000000000000000000000000000000000000000000001" +
  "0000000000000000000000000000000000000000000000000000000000000020" +
  "000000000000000000000000cccccccccccccccccccccccccccccccccccccccc" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000060" +
  "0000000000000000000000000000000000000000000000000000000000000004" +
  "deadbeef00000000000000000000000000000000000000000000000000000000";

test("two holders, empty URI, 500 bps, ragequittable — cast golden", () => {
  const data = encodeSummonCalldata({
    orgName: "Nebula",
    orgSymbol: "NEB",
    orgURI: "",
    quorumBps: 500,
    ragequittable: true,
    renderer: `0x${"00".repeat(20)}`,
    salt: summonSalt("nebula"),
    initHolders: [B_A, B_B],
    initShares: [40n * SHARES_PER_PERCENT, 12n * SHARES_PER_PERCENT],
  });
  assert.equal(data, GOLDEN_TWO_HOLDERS);
});

test("one holder at 100%, URI + zero quorum + not ragequittable — cast golden", () => {
  const data = encodeSummonCalldata({
    orgName: "Nebula Org",
    orgSymbol: "NEB",
    orgURI: "ipfs://nebula",
    quorumBps: 0,
    ragequittable: false,
    renderer: `0x${"00".repeat(20)}`,
    salt: `0x${"1234567890abcdef".repeat(4)}`,
    initHolders: [B_A],
    initShares: [100n * SHARES_PER_PERCENT],
  });
  assert.equal(data, GOLDEN_ONE_HOLDER_URI);
});

test("an initCall is encoded as the Call tuple cast encodes — cast golden", () => {
  const data = encodeSummonCalldata({
    orgName: "Nebula",
    orgSymbol: "NEB",
    orgURI: "",
    quorumBps: 500,
    ragequittable: true,
    renderer: `0x${"00".repeat(20)}`,
    salt: `0x${"5f".repeat(32)}`,
    initHolders: [B_A],
    initShares: [100n * SHARES_PER_PERCENT],
    initCalls: [
      { target: `0x${"cc".repeat(20)}`, value: 0n, data: "0xdeadbeef" },
    ],
  });
  assert.equal(data, GOLDEN_WITH_INIT_CALL);
});

test("holders and share arrays of different length cannot be encoded", () => {
  assert.throws(
    () =>
      encodeSummonCalldata({
        orgName: "Nebula",
        orgSymbol: "NEB",
        orgURI: "",
        quorumBps: 500,
        ragequittable: true,
        renderer: `0x${"00".repeat(20)}`,
        salt: summonSalt("nebula"),
        initHolders: [B_A],
        initShares: [1n, 2n],
      }),
    /exactly one share amount/,
  );
});

// ----------------------------------------------------- composition happy ----

test("the default ticker is derived from the project name, never empty", () => {
  assert.equal(deriveOrgSymbol("Nebula"), "NEBULA");
  // Spaces drop out, then the first 6 characters: NEBULA + … → "NEBULA".
  assert.equal(deriveOrgSymbol("Nebula Cooperative"), "NEBULA");
  assert.equal(deriveOrgSymbol("  *** "), "DAO", "no letters, no empty symbol");
});

test("a bound map composes: holders, shares, within-cap callData", () => {
  const map = [
    seat(FOUNDER_PUB, "founder", "The founder", 40, "declared"),
    seat(ALICE_PUB, "writer", "The writer", 12),
  ];
  const bindings = bindingsOf([
    [FOUNDER_PUB, B_A],
    [ALICE_PUB, B_B],
  ]);
  const result = composeSummon(map, bindings, WITHIN, ORG);

  assert.equal(result.ok, true, JSON.stringify(result.blockers));
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.initHolders, [B_A, B_B]);
  assert.deepEqual(result.initShares, [
    40n * SHARES_PER_PERCENT,
    12n * SHARES_PER_PERCENT,
  ]);
  assert.equal(result.totalPct, 52);
  assert.equal(
    result.totalShares,
    result.initShares.reduce((a, b) => a + b, 0n),
    "totalShares is the sum of the mints",
  );
  assert.equal(
    result.totalShares,
    BigInt(result.totalPct) * SHARES_PER_PERCENT,
    "scaling invariant: totalShares = totalPct × 10^18",
  );
  assert.equal(result.cap.state, "within");
  assert.equal(result.cap.defaultPassCost, WITHIN.budget * 3n);
  assert.ok(
    result.warnings.some((w) => w.includes("the remaining 48% is not minted")),
    "the unassigned remainder is stated, not hidden",
  );
  assert.ok(result.callData.startsWith("0xfec53795"));
});

// --------------------------------------------------------- cap enforcement --

test("cap table: within, edge (exactly 6×), over, unchecked — with numbers", () => {
  const map = [seat(FOUNDER_PUB, "founder", "The founder", 100, "declared")];
  const bindings = bindingsOf([[FOUNDER_PUB, B_A]]);
  const headroom = { budget: 1_000_000n, requiredCurrencyRaised: 7_000_000n };

  const within = composeSummon(map, bindings, headroom, ORG);
  assert.equal(within.cap.state, "within");
  assert.equal(within.cap.sixMonthCost, 6_000_000n);
  assert.equal(within.ok, true);

  // Edge: budget × 6 == threshold is inside the envelope (launch-params.ts:149).
  const edge = composeSummon(map, bindings, WITHIN, ORG);
  assert.equal(edge.cap.sixMonthCost, WITHIN.requiredCurrencyRaised);
  assert.equal(edge.cap.state, "within");
  assert.equal(edge.ok, true);

  // Over: one base unit below the threshold violates the 1/6 rule.
  const over = composeSummon(
    map,
    bindings,
    { budget: 1_000_000n, requiredCurrencyRaised: 5_999_999n },
    ORG,
  );
  assert.equal(over.cap.state, "over");
  assert.equal(over.ok, false, "an over-cap map must not compose");
  assert.equal(over.callData, null, "no bytes exist for an over-cap map");
  const blocker = over.blockers.join(" | ");
  assert.match(blocker, /Budget cap over/);
  assert.match(blocker, /1 USDC a month × 6 = 6 USDC/);
  assert.match(blocker, /5\.999999 USDC/, "the exact threshold, unrounded");
  assert.equal(over.cap.defaultPassCost, 3_000_000n, "the 3× figure");

  // Unchecked: no budget on the record — never rendered as "within".
  const unchecked = composeSummon(
    map,
    bindings,
    { budget: null, requiredCurrencyRaised: 6_000_000n },
    ORG,
  );
  assert.equal(unchecked.cap.state, "unchecked");
  assert.equal(unchecked.ok, true, "an unchecked cap is not a blocker");
  assert.ok(
    unchecked.warnings.some((w) => w.includes("cannot be checked")),
    "the missing figure is said out loud",
  );

  const noThreshold = composeSummon(
    map,
    bindings,
    { budget: 1_000_000n, requiredCurrencyRaised: 0n },
    ORG,
  );
  assert.equal(noThreshold.cap.state, "unchecked");
  assert.ok(noThreshold.warnings.some((w) => w.includes("no graduation")));
});

test("the pool cap blocks an over-100% map with the exact numbers", () => {
  const map = [
    seat(FOUNDER_PUB, "founder", "The founder", 60, "declared"),
    seat(ALICE_PUB, "writer", "The writer", 42),
  ];
  const bindings = bindingsOf([
    [FOUNDER_PUB, B_A],
    [ALICE_PUB, B_B],
  ]);
  const result = composeSummon(map, bindings, WITHIN, ORG);
  assert.equal(result.ok, false);
  assert.equal(result.callData, null);
  assert.ok(
    result.blockers.some((b) =>
      b.includes(`totals 102% of the ${POOL_PCT}% pool`),
    ),
    `expected a pool blocker, got ${JSON.stringify(result.blockers)}`,
  );
});

test("a fractional or zero seat percentage is refused, not rounded", () => {
  const map = [seat(FOUNDER_PUB, "founder", "The founder", 0, "declared")];
  const bindings = bindingsOf([[FOUNDER_PUB, B_A]]);
  const result = composeSummon(map, bindings, WITHIN, ORG);
  assert.equal(result.ok, false);
  assert.ok(result.blockers.some((b) => b.includes("at least 1")));
  assert.deepEqual(result.initHolders, [], "nothing is minted");
});

// -------------------------------------------------------- binding refusal --

test("an unbound grantee blocks composition and is named loudly", () => {
  const map = [
    seat(FOUNDER_PUB, "founder", "The founder", 40, "declared"),
    seat(ALICE_PUB, "writer", "The writer", 12),
  ];
  const bindings = bindingsOf([[FOUNDER_PUB, B_A]]); // Alice has no binding
  const result = composeSummon(map, bindings, WITHIN, ORG);

  assert.equal(result.ok, false);
  assert.equal(result.callData, null);
  const blocker = result.blockers.join(" | ");
  assert.match(blocker, /The writer/);
  assert.match(blocker, /no bound EVM address/);
  assert.match(blocker, /cannot be minted/);
  // The bound seat still previews; the unbound one is not a holder.
  assert.deepEqual(result.initHolders, [B_A]);
  assert.equal(result.seats[1].status, "unbound");
  assert.equal(result.seats[1].address, null);
});

test("a malformed binding is refused rather than encoded", () => {
  const map = [seat(ALICE_PUB, "writer", "The writer", 12)];
  const bindings = bindingsOf([[ALICE_PUB, "0x1234"]]);
  const result = composeSummon(map, bindings, WITHIN, ORG);
  assert.equal(result.ok, false);
  assert.equal(result.seats[0].status, "invalid-address");
  assert.ok(result.blockers.some((b) => b.includes("not a 0x address")));
  assert.deepEqual(result.initHolders, []);
});

test("an empty map blocks — there is nothing to summon", () => {
  const result = composeSummon([], new Map(), WITHIN, ORG);
  assert.equal(result.ok, false);
  assert.ok(result.blockers.some((b) => b.includes("no seats")));
});

test("an empty name or symbol blocks before any bytes exist", () => {
  const map = [seat(FOUNDER_PUB, "founder", "The founder", 100, "declared")];
  const bindings = bindingsOf([[FOUNDER_PUB, B_A]]);
  const unnamed = composeSummon(map, bindings, WITHIN, {
    ...ORG,
    orgName: "  ",
  });
  assert.equal(unnamed.ok, false);
  assert.ok(unnamed.blockers.some((b) => b.includes("needs a name")));
  const unsymbolled = composeSummon(map, bindings, WITHIN, {
    ...ORG,
    orgSymbol: "",
  });
  assert.equal(unsymbolled.ok, false);
  assert.ok(unsymbolled.blockers.some((b) => b.includes("needs a symbol")));
});

// ------------------------------------------------------- binding sources ----

test("localBindingMap only yields the viewer's own, well-formed binding", () => {
  const map = [seat(FOUNDER_PUB, "founder", "The founder", 100, "declared")];
  assert.deepEqual(
    [...localBindingMap({ pubkey: FOUNDER_PUB, address: B_A }, map)],
    [[FOUNDER_PUB, B_A]],
  );
  assert.equal(localBindingMap(null, map).size, 0, "no binding, no address");
  assert.equal(
    localBindingMap({ pubkey: BOB_PUB, address: B_A }, map).size,
    0,
    "a binding for someone off the map contributes nothing",
  );
  assert.equal(
    localBindingMap({ pubkey: FOUNDER_PUB, address: "0xnope" }, map).size,
    0,
    "a malformed address is not a binding",
  );
});

// ------------------------------------------------------- receipt payload ----

test("the summon receipt carries the mapping that was actually minted", () => {
  const map = [
    seat(FOUNDER_PUB, "founder", "The founder", 40, "declared"),
    seat(ALICE_PUB, "writer", "The writer", 12),
    seat(BOB_PUB, "designer", "The designer", 8),
  ];
  const bindings = bindingsOf([
    [FOUNDER_PUB, B_A],
    [ALICE_PUB, B_B],
    // Bob unbound: the receipt records what minted, not what was intended.
  ]);
  const composition = composeSummon(map, bindings, WITHIN, ORG);
  const content = summonReceiptContent({
    composition,
    org: ORG,
    chainId: "11155111",
    summoner: `0x${"ab".repeat(20)}`,
    dao: `0x${"de".repeat(20)}`,
  });

  assert.equal(content.table, "summon");
  assert.equal(content.project, "nebula");
  assert.equal(content.sharesPerPercent, SHARES_PER_PERCENT.toString());
  assert.equal(content.salt, summonSalt("nebula"));
  assert.equal(content.dao, `0x${"de".repeat(20)}`);
  const holders = content.holders;
  assert.equal(holders.length, 2, "only mintable seats are in the payload");
  assert.equal(
    holders.reduce((sum, holder) => sum + BigInt(holder.shares), 0n),
    composition.totalShares,
    "payload shares add up to what the chain was asked to mint",
  );
  assert.ok(holders.every((holder) => /^0x[0-9a-f]{40}$/.test(holder.address)));
});

test("the receipt states an unknown DAO as absent instead of guessing", () => {
  const map = [seat(FOUNDER_PUB, "founder", "The founder", 100, "declared")];
  const bindings = bindingsOf([[FOUNDER_PUB, B_A]]);
  const composition = composeSummon(map, bindings, WITHIN, ORG);
  const content = summonReceiptContent({
    composition,
    org: ORG,
    chainId: "11155111",
    summoner: `0x${"ab".repeat(20)}`,
    dao: null,
  });
  assert.equal("dao" in content, false, "no dao key rather than a fake one");
});

// ------------------------------------------------------------- send seam ----

test("buildSummonTx validates the target and keeps the bytes untouched", () => {
  const tx = buildSummonTx(`0x${"AB".repeat(20)}`, GOLDEN_TWO_HOLDERS);
  assert.deepEqual(tx, {
    to: `0x${"ab".repeat(20)}`,
    data: GOLDEN_TWO_HOLDERS,
    value: "0x0",
  });
  assert.throws(() => buildSummonTx("summoner.eth", "0x1234"), /0x address/);
});
