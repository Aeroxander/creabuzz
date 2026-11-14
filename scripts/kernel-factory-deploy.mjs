#!/usr/bin/env node
/**
 * Kernel factory deploy (wave 4d): deploy the vendored v0.4.0 Kernel stack
 * (`contracts/lib/zerodev-kernel/releases/v0.4.0.json`) wired to EntryPoint
 * v0.8.0 on Sepolia — each contract ONE sponsored UserOperation (gasless,
 * paymaster-funded) from the fixture Kernel account — then verify everything
 * on-chain.
 *
 * Run under the repo's Hermit toolchain (node ≥ 22.18 strips TS types):
 *   . ./bin/activate-hermit && node scripts/kernel-factory-deploy.mjs
 *   … --dry-run     # derivation + chain probes only, no broadcast
 *   … --no-stretch  # skip the optional v0.8 end-to-end UserOp
 *
 * Credentials come from the repo-root `.env` at runtime (ZERODEV_PROJECT_ID,
 * ZERODEV_API_KEY, SEPOLIA_RPC_URL) and are MASKED in all output. Nothing
 * secret is committed or printed (hard rule).
 *
 * What runs (every value re-derived before broadcast):
 *
 * STEP 0 — derivation gate. The CREATE2 formula (0xff ‖ deterministic
 *   deployer 0x4e59b44847b379578588920cA78FbF26c0B4956C ‖ zero salt ‖
 *   keccak(init_code)) is validated against ALL FIVE manifest
 *   `expected_address` values (the manifest's own v0.9-wired init_codes);
 *   any mismatch ABORTS before anything is signed. The v0.8-adapted
 *   init_codes are then derived with the same validated function:
 *   `init_code = <manifest bytecode field> ‖ abi.encode(adapted ctor args)`
 *   (EntryPoint v0.8.0 = 0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108).
 *   Deploy order (KernelFactory's constructor requires both impls to have
 *   code — `ImplementationNotDeployed` guard, src/KernelFactory.sol:19-23):
 *     1. KernelUUPS(entryPoint=v0.8)           → 0x8132a01e998235bf4c5de163b59aa4edd9a1fb99
 *     2. KernelImmutableECDSA(entryPoint=v0.8) → 0x953bd852f7484342b730e40d051579ff9d7cca1c
 *     3. KernelFactory(impl1, impl2)           → 0xa85d8816dab8c0d1a59cd0d04b1c2f43609d1319
 *   (`Kernel7702` and `Staker` are NOT required by the factory — skipped.)
 *
 * STEP 1 — deployment. Each contract = ONE call from the sponsored fixture
 *   Kernel account 0xd6b93cedda0d95145b822f44108ef13e41e9aa39 (derived from
 *   the pinned fixture P-256 key of contracts/test/kernel-sign.mjs; the
 *   ceremony is injected through kernel033's `getAssertion` seam exactly as
 *   scripts/kernel033-live-check.mjs does — TEST-ONLY fixture ceremony).
 *   callData = `execute(bytes32(0), deployer ‖ uint256(0) ‖ (zero salt ‖
 *   init_code))` — one CALL to the deterministic deployer
 *   (`LibERC7579.decodeSingle` = `target20 ‖ value32 ‖ raw data`,
 *   dependencies/solady-0.1.26/src/accounts/LibERC7579.sol:81-97).
 *   Idempotent: a contract already at its predicted address is skipped
 *   (wiring verified first). Before sponsoring, the exact calldata is
 *   dry-run via `eth_call` from the account itself (validates the decode
 *   layout + the inner CREATE2 without spending sponsorship). Server-side
 *   gas estimation first (zd_sponsorUserOperation); on an estimation/gas
 *   block the documented manual path (`gas` → `manualGasEstimation: true`)
 *   is tried ONCE with generous-but-bounded limits; policy denials exit 2
 *   with the raw server text (Rule 1).
 *
 * STEP 2 — verification (the acceptance). Per contract: `eth_getCode` at
 *   the predicted address. For the impls the EntryPoint wiring is checked
 *   BEHAVIORALLY: v0.4.0's `ENTRYPOINT` immutable is NOT public
 *   (src/Kernel.sol:64 — no getter exists), so `execute(...)` is probed via
 *   `eth_call` from EntryPoint v0.8 (must SUCCEED — `_onlyEntryPointOrSelf`,
 *   Kernel.sol:66-68), from EntryPoint v0.7 and from the fixture account
 *   (both must REVERT). Success-from-v0.8 + revert-from-everywhere proves
 *   the immutable IS v0.8. Factory: `UUPS()` / `IMMUTABLE_ECDSA()` getters
 *   must equal the two predicted impls, plus `getAddress` sanity calls.
 *
 * STEP 3 — optional stretch: ONE sponsored UserOp through a freshly
 *   created v0.4.0 Kernel account (aa-kernel.ts `buildKernelInitCode` +
 *   EntryPoint v0.8.0 EIP-712 `getUserOpHash` from userop.ts — the
 *   forge-proven wave-4b core), root validator = the deployed
 *   WebAuthnValidator V0_0_3_PATCHED (its signature tuple and onInstall
 *   data are byte-compatible with the vendored master the core was proven
 *   against; the vendored-master validator itself is NOT deployed on
 *   Sepolia and is outside this run's sanctioned deploy list). Signed by
 *   the fixture ceremony; the v0.8 hash is byte-checked against the LIVE
 *   EntryPoint v0.8 before signing (never sign the wrong bytes).
 */
import { createHash, createPrivateKey, sign as ecdsaSign } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  KERNEL_EXECUTE_SIGNATURE,
  KERNEL_GET_ADDRESS_SIGNATURE,
  buildKernelInitCode,
  buildKernelSelfCallData,
  getSenderFromKernelFactory,
  webAuthnValidatorInstall,
} from "../web/src/features/identity/lib/aa-kernel.ts";
import {
  OFFICIAL_STUB_SIGNATURE,
  WEB_AUTHN_VALIDATOR_V0_0_3_PATCHED,
  assertHashMatchesEntryPoint,
  buildKernel033InitCode,
  createKernel033ChainRpc,
  getKernel033Sender,
  sendKernel033UserOp,
  signKernel033UserOp,
  userOpHashCalldataV07,
} from "../web/src/features/identity/lib/kernel033.ts";
import { b64urlEncode } from "../web/src/features/identity/lib/passkey.ts";
import {
  abiEncode,
  abiEncodeCall,
  decodeAddressWord,
  functionSelector,
  hexToBytes,
} from "../web/src/features/identity/lib/userop-abi.ts";
import { getUserOpHash, keccak256 } from "../web/src/features/identity/lib/userop.ts";
import {
  ENTRY_POINT_V0_7,
  ENTRY_POINT_V0_8,
  PaymasterDeniedError,
  sendSponsoredUserOp,
} from "../web/src/features/identity/lib/zerodev.ts";

// ---------------------------------------------------------------- env ----

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const env = {
  ...parseDotEnv(path.resolve(scriptDir, "..", ".env")),
  ...process.env,
};

function parseDotEnv(file) {
  const out = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (match) out[match[1]] = match[2].replace(/^"|"$/g, "");
  }
  return out;
}

/** Never print secrets — presence only, masked (`…abcd`). */
function mask(secret) {
  if (secret === undefined || secret === "") return "(unset)";
  return `…${secret.slice(-4)}`;
}

const ZERODEV_PROJECT_ID = env.ZERODEV_PROJECT_ID;
const ZERODEV_API_KEY = env.ZERODEV_API_KEY;
const CHAIN_RPC_URL =
  env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
const CHAIN_ID = 11155111;
const GWEI = 10n ** 9n;

const out = (line = "") => console.log(line);
const step = (n, line) => out(`\n[${n}] ${line}`);

const DRY_RUN = process.argv.includes("--dry-run");
const NO_STRETCH = process.argv.includes("--no-stretch");

// ------------------------------------------------- fixed addresses -------

/** Arachnid deterministic CREATE2 deployer (code live on Sepolia). */
const DETERMINISTIC_DEPLOYER = "0x4e59b44847b379578588920cA78FbF26c0B4956C";
/** The manifest's create2 salt — 32 zero bytes. */
const CREATE2_SALT = `0x${"00".repeat(32)}`;
/** EntryPoint v0.8.0 (canonical; live `eth_supportedEntryPoints`). */
const ENTRY_POINT_V08 = ENTRY_POINT_V0_8;
/**
 * The sponsored fixture Kernel account (kernel-0.3.3 stack, fixture P-256
 * passkey of contracts/test/kernel-sign.mjs). Re-derived from the factory's
 * `getAddress` and ASSERTED equal below.
 */
const FIXTURE_ACCOUNT = "0xd6b93cedda0d95145b822f44108ef13e41e9aa39";
/** Prior off-chain derivation (the wave-4d plan) — cross-checked, not trusted. */
const PRIOR_PREDICTIONS = {
  KernelUUPS: "0x8132a01e998235bf4c5de163b59aa4edd9a1fb99",
  KernelImmutableECDSA: "0x953bd852f7484342b730e40d051579ff9d7cca1c",
  KernelFactory: "0xa85d8816dab8c0d1a59cd0d04b1c2f43609d1319",
};
/**
 * Manual-gas fallback (Rule 4 — generous but bounded): 10M call (the two
 * big impls cost ~5-7M gas to deploy), 1.5M verification (WebAuthn sim),
 * 100K preVerification. Sent with `manualGasEstimation: true`.
 */
const MANUAL_GAS = {
  verificationGasLimit: "0x16e360",
  callGasLimit: "0x989680",
  preVerificationGas: "0x186a0",
};
/** Receipt polling bounds (Rule 4). */
const RECEIPT_BOUNDS = { pollIntervalMs: 2000, maxPolls: 90 };
/** EIP-3860 initcode ceiling (bytes) — asserted, never approached blind. */
const MAX_INITCODE_BYTES = 49152;

const ZERO_WORD = `0x${"00".repeat(32)}`;

// ------------------------------------------------------------- JSON-RPC ---

async function chainRpc(method, params) {
  const response = await fetch(CHAIN_RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const payload = await response.json();
  if (payload.error !== undefined) {
    throw new Error(`chain RPC ${method}: ${payload.error.message}`);
  }
  return payload.result;
}

const getCode = (address) => chainRpc("eth_getCode", [address, "latest"]);

/** `eth_call` that never throws — returns `{ok, result|error}` (probe use). */
async function tryEthCall(tx) {
  try {
    const result = await chainRpc("eth_call", [tx, "latest"]);
    return { ok: true, result };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

// ------------------------------------------------- fixture P-256 signer ---
// Provenance: contracts/test/kernel-sign.mjs (the pinned JWK fixture signer
// behind the in-repo forge proof; obviously-fake/test-only key).

const FIXTURE_JWK = {
  kty: "EC",
  x: "BqjPovesWJOn2eU86PyU1j9LVKlpvYN2w5KCEzAus2Y",
  y: "Ii_D2wwf1j9Rb0hDdPZvMCEM57JNbv48Uk62463QVG4",
  crv: "P-256",
  d: "T4FCxtt1hQgHJSwFv78_S0LGYtVvt73h7-RikHaQ_G8",
};
const fixtureKey = createPrivateKey({ key: FIXTURE_JWK, format: "jwk" });
const fixturePub = {
  x: BigInt(`0x${Buffer.from(FIXTURE_JWK.x, "base64url").toString("hex")}`),
  y: BigInt(`0x${Buffer.from(FIXTURE_JWK.y, "base64url").toString("hex")}`),
};

/**
 * The `PasskeyAssertionSource` seam (TEST-ONLY): a WebAuthn assertion over
 * the RECEIVED CHALLENGE (the op hash bytes) — byte-for-byte the
 * forge-proven construction (contracts/test/KernelWebAuthnUserOp.t.sol):
 * authenticatorData = sha256("localhost") ‖ flags(0x05) ‖ signCount(0);
 * canonical clientDataJSON (`"challenge":"` at byte 23); ES256 covers
 * sha256(authenticatorData ‖ sha256(clientDataJSON)). The DER → low-s r‖s →
 * tuple wrap is the PRODUCTION composition under test.
 */
function fixtureAssertionSource({ credentialId, challenge }) {
  const authenticatorData = Buffer.concat([
    createHash("sha256").update("localhost").digest(),
    Buffer.from([0x05]),
    Buffer.alloc(4),
  ]);
  const clientDataJSON = `{"type":"webauthn.get","challenge":"${b64urlEncode(
    challenge,
  )}","origin":"https://example.com","crossOrigin":false}`;
  const message = Buffer.concat([
    authenticatorData,
    createHash("sha256").update(clientDataJSON).digest(),
  ]);
  const der = ecdsaSign("sha256", message, fixtureKey);
  return Promise.resolve({
    credentialId,
    signature: new Uint8Array(der),
    authenticatorData: new Uint8Array(authenticatorData),
    clientDataJSON: new TextEncoder().encode(clientDataJSON),
  });
}

// ------------------------------------------------------ CREATE2 core ------

function requireHexEven(value, what) {
  const body = value.startsWith("0x") ? value.slice(2) : value;
  if (!/^[0-9a-fA-F]*$/.test(body) || body.length % 2 !== 0) {
    throw new Error(`kernel-factory-deploy: ${what} is not even-length hex`);
  }
  return body.toLowerCase();
}

function word32(value) {
  return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
}

/**
 * CREATE2 address = keccak256(0xff ‖ deployer ‖ salt ‖ keccak256(init_code))
 * …[12:]. The keccak comes from userop.ts (the production hash port).
 */
function create2Address(initCode) {
  const body = requireHexEven(initCode, "init_code");
  // Preimage hex = "0x" ‖ "ff" ‖ deployer(20 raw bytes) ‖ salt(32) ‖
  // keccak(init_code) — the "0x" is the hex prefix, the "ff" byte is the
  // CREATE2 tag. The deployer is RAW 20 bytes here, NOT an ABI word.
  const preimage = `0xff${requireHexEven(DETERMINISTIC_DEPLOYER, "deployer")}${CREATE2_SALT.slice(
    2,
  )}${keccak256(`0x${body}`).slice(2)}`;
  return `0x${keccak256(preimage).slice(26)}`;
}

/** init_code = manifest bytecode ‖ abi.encode(constructor args). */
function buildInitCode(contract, args) {
  const bytecode = requireHexEven(contract.bytecode, `${contract.name} bytecode`);
  const encodedArgs = requireHexEven(
    abiEncode(args.map((value) => ({ kind: "address", value }))),
    `${contract.name} ctor args`,
  );
  const initCode = `0x${bytecode}${encodedArgs}`;
  const bytes = (initCode.length - 2) / 2;
  if (bytes > MAX_INITCODE_BYTES) {
    throw new Error(
      `kernel-factory-deploy: ${contract.name} init_code ${bytes} bytes exceeds EIP-3860 ${MAX_INITCODE_BYTES}`,
    );
  }
  return initCode;
}

/**
 * The ONE sponsored call: `execute(bytes32(0), deployer ‖ uint256(0) ‖
 * (zero salt ‖ init_code))` — a single CALL to the deterministic deployer
 * (`decodeSingle` layout: target20 ‖ value32 ‖ raw data).
 */
function buildDeployCallData(initCode) {
  const deployerCalldata = `${CREATE2_SALT.slice(2)}${requireHexEven(initCode, "init_code")}`;
  // decodeSingle layout: target = 20 RAW bytes ‖ value = 32 bytes ‖ raw data.
  const executionData = `${requireHexEven(DETERMINISTIC_DEPLOYER, "deployer")}${word32(0n).slice(
    2,
  )}${deployerCalldata}`;
  return abiEncodeCall(KERNEL_EXECUTE_SIGNATURE, [
    { kind: "bytes32", value: ZERO_WORD },
    { kind: "bytes", value: `0x${executionData}` },
  ]);
}

// ---------------------------------------------------- wiring probes -------

/**
 * v0.4.0 exposes NO `entrypoint()` getter (`IEntryPoint immutable
 * ENTRYPOINT` — src/Kernel.sol:64, not public), so the wiring is proven
 * BEHAVIORALLY: `execute` is `_onlyEntryPointOrSelf` (Kernel.sol:66-68,
 * 218-219). A call from EntryPoint v0.8 must succeed; the identical call
 * from any other address must revert `Unauthorized()`.
 */
function implWiringProbe() {
  // Inner call to address(0) with empty data + zero value — always succeeds.
  return abiEncodeCall(KERNEL_EXECUTE_SIGNATURE, [
    { kind: "bytes32", value: ZERO_WORD },
    { kind: "bytes", value: `0x${"00".repeat(20)}${word32(0n).slice(2)}` },
  ]);
}

async function verifyImplWiring(impl) {
  const data = implWiringProbe();
  const probes = [
    ["entryPoint v0.8 (must SUCCEED)", ENTRY_POINT_V08],
    ["entryPoint v0.7 (must REVERT)", ENTRY_POINT_V0_7],
    ["fixture account (must REVERT)", FIXTURE_ACCOUNT],
  ];
  let wired = true;
  for (const [label, from] of probes) {
    const result = await tryEthCall({ from, to: impl, data });
    const expectSuccess = label.includes("must SUCCEED");
    const pass = result.ok === expectSuccess;
    if (!pass) wired = false;
    out(
      `      probe ${pass ? "OK  " : "FAIL"} ${label}: ${
        result.ok ? `success (${result.result})` : `revert (${result.error})`
      }`,
    );
  }
  // Informational: source says no getter exists; show the live outcome.
  for (const getter of ["entrypoint()", "ENTRYPOINT()"]) {
    const result = await tryEthCall({
      to: impl,
      data: functionSelector(getter),
    });
    out(
      `      getter ${getter}: ${
        result.ok ? `success (${result.result})` : `revert (${result.error})`
      }  (informational — v0.4.0 declares no getter)`,
    );
  }
  return wired;
}

async function verifyFactoryWiring(factory, impl1, impl2) {
  const uups = await tryEthCall({
    to: factory,
    data: functionSelector("UUPS()"),
  });
  const ecdsa = await tryEthCall({
    to: factory,
    data: functionSelector("IMMUTABLE_ECDSA()"),
  });
  const uupsAddr = uups.ok ? decodeAddressWord(uups.result) : "(revert)";
  const ecdsaAddr = ecdsa.ok ? decodeAddressWord(ecdsa.result) : "(revert)";
  out(`      UUPS()            ${uupsAddr}   expect ${impl1}`);
  out(`      IMMUTABLE_ECDSA() ${ecdsaAddr}   expect ${impl2}`);
  return (
    uups.ok &&
    ecdsa.ok &&
    uupsAddr.toLowerCase() === impl1.toLowerCase() &&
    ecdsaAddr.toLowerCase() === impl2.toLowerCase()
  );
}

// ---------------------------------------------------------- helpers -------

function word32Of(value) {
  return word32(BigInt(value));
}

async function defaultFees() {
  const block = await chainRpc("eth_getBlockByNumber", ["latest", false]);
  const baseFee = BigInt(block.baseFeePerGas ?? "0x0");
  return {
    maxFeePerGas: word32(baseFee * 3n + 2n * GWEI),
    maxPriorityFeePerGas: word32(GWEI),
  };
}

/** Estimation/gas blocks (NOT policy denials) — one manual retry allowed. */
function looksLikeGasBlock(message) {
  return /gas|limit|estimat|overshot|OOG|out of|AA4\d|AA5\d/i.test(message);
}

// ------------------------------------------------------------- main ------

async function main() {
  out("Kernel factory deploy — Sepolia (wave 4d): vendored v0.4.0 wired to EntryPoint v0.8");
  out(
    `  project  …${(ZERODEV_PROJECT_ID ?? "").slice(-4)}   api key ${mask(
      ZERODEV_API_KEY,
    )}   chain rpc host ${new URL(CHAIN_RPC_URL).host}`,
  );
  out(`  mode     ${DRY_RUN ? "DRY RUN (no broadcast)" : "live"}${NO_STRETCH ? "  (stretch disabled)" : ""}`);

  // ---------------------------------------- STEP 0: derivation gate ------
  step("0", "derivation gate — CREATE2 formula + v0.8-adapted predictions");
  const manifest = JSON.parse(
    readFileSync(
      path.resolve(
        scriptDir,
        "..",
        "contracts/lib/zerodev-kernel/releases/v0.4.0.json",
      ),
      "utf8",
    ),
  );
  out(
    `  manifest ${manifest.version}  deployer ${manifest.create2.factory}  salt ${manifest.create2.salt}`,
  );
  if (manifest.create2.factory.toLowerCase() !== DETERMINISTIC_DEPLOYER.toLowerCase()) {
    throw new Error("kernel-factory-deploy: manifest deployer differs from the pinned deployer");
  }
  if (manifest.create2.salt.toLowerCase() !== CREATE2_SALT.toLowerCase()) {
    throw new Error("kernel-factory-deploy: manifest salt differs from the pinned zero salt");
  }
  const byName = Object.fromEntries(
    manifest.contracts.map((c) => [c.name, c]),
  );
  out("  formula validation — derive(manifest init_code) == manifest expected_address:");
  let formulaOk = true;
  for (const c of manifest.contracts) {
    const derived = create2Address(c.init_code);
    const ok = derived.toLowerCase() === c.expected_address.toLowerCase();
    if (!ok) formulaOk = false;
    out(`    ${ok ? "OK  " : "FAIL"} ${c.name.padEnd(22)} ${derived}${ok ? "" : `  manifest ${c.expected_address}`}`);
  }
  if (!formulaOk) {
    throw new Error(
      "kernel-factory-deploy: CREATE2 formula does not reproduce the manifest — refusing to broadcast",
    );
  }
  out("  formula reproduces ALL manifest expected addresses — derivation trusted.");

  // v0.8-adapted init_codes + predictions.
  const uupsInit = buildInitCode(byName.KernelUUPS, [ENTRY_POINT_V08]);
  const ecdsaInit = buildInitCode(byName.KernelImmutableECDSA, [ENTRY_POINT_V08]);
  const uupsAddr = create2Address(uupsInit);
  const ecdsaAddr = create2Address(ecdsaInit);
  const factoryInit = buildInitCode(byName.KernelFactory, [uupsAddr, ecdsaAddr]);
  const factoryAddr = create2Address(factoryInit);
  const plan = [
    { name: "KernelUUPS", initCode: uupsInit, predicted: uupsAddr },
    { name: "KernelImmutableECDSA", initCode: ecdsaInit, predicted: ecdsaAddr },
    { name: "KernelFactory", initCode: factoryInit, predicted: factoryAddr },
  ];
  out("  v0.8-adapted predictions (ctor args re-wired to EntryPoint v0.8.0):");
  for (const c of plan) {
    const prior = PRIOR_PREDICTIONS[c.name];
    const match = c.predicted.toLowerCase() === prior.toLowerCase();
    out(
      `    ${c.name.padEnd(22)} ${c.predicted}   init_code ${(c.initCode.length - 2) / 2} bytes   ${
        match ? "= prior derivation" : `LOUD DISCREPANCY — prior derivation said ${prior}`
      }`,
    );
  }
  out(`  EntryPoint v0.8 wiring target: ${ENTRY_POINT_V08}`);

  // Chain preflight.
  const rpc = createKernel033ChainRpc({ url: CHAIN_RPC_URL });
  const deployerCode = await getCode(DETERMINISTIC_DEPLOYER);
  if (deployerCode === undefined || deployerCode === "0x") {
    throw new Error("kernel-factory-deploy: deterministic deployer has NO code on this chain");
  }
  out(`  deployer code present (${(deployerCode.length - 2) / 2} bytes)`);
  const epCode = await getCode(ENTRY_POINT_V08);
  if (epCode === undefined || epCode === "0x") {
    throw new Error("kernel-factory-deploy: EntryPoint v0.8.0 has NO code on this chain");
  }
  out(`  EntryPoint v0.8 code present (${(epCode.length - 2) / 2} bytes)`);

  const fixtureSender = await getKernel033Sender({
    pubKeyX: fixturePub.x,
    pubKeyY: fixturePub.y,
    rpc,
  });
  if (fixtureSender.toLowerCase() !== FIXTURE_ACCOUNT.toLowerCase()) {
    throw new Error(
      `kernel-factory-deploy: fixture account derivation mismatch: factory says ${fixtureSender}, expected ${FIXTURE_ACCOUNT}`,
    );
  }
  const fixtureCode = await getCode(FIXTURE_ACCOUNT);
  const fixtureDeployed = fixtureCode !== undefined && fixtureCode !== "0x";
  out(
    `  fixture account ${FIXTURE_ACCOUNT} — re-derived OK, ${
      fixtureDeployed
        ? `deployed (${(fixtureCode.length - 2) / 2} bytes)`
        : "NOT yet deployed (first op carries initCode)"
    }`,
  );

  if (DRY_RUN) {
    out("  dry-run calldata exercise (encode + in-sim self-execute, read-only):");
    for (const c of plan) {
      const callData = buildDeployCallData(c.initCode);
      const sim = await tryEthCall({
        from: FIXTURE_ACCOUNT,
        to: FIXTURE_ACCOUNT,
        data: callData,
        gas: MANUAL_GAS.callGasLimit,
      });
      out(
        `    ${c.name.padEnd(22)} callData ${(callData.length - 2) / 2} bytes  sim ${
          sim.ok ? "OK" : `REVERT (${sim.error})`
        }`,
      );
    }
    out("\nDRY RUN complete — nothing broadcast.");
    return;
  }

  // --------------------------------------- STEP 1+2: deploy + verify -----
  const summary = [];
  for (const c of plan) {
    step("1", `deploy ${c.name} → ${c.predicted}`);
    const existing = await getCode(c.predicted);
    if (existing !== undefined && existing !== "0x") {
      out(`      already deployed (${(existing.length - 2) / 2} bytes) — verifying wiring before skipping`);
      const wired =
        c.name === "KernelFactory"
          ? await verifyFactoryWiring(c.predicted, uupsAddr, ecdsaAddr)
          : await verifyImplWiring(c.predicted);
      if (!wired) {
        throw new Error(
          `kernel-factory-deploy: ${c.name} exists at ${c.predicted} but FAILS the EntryPoint v0.8 wiring check — refusing to continue`,
        );
      }
      out("      wiring OK — skipping (idempotent).");
      summary.push({
        name: c.name,
        predicted: c.predicted,
        codeBytes: (existing.length - 2) / 2,
        txHash: "(pre-existing)",
        block: "-",
        gasUsed: "-",
        userOpHash: "-",
        status: "skipped (wiring verified)",
      });
      continue;
    }

    const callData = buildDeployCallData(c.initCode);
    // Re-check each iteration: the first op may have deployed the account.
    const accountCodeNow = await getCode(FIXTURE_ACCOUNT);
    const deployedNow = accountCodeNow !== undefined && accountCodeNow !== "0x";
    if (deployedNow) {
      // Dry-run the EXACT calldata from the account itself before spending
      // sponsorship (validates decodeSingle layout + the inner CREATE2).
      const sim = await tryEthCall({
        from: FIXTURE_ACCOUNT,
        to: FIXTURE_ACCOUNT,
        data: callData,
        gas: MANUAL_GAS.callGasLimit,
      });
      if (!sim.ok) {
        throw new Error(
          `kernel-factory-deploy: preflight eth_call of the ${c.name} deploy calldata REVERTED: ${sim.error} — aborting before sponsorship`,
        );
      }
      out("      preflight eth_call (account self-execute) OK");
    } else {
      out("      preflight eth_call skipped — account deploys in this op; the sponsor simulation validates the calldata");
    }

    out(`      callData ${callData.length / 2 - 1} bytes  (execute → deterministic deployer)`);
    let result;
    try {
      result = await sendKernel033UserOp({
        credentialId: "kernel-factory-deploy-fixture",
        pubKeyX: fixturePub.x,
        pubKeyY: fixturePub.y,
        config: {
          projectId: ZERODEV_PROJECT_ID,
          apiKey: ZERODEV_API_KEY,
          chainId: CHAIN_ID,
        },
        rpc,
        callData,
        getAssertion: fixtureAssertionSource,
        receipt: RECEIPT_BOUNDS,
      });
    } catch (error) {
      if (error instanceof PaymasterDeniedError) {
        out(`      SPONSORSHIP DENIED: ${error.serverMessage}`);
        out(`      action: ${error.dashboardAction}`);
        process.exit(2);
      }
      const message = error.message ?? String(error);
      out(`      first attempt failed: ${message}`);
      if (!looksLikeGasBlock(message)) {
        throw error;
      }
      // Documented manual path: trust our bounded limits (`manualGasEstimation`).
      out(`      retrying ONCE with manual gas (bounded): ${JSON.stringify(MANUAL_GAS)}`);
      const fees = await defaultFees();
      const manual = await sendSponsoredUserOp({
        config: {
          projectId: ZERODEV_PROJECT_ID,
          apiKey: ZERODEV_API_KEY,
          chainId: CHAIN_ID,
        },
        entryPointAddress: ENTRY_POINT_V0_7,
        sender: FIXTURE_ACCOUNT,
        nonce: word32Of(
          await rpc.ethCall({
            to: ENTRY_POINT_V0_7,
            data: abiEncodeCall("getNonce(address,uint192)", [
              { kind: "address", value: FIXTURE_ACCOUNT },
              { kind: "uint", value: 0n },
            ]),
          }),
        ),
        initCode: deployedNow
          ? "0x"
          : buildKernel033InitCode({
              pubKeyX: fixturePub.x,
              pubKeyY: fixturePub.y,
            }),
        callData,
        fees,
        gas: MANUAL_GAS,
        dummySignature: OFFICIAL_STUB_SIGNATURE,
        // The fixture account is EntryPoint v0.7-wired — the v0.7 hash guard
        // (sendSponsoredUserOp's default hash is the v0.8 EIP-712 one).
        hashUserOp: (packed, entryPoint, chain) =>
          assertHashMatchesEntryPoint(packed, {
            entryPoint,
            chainId: chain,
            rpc,
          }),
        signUserOpHash: (opHash) =>
          signKernel033UserOp({
            credentialId: "kernel-factory-deploy-fixture",
            opHash,
            getAssertion: fixtureAssertionSource,
          }),
        receipt: RECEIPT_BOUNDS,
      });
      result = {
        txHash: manual.receipt.receipt.transactionHash,
        blockNumber: manual.receipt.receipt.blockNumber,
        userOpHash: manual.opHash,
        gasUsed: manual.receipt.actualGasUsed,
        success: manual.receipt.success === true,
        deployed: false,
      };
    }
    if (result.success !== true) {
      throw new Error(
        `kernel-factory-deploy: ${c.name} UserOp landed but reports success=false ` +
          `(tx ${result.txHash}) — inspect the receipt before continuing`,
      );
    }
    out(`      landed: tx ${result.txHash}  block ${BigInt(result.blockNumber)}  gas ${BigInt(result.gasUsed)}`);

    const code = await getCode(c.predicted);
    if (code === undefined || code === "0x") {
      throw new Error(
        `kernel-factory-deploy: NO code at predicted ${c.predicted} after ${result.txHash} — CREATE2 mismatch, refusing to continue`,
      );
    }
    out(`      eth_getCode ${c.predicted} → ${(code.length - 2) / 2} bytes`);
    const wired =
      c.name === "KernelFactory"
        ? await verifyFactoryWiring(c.predicted, uupsAddr, ecdsaAddr)
        : await verifyImplWiring(c.predicted);
    if (!wired) {
      throw new Error(
        `kernel-factory-deploy: ${c.name} deployed but FAILS the EntryPoint v0.8 wiring check`,
      );
    }
    out("      EntryPoint v0.8 wiring VERIFIED");
    summary.push({
      name: c.name,
      predicted: c.predicted,
      codeBytes: (code.length - 2) / 2,
      txHash: result.txHash,
      block: String(BigInt(result.blockNumber)),
      gasUsed: String(BigInt(result.gasUsed)),
      userOpHash: result.userOpHash,
      status: "deployed + wired",
    });
  }

  // Factory `getAddress` sanity (empty package list — stable + non-zero).
  step("2", "factory getAddress sanity");
  const getAddressData = abiEncodeCall(KERNEL_GET_ADDRESS_SIGNATURE, [
    { kind: "tuple[]", items: [] },
    { kind: "uint", value: 0n },
  ]);
  const sanity1 = await tryEthCall({ to: factoryAddr, data: getAddressData });
  const sanity2 = await tryEthCall({ to: factoryAddr, data: getAddressData });
  const addr1 = sanity1.ok ? decodeAddressWord(sanity1.result) : "(revert)";
  const addr2 = sanity2.ok ? decodeAddressWord(sanity2.result) : "(revert)";
  out(`  getAddress([], 0) → ${addr1}  (repeat ${addr2} — stable: ${addr1 === addr2})`);

  // --------------------------------------------- STEP 3: v0.8 stretch ----
  let stretchNote = "disabled (--no-stretch)";
  if (!NO_STRETCH) {
    step("3", "stretch — one sponsored UserOp through a fresh v0.4.0 Kernel (EntryPoint v0.8)");
    try {
      const install = webAuthnValidatorInstall({
        validator: WEB_AUTHN_VALIDATOR_V0_0_3_PATCHED,
        pubKeyX: fixturePub.x,
        pubKeyY: fixturePub.y,
      });
      const initialPackages = [install];
      const deployNonce = 0n;
      const initCode = buildKernelInitCode({
        factory: factoryAddr,
        initialPackages,
        deployNonce,
      });
      const sender = await getSenderFromKernelFactory({
        call: rpc.ethCall,
        factory: factoryAddr,
        initialPackages,
        deployNonce,
      });
      out(`  fresh v0.4.0 counterfactual sender ${sender}`);
      out(`  root validator  ${WEB_AUTHN_VALIDATOR_V0_0_3_PATCHED}  (V0_0_3_PATCHED — byte-compatible tuple/enable data)`);
      const senderCode = await rpc.getCode(sender);
      const alreadyDeployed = senderCode !== undefined && senderCode !== "0x";
      if (alreadyDeployed) {
        out("  sender already deployed — sending the self-call only (idempotent)");
      }
      const nonce = word32Of(
        BigInt(
          await rpc.ethCall({
            to: ENTRY_POINT_V08,
            data: abiEncodeCall("getNonce(address,uint192)", [
              { kind: "address", value: sender },
              { kind: "uint", value: 0n },
            ]),
          }),
        ),
      );
      out(`  nonce ${nonce}`);
      const fees = await defaultFees();
      const callData = buildKernelSelfCallData(sender);
      const result = await sendSponsoredUserOp({
        config: {
          projectId: ZERODEV_PROJECT_ID,
          apiKey: ZERODEV_API_KEY,
          chainId: CHAIN_ID,
        },
        entryPointAddress: ENTRY_POINT_V08,
        sender,
        nonce,
        initCode: alreadyDeployed ? "0x" : initCode,
        callData,
        fees,
        dummySignature: OFFICIAL_STUB_SIGNATURE,
        // v0.8 EIP-712 hash (wave-4b core) + LIVE byte-equality guard.
        hashUserOp: async (packed, entryPoint, chain) => {
          const local = getUserOpHash(packed, entryPoint, chain);
          const onChain = await rpc.ethCall({
            to: entryPoint,
            data: userOpHashCalldataV07(packed),
          });
          if (onChain.toLowerCase() !== local.toLowerCase()) {
            throw new Error(
              `stretch hash mismatch: local ${local} != EntryPoint v0.8 getUserOpHash ${onChain} — refusing to sign`,
            );
          }
          out(`  hash check ✓ local == EntryPoint v0.8 getUserOpHash(${local})`);
          return local;
        },
        signUserOpHash: (opHash) =>
          signKernel033UserOp({
            credentialId: "kernel-factory-deploy-stretch",
            opHash,
            getAssertion: fixtureAssertionSource,
          }),
        receipt: RECEIPT_BOUNDS,
      });
      out(`  userOpHash  ${result.opHash}`);
      out(`  tx hash     ${result.receipt.receipt.transactionHash}`);
      out(
        `  block       ${BigInt(result.receipt.receipt.blockNumber)} (userOp success ${result.receipt.success === true})`,
      );
      out(`  gas used    ${BigInt(result.receipt.actualGasUsed)} (sponsored)`);
      out(`  paymaster   ${result.sponsorship.paymaster}`);
      if (result.receipt.success !== true) {
        stretchNote = `Landed but success=false (tx ${result.receipt.receipt.transactionHash})`;
      } else {
        stretchNote = `OK — fresh v0.4.0 account ${sender} deployed + executed via EntryPoint v0.8 (tx ${result.receipt.receipt.transactionHash})`;
      }
    } catch (error) {
      if (error instanceof PaymasterDeniedError) {
        stretchNote = `BLOCKED by paymaster policy: ${error.serverMessage}`;
      } else {
        stretchNote = `BLOCKED: ${error.message ?? String(error)}`;
      }
      out(`  stretch result: ${stretchNote}`);
    }
  }

  // ------------------------------------------------------- summary -------
  step("=", "SUMMARY");
  out(
    `  ${"contract".padEnd(22)} ${"predicted/actual".padEnd(44)} ${"code".padEnd(7)} ${"block".padEnd(10)} ${"gas".padEnd(10)} status`,
  );
  for (const row of summary) {
    out(
      `  ${row.name.padEnd(22)} ${row.predicted.padEnd(44)} ${`${row.codeBytes}B`.padEnd(7)} ${row.block.padEnd(10)} ${row.gasUsed.padEnd(10)} ${row.status}`,
    );
    out(`      tx ${row.txHash}`);
    out(`      userOpHash ${row.userOpHash}`);
  }
  out(`  factory getAddress([],0) sanity: ${addr1} (stable ${addr1 === addr2})`);
  out(`  stretch: ${stretchNote}`);
  out(`  api key  ${mask(ZERODEV_API_KEY)}`);
  out("\nDEPLOY RUN COMPLETE.");
}

main().catch((error) => {
  if (error instanceof PaymasterDeniedError) {
    console.error("\nSPONSORSHIP DENIED BY DASHBOARD POLICY");
    console.error(`  server: ${error.serverMessage}`);
    console.error(`  action: ${error.dashboardAction}`);
    process.exit(2);
  }
  console.error(`\nDEPLOY FAILED: ${error.stack ?? error.message}`);
  process.exit(1);
});
