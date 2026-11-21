// Every call builder, read back with the ABI: the right contract, the right function, the right arguments. A few are also
// pinned against `cast calldata`. Run with: node --experimental-strip-types --test src/pot/pot-calls.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { decodeParameters } from "../launchpad/evmAbi.ts";
import { decodeCall } from "./abi-codec.ts";
import {
  EARLIER_GRANTS_ABI,
  HOLDER_PAUSE_ABI,
  LAUNCHER_ABI,
  PAIR_ABI,
  PLAY_DOLLAR_ABI,
  SHARE_TOKEN_ABI,
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

test("a Pair's forfeit of a member's grant is a Treasury call with the grant's id", () => {
  const call = calls.runnerForfeitCall(TREASURY, 4n);
  assert.equal(call.to, low(TREASURY));
  const found = read(TREASURY_ABI, call);
  assert.deepEqual([found.name, ...found.args], ["announceForfeit", 4n]);
});

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

test("winding down on the Treasury itself is a call with no arguments", () => {
  const call = calls.treasuryWindDownCall(TREASURY);
  assert.equal(call.to, low(TREASURY));
  const found = read(TREASURY_ABI, call);
  assert.deepEqual([found.name, ...found.args], ["windDown"]);
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

// --- Tasks ---------------------------------------------------------------------------------------------------------
// Each literal below is what `cast calldata "<signature>" <arguments>` prints (foundry 1.4.3), so a builder that drifts
// from the contract's own function fails here. The commands are in the comment above each one.

const WHAT = `0x${"ab".repeat(32)}`;

test("the seven task calls have the selectors `cast sig` gives, and the Treasury has them", () => {
  const selectors = {
    // cast sig "announceTask(bytes32,address,uint256,uint16)" and the rest
    announceTask: "0xf799daee",
    takeTask: "0x6efda0f9",
    acceptTask: "0xa4e235c2",
    rejectTask: "0xbe99bca8",
    cancelTask: "0x6190aab8",
    returnTask: "0x6c950913",
    claimNote: "0xa5826642",
  };
  const made = {
    announceTask: calls.announceTaskCall({
      treasury: TREASURY,
      what: WHAT,
      payee: YOU,
      maxDollars: 1_000_000n,
      shareBps: 1,
    }),
    takeTask: calls.takeTaskCall({
      treasury: TREASURY,
      serial: 1n,
      minAmount: 1n,
    }),
    acceptTask: calls.acceptTaskCall({
      treasury: TREASURY,
      serial: 1n,
      payDollars: 1n,
    }),
    rejectTask: calls.rejectTaskCall({ treasury: TREASURY, serial: 1n }),
    cancelTask: calls.cancelTaskCall({ treasury: TREASURY, serial: 1n }),
    returnTask: calls.returnTaskCall({ treasury: TREASURY, serial: 1n }),
    claimNote: calls.claimNoteCall({
      treasury: TREASURY,
      serial: 1n,
      holder: YOU,
    }),
  };
  for (const [name, selector] of Object.entries(selectors)) {
    assert.equal(made[name].data.slice(0, 10), selector, name);
    assert.equal(made[name].to, low(TREASURY), name);
    assert.equal(made[name].value, "0x0", name);
    assert.equal(read(TREASURY_ABI, made[name]).name, name);
  }
});

test("the task calls' data is what cast calldata gives, byte for byte", () => {
  // cast calldata "announceTask(bytes32,address,uint256,uint16)" 0xabab…ab <YOU> 400000000 250
  assert.equal(
    calls.announceTaskCall({
      treasury: TREASURY,
      what: WHAT,
      payee: YOU,
      maxDollars: 400_000_000n,
      shareBps: 250,
    }).data,
    "0xf799daeeabababababababababababababababababababababababababababababababab00000000000000000000000070997970c51812dc3a010c7d01b50e0d17dc79c80000000000000000000000000000000000000000000000000000000017d7840000000000000000000000000000000000000000000000000000000000000000fa",
  );
  // the same with the zero address: whoever takes it first, and the 5% most
  assert.equal(
    calls.announceTaskCall({
      treasury: TREASURY,
      what: WHAT.toUpperCase().replace("0X", "0x"),
      payee: null,
      maxDollars: 1_000_000n,
      shareBps: 500,
    }).data,
    "0xf799daeeabababababababababababababababababababababababababababababababab000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000f424000000000000000000000000000000000000000000000000000000000000001f4",
  );
  // cast calldata "takeTask(uint64,uint256)" 3 400000000
  assert.equal(
    calls.takeTaskCall({
      treasury: TREASURY,
      serial: 3n,
      minAmount: 400_000_000n,
    }).data,
    "0x6efda0f900000000000000000000000000000000000000000000000000000000000000030000000000000000000000000000000000000000000000000000000017d78400",
  );
  // cast calldata "acceptTask(uint64,uint256)" 3 240000000
  assert.equal(
    calls.acceptTaskCall({
      treasury: TREASURY,
      serial: 3n,
      payDollars: 240_000_000n,
    }).data,
    "0xa4e235c20000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000000e4e1c00",
  );
  // cast calldata "rejectTask(uint64)" 18446744073709551615 (the largest serial)
  assert.equal(
    calls.rejectTaskCall({
      treasury: TREASURY,
      serial: 18_446_744_073_709_551_615n,
    }).data,
    "0xbe99bca8000000000000000000000000000000000000000000000000ffffffffffffffff",
  );
  // cast calldata "cancelTask(uint64)" 7
  assert.equal(
    calls.cancelTaskCall({ treasury: TREASURY, serial: 7n }).data,
    "0x6190aab80000000000000000000000000000000000000000000000000000000000000007",
  );
  // cast calldata "returnTask(uint64)" 12
  assert.equal(
    calls.returnTaskCall({ treasury: TREASURY, serial: 12n }).data,
    "0x6c950913000000000000000000000000000000000000000000000000000000000000000c",
  );
  // cast calldata "claimNote(uint64,address)" 5 <YOU>
  assert.equal(
    calls.claimNoteCall({ treasury: TREASURY, serial: 5n, holder: YOU }).data,
    "0xa5826642000000000000000000000000000000000000000000000000000000000000000500000000000000000000000070997970c51812dc3a010c7d01b50e0d17dc79c8",
  );
});

test("every task call reads back to the arguments it was built with", () => {
  const announce = read(
    TREASURY_ABI,
    calls.announceTaskCall({
      treasury: TREASURY,
      what: WHAT,
      payee: YOU,
      maxDollars: 400_000_000n,
      shareBps: 250,
    }),
  );
  assert.deepEqual(
    [announce.name, ...announce.args],
    ["announceTask", WHAT, low(YOU), 400_000_000n, 250n],
  );
  const open = read(
    TREASURY_ABI,
    calls.announceTaskCall({
      treasury: TREASURY,
      what: WHAT,
      payee: null,
      maxDollars: 1_000_000n,
      shareBps: 1,
    }),
  );
  assert.equal(open.args[1], calls.ZERO_ADDRESS);
  const take = read(
    TREASURY_ABI,
    calls.takeTaskCall({ treasury: TREASURY, serial: 9n, minAmount: 5n }),
  );
  assert.deepEqual([take.name, ...take.args], ["takeTask", 9n, 5n]);
  const accept = read(
    TREASURY_ABI,
    calls.acceptTaskCall({ treasury: TREASURY, serial: 9n, payDollars: 6n }),
  );
  assert.deepEqual([accept.name, ...accept.args], ["acceptTask", 9n, 6n]);
});

test("acceptTask has no recipient: its calldata is the serial and the amount and nothing more", () => {
  const call = calls.acceptTaskCall({
    treasury: TREASURY,
    serial: 3n,
    payDollars: 5n,
  });
  // 4 bytes of selector and two words: the money goes to whoever took the task, and a call cannot name another.
  assert.equal((call.data.length - 2) / 2, 4 + 64);
});

test("a claim names exactly the holder it is given", () => {
  const mine = read(
    TREASURY_ABI,
    calls.claimNoteCall({ treasury: TREASURY, serial: 5n, holder: ME }),
  );
  assert.equal(mine.args[1], low(ME));
  const yours = read(
    TREASURY_ABI,
    calls.claimNoteCall({ treasury: TREASURY, serial: 5n, holder: YOU }),
  );
  assert.equal(yours.args[1], low(YOU));
  assert.notEqual(mine.args[1], yours.args[1]);
  assert.throws(
    () =>
      calls.claimNoteCall({ treasury: TREASURY, serial: 5n, holder: "0x12" }),
    /invalid address/,
  );
});

test("a bad task argument never becomes calldata", () => {
  const ok = { treasury: TREASURY, what: WHAT, payee: YOU, maxDollars: 1n };
  // the share: whole ten-thousandths from 1 to 500
  for (const shareBps of [0, 501, -1, 1.5, Number.NaN, 65_536]) {
    assert.throws(
      () => calls.announceTaskCall({ ...ok, shareBps }),
      /share/,
      String(shareBps),
    );
  }
  // the record's id: 32 bytes and not all zero
  for (const what of [
    "0x12",
    `0x${"00".repeat(32)}`,
    `0x${"zz".repeat(32)}`,
    "",
  ]) {
    assert.throws(
      () => calls.announceTaskCall({ ...ok, what, shareBps: 1 }),
      /32-byte/,
      what,
    );
  }
  // amounts: more than nothing, a bigint, at most a uint128
  for (const maxDollars of [0n, -1n, 1n << 128n, 5, "5"]) {
    assert.throws(
      () => calls.announceTaskCall({ ...ok, maxDollars, shareBps: 1 }),
      /more than nothing/,
    );
  }
  assert.throws(
    () => calls.takeTaskCall({ treasury: TREASURY, serial: 1n, minAmount: 0n }),
    /more than nothing/,
  );
  assert.throws(
    () =>
      calls.acceptTaskCall({ treasury: TREASURY, serial: 1n, payDollars: 0n }),
    /more than nothing/,
  );
  assert.throws(
    () =>
      calls.acceptTaskCall({ treasury: TREASURY, serial: 1n, payDollars: -5n }),
    /more than nothing/,
  );
  // serials: from 1, a uint64
  for (const serial of [0n, -1n, 1n << 64n, 3, "3"]) {
    for (const build of [
      calls.rejectTaskCall,
      calls.cancelTaskCall,
      calls.returnTaskCall,
    ]) {
      assert.throws(() => build({ treasury: TREASURY, serial }), /task number/);
    }
  }
  assert.throws(
    () => calls.announceTaskCall({ ...ok, payee: "0x12", shareBps: 1 }),
    /invalid address/,
  );
});

// --- Step 4: the holder pause and the earlier backers' claim ---------------------------------------------------------------

const PAUSE = "0x61Ef99673A65bee0512b8D1eb1AA656866D24296";
const SHARES = "0x5eb3Bc0a489C5A8288765d2336659EbCA68FCd00";
const CLAIMS = "0x0165878A594ca255338adfa4d48449f69242Eb8F";

test("park is approve then park, in that order, to the Shares and then the pause", () => {
  const list = calls.parkCalls({ shares: SHARES, pause: PAUSE, amount: 7n });
  assert.equal(list.length, 2);
  assert.equal(list[0].to, low(SHARES));
  assert.equal(list[1].to, low(PAUSE));
  // cast calldata "approve(address,uint256)" <pause> 7 ; cast calldata "park(uint256)" 7
  assert.match(list[0].data, /^0x095ea7b3/);
  assert.match(list[1].data, /^0x07afe492/); // cast sig "park(uint256)"
  const approve = read(SHARE_TOKEN_ABI, list[0]);
  assert.deepEqual(
    [approve.name, approve.args[0], approve.args[1]],
    ["approve", low(PAUSE), 7n],
  );
  const park = read(HOLDER_PAUSE_ABI, list[1]);
  assert.deepEqual([park.name, park.args[0]], ["park", 7n]);
});

test("unpark is one call with the amount", () => {
  const call = calls.unparkCall(PAUSE, 9n);
  assert.equal(call.to, low(PAUSE));
  assert.match(call.data, /^0xa32f1031/); // cast sig "unpark(uint256)"
  const found = read(HOLDER_PAUSE_ABI, call);
  assert.deepEqual([found.name, found.args[0]], ["unpark", 9n]);
});

test("a take-out of parked Shares is unpark FIRST, then leave of wallet plus parked", () => {
  const list = calls.takeOutWithParkedCalls({
    treasury: TREASURY,
    pause: PAUSE,
    walletShares: 5n,
    parkedShares: 3n,
    minCash: 11n,
    to: ME,
  });
  assert.equal(list.length, 2);
  assert.equal(read(HOLDER_PAUSE_ABI, list[0]).name, "unpark");
  assert.equal(read(HOLDER_PAUSE_ABI, list[0]).args[0], 3n);
  const leave = read(TREASURY_ABI, list[1]);
  assert.equal(leave.name, "leave");
  assert.deepEqual(leave.args, [8n, 11n, low(ME)]);
});

test("nothing parked is the plain leave and nothing else; parked Shares without a pause are refused", () => {
  const plain = calls.takeOutWithParkedCalls({
    treasury: TREASURY,
    pause: null,
    walletShares: 5n,
    parkedShares: 0n,
    minCash: 1n,
    to: ME,
  });
  assert.equal(plain.length, 1);
  assert.equal(read(TREASURY_ABI, plain[0]).name, "leave");
  assert.throws(() =>
    calls.takeOutWithParkedCalls({
      treasury: TREASURY,
      pause: null,
      walletShares: 5n,
      parkedShares: 1n,
      minCash: 1n,
      to: ME,
    }),
  );
});

test("the earlier claim carries the row, the proof and the text fingerprint", () => {
  const proof = [`0x${"01".repeat(32)}`, `0x${"02".repeat(32)}`];
  const call = calls.earlierClaimCall({
    contract: CLAIMS,
    index: 4n,
    amount: 10n ** 18n,
    proof,
    accepted: HASH,
  });
  assert.equal(call.to, low(CLAIMS));
  const found = read(EARLIER_GRANTS_ABI, call);
  assert.equal(found.name, "claim");
  assert.deepEqual(found.args, [4n, 10n ** 18n, proof, HASH]);
  // cast calldata "claim(uint256,uint256,bytes32[],bytes32)" 4 1e18 "[0x01..,0x02..]" 0xab..: byte for byte
  assert.equal(
    call.data,
    `0x60dc1175${"04".padStart(64, "0")}${"0de0b6b3a7640000".padStart(64, "0")}${"80".padStart(64, "0")}${"ab".repeat(32)}${"02".padStart(64, "0")}${"01".repeat(32)}${"02".repeat(32)}`,
  );
  // an empty proof (a one-row list) is a call too; a bad hash never becomes calldata
  const one = calls.earlierClaimCall({
    contract: CLAIMS,
    index: 0n,
    amount: 10n ** 18n,
    proof: [],
    accepted: HASH,
  });
  assert.deepEqual(read(EARLIER_GRANTS_ABI, one).args[2], []);
  assert.throws(() =>
    calls.earlierClaimCall({
      contract: CLAIMS,
      index: 0n,
      amount: 1n,
      proof: ["0x12"],
      accepted: HASH,
    }),
  );
});
