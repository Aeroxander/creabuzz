/**
 * Seam-consistency tests for the launchpad `evm_*` IPC contract.
 *
 * The wire contract has two production ends: `desktop/src-tauri/src/commands/
 * wallet.rs` (serde `camelCase` structs + `#[tauri::command]` signatures) and
 * the TypeScript hook modules that `invokeTauri` it. This suite parses BOTH
 * real source files and checks each against the pinned contract below, so a
 * rename on either side (or an invoke call passing a field the Rust command
 * does not accept) fails here instead of at runtime.
 *
 * Falsifiability: delete a field from a wire struct, rename `gasUsed`, add an
 * invoke argument named `rpc_url`, or emit a decimal `value` from a call
 * builder and this suite goes red — it reads the production files and the
 * production encoders, not test copies.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildBidCalls,
  buildExitBidCall,
  buildGraduationCall,
  buildTokenDeployCalls,
  CANONICAL_TRANSFER_VALIDATOR,
  PERMIT2_ADDRESS,
  ZERO_ADDRESS,
} from "./evmCalls.ts";

// ---------------------------------------------------------------------------
// The pinned wire contract (camelCase on the wire; serde rename_all in
// wallet.rs). Update this pin CONSCIOUSLY when the wire changes — the point is
// that a wire change cannot land silently on one side only.
// ---------------------------------------------------------------------------

/** Reply struct field names per Rust wire struct. */
const WIRE_REPLIES = {
  EvmWalletStatus: ["hasWallet", "address"],
  EvmWalletAddress: ["address"],
  EvmChainStatus: ["chainId"],
  EvmCallResult: ["returnData"],
  EvmSendResult: [
    "txHash",
    "status",
    "blockNumber",
    "gasUsed",
    "contractAddress",
  ],
  EvmFindBidIdsResult: ["bidIds"],
};

/** Command argument names per `#[tauri::command]` (empty = no arguments). */
const WIRE_COMMANDS = {
  evm_wallet_status: [],
  evm_wallet_create: [],
  evm_wallet_import: ["privateKeyHex"],
  evm_chain_status: ["rpcUrl"],
  evm_call: ["rpcUrl", "to", "data"],
  evm_send_transaction: [
    "rpcUrl",
    "chainId",
    "to",
    "data",
    "value",
    "gasLimit",
  ],
  evm_find_bid_ids: ["rpcUrl", "auction", "owner"],
};

/** TS declarations that must mirror each Rust reply struct, field for field. */
const TS_REPLY_SOURCES = {
  EvmWalletStatus: [["../walletHooks.ts", "EvmWalletStatus"]],
  EvmWalletAddress: [["../walletHooks.ts", "EvmWalletAddress"]],
  EvmChainStatus: [["../walletHooks.ts", "EvmChainStatus"]],
  EvmCallResult: [
    ["../mintHooks.ts", "EvmCallResult"],
    ["../auctionHooks.ts", "EvmCallResult"],
  ],
  EvmSendResult: [
    ["./mintFlow.ts", "MintTxReceipt"],
    ["./auctionFlow.ts", "AuctionTxReceipt"],
  ],
  // `EvmFindBidIdsResult` has no TS declaration left on desktop (bidder
  // money reads moved to the web money plane; the Rust shape is still
  // pinned above so the wire command cannot drift silently).
};

/** Every TS module allowed to talk to the `evm_*` commands directly. */
const IPC_MODULES = [
  "../walletHooks.ts",
  "../mintHooks.ts",
  "../auctionHooks.ts",
];

const RUST_WALLET_RS = "../../../../src-tauri/src/commands/wallet.rs";

// ---------------------------------------------------------------------------
// Source parsing (both sides of the seam)
// ---------------------------------------------------------------------------

function readSource(relativePath) {
  return readFileSync(
    fileURLToPath(new URL(relativePath, import.meta.url)),
    "utf8",
  );
}

/** `has_wallet` -> `hasWallet` (serde `rename_all = "camelCase"`). */
function snakeToCamel(name) {
  return name.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

/** camelCase field names of every `pub struct` in wallet.rs. */
function parseRustStructs(source) {
  const structs = {};
  for (const match of source.matchAll(/pub struct (\w+)\s*\{([^}]*)\}/g)) {
    const fields = [...match[2].matchAll(/pub (\w+)\s*:/g)].map((f) =>
      snakeToCamel(f[1]),
    );
    structs[match[1]] = fields;
  }
  return structs;
}

/** camelCase parameter names of every `pub async fn` command in wallet.rs. */
function parseRustCommands(source) {
  const commands = {};
  for (const match of source.matchAll(/pub async fn (\w+)\s*\(([^)]*)\)/g)) {
    const params = [...match[2].matchAll(/(\w+)\s*:/g)].map((p) =>
      snakeToCamel(p[1]),
    );
    commands[match[1]] = params;
  }
  return commands;
}

/** Field names of `interface N { ... }` / `type N = { ... }` declarations. */
function parseTsShapes(source) {
  const shapes = {};
  for (const match of source.matchAll(
    /(?:export\s+)?(?:interface|type) (\w+)(?:\s*=\s*)?\s*\{([^}]*)\}/g,
  )) {
    const fields = [...match[2].matchAll(/^\s*(\w+)\??\s*:/gm)].map(
      (f) => f[1],
    );
    shapes[match[1]] = fields;
  }
  return shapes;
}

/**
 * Every `invokeTauri("command", ...)` call site with its argument-key source:
 * an object literal's keys, a `...spread` of the named `args` parameter, or
 * the `const args: {...}` annotation `makeAuctionEffects` builds.
 */
function parseInvokeCallSites(source, label) {
  const sites = [];
  for (const match of source.matchAll(
    /invokeTauri(?:<[^<>]*>)?\(\s*"([a-z_]+)"\s*(?:,\s*([\s\S]*?))?\)/g,
  )) {
    const [full, command, rawArgs] = match;
    const body = (rawArgs ?? "").trim();
    let keys;
    const spread = /^\{?\s*\.\.\.(\w+)\s*\}?$/.exec(body);
    if (body === "") {
      keys = [];
    } else if (spread) {
      // A `{ ...args }` spread hides the wire surface. The one pinned shape
      // (`EvmSendArgs`, the deleted bidder-money bidHooks) is gone with the
      // money plane; pass an object literal or an annotated `const args`.
      assert.fail(
        `${label}: spread argument \`${spread[1]}\` has no pinned shape`,
      );
    } else if (body.startsWith("{")) {
      keys = objectLiteralKeys(body);
    } else if (/^\w+$/.test(body)) {
      keys = { substitute: `const ${body}` };
    } else {
      assert.fail(
        `${label}: unrecognized invokeTauri argument form for ${command}: ${full}`,
      );
    }
    sites.push({ command, keys });
  }
  return sites;
}

function objectLiteralKeys(literal) {
  const inner = literal.replace(/^\{/, "").replace(/\}$/, "");
  const keys = [];
  for (const part of inner.split(",")) {
    const trimmed = part.trim();
    if (trimmed === "") continue;
    const key = /^([A-Za-z_$][\w$]*)\s*(?::|,|$)/.exec(trimmed);
    if (key) keys.push(key[1]);
    else
      assert.fail(
        `unrecognized object-literal part in invokeTauri args: ${part}`,
      );
  }
  return keys;
}

/** Field keys of `const <name>: { ... } = { ... }` (auctionHooks' send args). */
function parseAnnotatedArgs(source, name) {
  const match = new RegExp(`const ${name}: \\{([^}]*)\\}`).exec(source);
  assert.ok(match, `expected an annotated \`${name}: {...}\` declaration`);
  return [...match[1].matchAll(/^\s*(\w+)\??\s*:/gm)].map((f) => f[1]);
}

const rustSource = readSource(RUST_WALLET_RS);
const tsSources = new Map(IPC_MODULES.map((p) => [p, readSource(p)]));
const tsShapes = new Map(
  IPC_MODULES.concat(["./mintFlow.ts", "./auctionFlow.ts"]).map((p) => [
    p,
    parseTsShapes(readSource(p)),
  ]),
);

// ---------------------------------------------------------------------------
// 1. Reply shapes: Rust wire structs == pinned == TS declarations
// ---------------------------------------------------------------------------

test("wallet.rs wire reply structs match the pinned camelCase shapes", () => {
  const structs = parseRustStructs(rustSource);
  for (const [name, fields] of Object.entries(WIRE_REPLIES)) {
    assert.ok(structs[name], `wallet.rs is missing wire struct ${name}`);
    assert.deepEqual(
      [...structs[name]].sort(),
      [...fields].sort(),
      `wallet.rs ${name} fields drifted from the wire pin`,
    );
  }
  assert.deepEqual(
    Object.keys(structs).sort(),
    Object.keys(WIRE_REPLIES).sort(),
    "wallet.rs wire structs were added or removed — update the pin deliberately",
  );
});

test("TS reply declarations mirror the Rust wire structs field for field", () => {
  for (const [wireName, members] of Object.entries(TS_REPLY_SOURCES)) {
    const pinned = [...WIRE_REPLIES[wireName]].sort();
    for (const [file, typeName] of members) {
      const shape = tsShapes.get(file)?.[typeName];
      assert.ok(shape, `${file} is missing shape ${typeName}`);
      assert.deepEqual(
        [...shape].sort(),
        pinned,
        `${file} ${typeName} drifted from wire struct ${wireName}`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 2. Command arguments: Rust params == pinned == every invoke call site
// ---------------------------------------------------------------------------

test("wallet.rs command parameters match the pinned wire arguments", () => {
  const commands = parseRustCommands(rustSource);
  for (const [name, params] of Object.entries(WIRE_COMMANDS)) {
    assert.ok(commands[name], `wallet.rs is missing command ${name}`);
    assert.deepEqual(
      [...commands[name]].sort(),
      [...params].sort(),
      `wallet.rs ${name} parameters drifted from the wire pin`,
    );
  }
});

test("every invokeTauri call site passes only wire-valid argument names", () => {
  let sawSendTransaction = false;
  for (const [file, source] of tsSources) {
    for (const site of parseInvokeCallSites(source, file)) {
      const allowed = WIRE_COMMANDS[site.command];
      assert.ok(
        allowed,
        `${file} invokes unknown command ${site.command} — is it in wallet.rs?`,
      );
      let keys = site.keys;
      if (typeof keys.substitute === "string") {
        const name = keys.substitute.replace(/^const /, "");
        keys = parseAnnotatedArgs(source, name);
        sawSendTransaction = true;
      }
      for (const key of keys) {
        assert.ok(
          allowed.includes(key),
          `${file} passes ${site.command}.${key}, which the Rust command does not accept`,
        );
      }
    }
  }
  assert.ok(
    sawSendTransaction,
    "no evm_send_transaction call site was checked",
  );
});

// ---------------------------------------------------------------------------
// 3. Call-shape formats: hex quantities from the production encoders
// ---------------------------------------------------------------------------

const HEX_QUANTITY = /^0x(0|[1-9a-f][0-9a-f]*)$/;
const HEX_DATA = /^0x([0-9a-f][0-9a-f])*$/i;
const HEX_ADDRESS = /^0x[0-9a-f]{40}$/i;

function assertCallShapes(label, calls) {
  assert.ok(calls.length > 0, `${label}: expected at least one call`);
  for (const call of calls) {
    assert.match(
      call.value ?? "",
      HEX_QUANTITY,
      `${label}: value must be a canonical hex quantity`,
    );
    assert.match(call.data, HEX_DATA, `${label}: data must be 0x hex`);
    assert.match(call.to, HEX_ADDRESS, `${label}: to must be a 0x address`);
  }
}

test("call builders emit hex quantities and plain addresses (wire formats)", () => {
  const plan = {
    maxPriceQ96: 2n ** 96n,
    amount: 1_000_000n,
    owner: "0x1111111111111111111111111111111111111111",
    prevTickPriceQ96: 2n ** 96n,
    hookData: "0x",
  };
  assertCallShapes(
    "buildBidCalls (ERC-20)",
    buildBidCalls({
      auction: "0x2222222222222222222222222222222222222222",
      currency: "0x3333333333333333333333333333333333333333",
      plan,
      needsUnderlyingAllowance: true,
      permit2Deadline: 2n ** 47n,
    }),
  );
  assertCallShapes(
    "buildBidCalls (native)",
    buildBidCalls({
      auction: "0x2222222222222222222222222222222222222222",
      currency: ZERO_ADDRESS,
      plan,
      needsUnderlyingAllowance: false,
      permit2Deadline: 2n ** 47n,
    }),
  );
  assertCallShapes(
    "buildTokenDeployCalls",
    buildTokenDeployCalls({
      name: "Nebula",
      symbol: "NEB",
      treasury: "0x1111111111111111111111111111111111111111",
      tokenAddress: "0x4444444444444444444444444444444444444444",
    }),
  );
  assertCallShapes("buildExitBidCall", [
    buildExitBidCall("0x2222222222222222222222222222222222222222", 7n),
  ]);
  assertCallShapes("buildGraduationCall", [
    buildGraduationCall(
      "0x5555555555555555555555555555555555555555",
      "0x2222222222222222222222222222222222222222",
    ),
  ]);
});

test("known constant addresses survive round-trips through the seam", () => {
  // Guards the addresses the wire docs and dogfood script pin.
  assert.equal(
    PERMIT2_ADDRESS.toLowerCase(),
    "0x000000000022d473030f116ddee9f6b43ac78ba3",
  );
  assert.equal(
    CANONICAL_TRANSFER_VALIDATOR.toLowerCase(),
    "0x721c008fdff27bf06e7e123956e2fe03b63342e3",
  );
});

// ---------------------------------------------------------------------------
// 4. Encoder ownership: exactly one ABI encoder in the launchpad surface
// ---------------------------------------------------------------------------

test("no launchpad module re-implements the ABI encoder", async () => {
  const { readdirSync } = await import("node:fs");
  const dir = fileURLToPath(new URL("..", import.meta.url));
  const files = readdirSync(dir, { recursive: true })
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .filter((f) => !f.includes(".test."));
  const offenders = [];
  for (const file of files) {
    const source = readSource(`../${file}`);
    if (
      /(?:^|\s)function (?:selectorOf|encodeFunctionData|encodeParameters)\s*\(/m.test(
        source,
      )
    ) {
      offenders.push(file);
    }
  }
  assert.deepEqual(
    offenders.filter((f) => f.replace(/\\/g, "/") !== "lib/evmCalls.ts"),
    [],
    "ABI encoding must be consumed from lib/evmCalls.ts, not re-implemented",
  );
});
