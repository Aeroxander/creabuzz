// Every call builder, read back with the ABI: the right contract, the right function, the right arguments. A few are also
// pinned against `cast calldata`. Run with: node --experimental-strip-types --test src/pot/pot-calls.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { decodeParameters } from "../launchpad/evmAbi.ts";
import { decodeCall } from "./abi-codec.ts";
import {
  LAUNCHER_ABI,
  PAIR_ABI,
  PLAY_DOLLAR_ABI,
  TREASURY_ABI,
  VESTER_ABI,
} from "./abis.generated.ts";
import * as calls from "./pot-calls.ts";

const DOLLAR = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const TREASURY = "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9";
const VESTER = "0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9";
const LAUNCHER = "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0";
const PAIR = "0x5FC8d32690cc91D4c39d9d3abcBD16989F875707";
const ME = "0xf39Fd6e51aad88F6F4ce6aB8827279cFFFb92266";
const YOU = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const HASH = `0x${"ab".repeat(32)}`;
const KEY = `0x${"11".repeat(32)}`;
const low = (a) => a.toLowerCase();

function read(abi, call) {
  assert.equal(call.value, "0x0");
  const found = decodeCall(abi, call.data);
  assert.ok(found, `calldata of ${call.to} not in its ABI`);
  return found;
}

test("Back with the play dollar is ONE call: transferAndCall with exactly 64 bytes of data", () => {
  const list = calls.backCalls({
    dollar: DOLLAR,
    treasury: TREASURY,
    amount: 5_000_000n,
    minShares: 990_000_000_000_000_000n,
    to: ME,
    payAndCall: true,
  });
  assert.equal(list.length, 1);
  assert.equal(list[0].to, low(DOLLAR));
  // cast calldata "transferAndCall(address,uint256,bytes)" <treasury> 5000000 $(cast abi-encode "f(uint256,address)" 990000000000000000 <ME>)
  assert.match(list[0].data, /^0x4000aea0/);
  const found = read(PLAY_DOLLAR_ABI, list[0]);
  assert.equal(found.name, "transferAndCall");
  assert.equal(found.args[0], low(TREASURY));
  assert.equal(found.args[1], 5_000_000n);
  const payload = found.args[2];
  assert.equal((payload.length - 2) / 2, 64);
  const [minShares, to] = decodeParameters(["uint256", "address"], payload);
  assert.equal(minShares, 990_000_000_000_000_000n);
  assert.equal(to, low(ME));
});

test("Back's data matches cast byte for byte", () => {
  const [call] = calls.backCalls({
    dollar: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    treasury: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    amount: 5_000_000n,
    minShares: 990_000_000_000_000_000n,
    to: ME,
    payAndCall: true,
  });
  assert.equal(
    call.data,
    "0x4000aea000000000000000000000000070997970c51812dc3a010c7d01b50e0d17dc79c800000000000000000000000000000000000000000000000000000000004c4b40000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000dbd2fc137a30000000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb92266",
  );
});

test("a Back by approve and join must name who gets the Shares: join does not read zero as the payer", () => {
  assert.throws(
    () =>
      calls.backCalls({
        dollar: DOLLAR,
        treasury: TREASURY,
        amount: 1_000_000n,
        minShares: 1n,
        payAndCall: false,
      }),
    /needs the account that gets the Shares/,
  );
});

test("Back's `to` defaults to the payer (the zero address)", () => {
  const [call] = calls.backCalls({
    dollar: DOLLAR,
    treasury: TREASURY,
    amount: 1_000_000n,
    minShares: 1n,
    payAndCall: true,
  });
  const [, to] = decodeParameters(
    ["uint256", "address"],
    read(PLAY_DOLLAR_ABI, call).args[2],
  );
  assert.equal(to, calls.ZERO_ADDRESS);
});

test("Back with a dollar that cannot pay and call is approve, then join, in that order", () => {
  const list = calls.backCalls({
    dollar: DOLLAR,
    treasury: TREASURY,
    amount: 5_000_000n,
    minShares: 7n,
    to: ME,
    payAndCall: false,
  });
  assert.equal(list.length, 2);
  const approve = read(PLAY_DOLLAR_ABI, list[0]);
  assert.equal(list[0].to, low(DOLLAR));
  assert.deepEqual(
    [approve.name, ...approve.args],
    ["approve", low(TREASURY), 5_000_000n],
  );
  const join = read(TREASURY_ABI, list[1]);
  assert.equal(list[1].to, low(TREASURY));
  assert.deepEqual(
    [join.name, ...join.args],
    ["join", 5_000_000n, 7n, low(ME)],
  );
  // cast calldata "join(uint256,uint256,address)" 5000000 990000000000000000 <ME>
  const [pinned] = [
    calls.backCalls({
      dollar: DOLLAR,
      treasury: TREASURY,
      amount: 5_000_000n,
      minShares: 990_000_000_000_000_000n,
      to: ME,
      payAndCall: false,
    })[1],
  ];
  assert.equal(
    pinned.data,
    "0x575b70d000000000000000000000000000000000000000000000000000000000004c4b400000000000000000000000000000000000000000000000000dbd2fc137a30000000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb92266",
  );
});

test("Take out is one call, pinned against cast", () => {
  const call = calls.leaveCall({
    treasury: TREASURY,
    shares: 2n * 10n ** 18n,
    minCash: 1_000_000n,
    to: ME,
  });
  assert.equal(
    call.data,
    "0x8674b8670000000000000000000000000000000000000000000000001bc16d674ec8000000000000000000000000000000000000000000000000000000000000000f4240000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb92266",
  );
  const found = read(TREASURY_ABI, call);
  assert.deepEqual(
    [found.name, ...found.args],
    ["leave", 2n * 10n ** 18n, 1_000_000n, low(ME)],
  );
});

test("check-in carries the record's hash, for the Treasury and for a Pair's signer", () => {
  const direct = calls.checkInCall(TREASURY, HASH);
  // cast calldata "checkIn(bytes32)" 0xabab...
  assert.equal(direct.data, `0x4662d1dd${"ab".repeat(32)}`);
  assert.deepEqual(
    [read(TREASURY_ABI, direct).name, ...read(TREASURY_ABI, direct).args],
    ["checkIn", HASH],
  );
  const viaPair = calls.pairCheckInCall(PAIR, HASH);
  assert.equal(viaPair.to, low(PAIR));
  assert.deepEqual(
    [read(PAIR_ABI, viaPair).name, ...read(PAIR_ABI, viaPair).args],
    ["checkIn", HASH],
  );
  assert.throws(() => calls.checkInCall(TREASURY, "0x1234"), /32 bytes/);
});

const TREASURY_CASES = [
  [
    "leaveTeam",
    calls.leaveTeamCall({
      treasury: TREASURY,
      shares: 3n,
      minCash: 4n,
      to: ME,
    }),
    [3n, 4n, low(ME)],
  ],
  [
    "draw",
    calls.drawCall({ treasury: TREASURY, to: YOU, amount: 25_000_000n }),
    [low(YOU), 25_000_000n],
  ],
  ["setRate", calls.setRateCall(TREASURY, 500), [500n]],
  ["proposeRate", calls.proposeRateCall(TREASURY, 1500), [1500n]],
  ["applyRate", calls.applyRateCall(TREASURY), []],
  ["setDoor", calls.setDoorCall(TREASURY, false), [false]],
  [
    "grantTeam",
    calls.grantTeamCall({
      treasury: TREASURY,
      member: YOU,
      amount: 10n ** 18n,
    }),
    [low(YOU), 10n ** 18n],
  ],
  ["collectFees", calls.collectFeesCall(TREASURY), []],
  ["authoriseAgent", calls.authoriseAgentCall(TREASURY, YOU), [low(YOU)]],
  [
    "setAgent",
    calls.setAgentCall({
      treasury: TREASURY,
      agent: YOU,
      usdCap: 5n,
      teamCap: 6n,
    }),
    [low(YOU), 5n, 6n],
  ],
  ["revokeAgent", calls.revokeAgentCall(TREASURY, YOU), [low(YOU)]],
  [
    "handOver",
    calls.handOverCall({ treasury: TREASURY, next: YOU, founderLeaves: true }),
    [low(YOU), true],
  ],
  ["takeSeat", calls.takeSeatCall(TREASURY), []],
];

for (const [name, call, args] of TREASURY_CASES) {
  test(`${name} goes to the Treasury with its arguments`, () => {
    assert.equal(call.to, low(TREASURY));
    const found = read(TREASURY_ABI, call);
    assert.deepEqual([found.name, ...found.args], [name, ...args]);
  });
}

test("outside money is approve, then add", () => {
  const [approve, add] = calls.addRevenueCalls({
    dollar: DOLLAR,
    treasury: TREASURY,
    amount: 3_000_000_000n,
  });
  assert.equal(approve.to, low(DOLLAR));
  assert.deepEqual(
    [
      read(PLAY_DOLLAR_ABI, approve).name,
      ...read(PLAY_DOLLAR_ABI, approve).args,
    ],
    ["approve", low(TREASURY), 3_000_000_000n],
  );
  assert.equal(add.to, low(TREASURY));
  assert.deepEqual(
    [read(TREASURY_ABI, add).name, ...read(TREASURY_ABI, add).args],
    ["addRevenue", 3_000_000_000n],
  );
});

test("the faucet goes to the dollar with no arguments", () => {
  const call = calls.faucetCall(DOLLAR);
  assert.equal(call.to, low(DOLLAR));
  assert.equal(read(PLAY_DOLLAR_ABI, call).name, "faucet");
});

const VESTER_CASES = [
  ["claim", calls.claimGrantCall(VESTER, 4n)],
  ["announceForfeit", calls.announceForfeitCall(VESTER, 4n)],
  ["execute", calls.executeForfeitCall(VESTER, 4n)],
];
for (const [name, call] of VESTER_CASES) {
  test(`${name} goes to the Vester with the grant's id`, () => {
    assert.equal(call.to, low(VESTER));
    const found = read(VESTER_ABI, call);
    assert.deepEqual([found.name, ...found.args], [name, 4n]);
  });
}

test("launch carries its terms as one tuple, pinned against cast", () => {
  const call = calls.launchCall({
    launcher: LAUNCHER,
    projectId: KEY,
    name: "Demo",
    symbol: "DEMO",
    ratePpm: 1000,
    teamPool: 10_000_000n * 10n ** 18n,
    settingsHash: `0x${"22".repeat(32)}`,
  });
  assert.equal(
    call.data,
    "0x4641702b111111111111111111111111111111111111111111111111111111111111111100000000000000000000000000000000000000000000000000000000000000c0000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000003e8000000000000000000000000000000000000000000084595161401484a0000002222222222222222222222222222222222222222222222222222222222222222000000000000000000000000000000000000000000000000000000000000000444656d6f00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000444454d4f00000000000000000000000000000000000000000000000000000000",
  );
  const found = read(LAUNCHER_ABI, call);
  assert.equal(found.name, "launch");
  assert.deepEqual(found.args[3], [1000n, 10_000_000n * 10n ** 18n]);
});

test("makePair and windDown go to the Launcher with the project's key", () => {
  const pair = calls.makePairCall(LAUNCHER, KEY, ME);
  assert.deepEqual(
    [read(LAUNCHER_ABI, pair).name, ...read(LAUNCHER_ABI, pair).args],
    ["makePair", KEY, low(ME)],
  );
  const wind = calls.windDownCall(LAUNCHER, KEY);
  assert.deepEqual(
    [read(LAUNCHER_ABI, wind).name, ...read(LAUNCHER_ABI, wind).args],
    ["windDown", KEY],
  );
});

test("a bad address, a negative or oversize number never becomes calldata", () => {
  assert.throws(
    () => calls.drawCall({ treasury: TREASURY, to: "0x12", amount: 1n }),
    /invalid address/,
  );
  assert.throws(
    () => calls.drawCall({ treasury: TREASURY, to: YOU, amount: -1n }),
    /out of range/,
  );
  assert.throws(
    () => calls.drawCall({ treasury: TREASURY, to: YOU, amount: 2n ** 256n }),
    /out of range/,
  );
  assert.throws(() => calls.setRateCall(TREASURY, 2 ** 32), /out of range/);
  assert.throws(() => calls.setRateCall(TREASURY, 1.5));
  assert.throws(() => calls.setRateCall(TREASURY, -1), /out of range/);
});

test("a Pair's proposal, confirmation and withdrawal carry the inner call whole", () => {
  const inner = calls.drawCall({
    treasury: TREASURY,
    to: YOU,
    amount: 25_000_000n,
  });
  const propose = calls.pairProposeCall(PAIR, inner.to, inner.data);
  assert.equal(propose.to, low(PAIR));
  const proposed = read(PAIR_ABI, propose);
  assert.deepEqual(
    [proposed.name, ...proposed.args],
    ["propose", low(TREASURY), inner.data],
  );
  const confirm = calls.pairConfirmCall(PAIR, inner.to, inner.data, 3n);
  const confirmed = read(PAIR_ABI, confirm);
  assert.deepEqual(
    [confirmed.name, ...confirmed.args],
    ["confirm", low(TREASURY), inner.data, 3n],
  );
  const cancel = calls.pairCancelCall(PAIR, HASH);
  assert.deepEqual(
    [read(PAIR_ABI, cancel).name, ...read(PAIR_ABI, cancel).args],
    ["cancel", HASH],
  );
});
