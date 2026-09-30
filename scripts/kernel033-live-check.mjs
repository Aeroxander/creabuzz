#!/usr/bin/env node
/**
 * kernel033 LIVE CHECK — one end-to-end `sendKernel033UserOp` against Sepolia
 * through ZeroDev's hosted paymaster + bundler, proving the extracted product
 * module lands a sponsored UserOperation exactly like `zerodev-smoke.mjs`
 * (wave 4c) did.
 *
 * Run under the repo's Hermit toolchain (node ≥ 22.18 strips TS types):
 *   . ./bin/activate-hermit && node scripts/kernel033-live-check.mjs
 *
 * Credentials come from the repo-root `.env` at runtime (ZERODEV_PROJECT_ID,
 * ZERODEV_API_KEY, SEPOLIA_RPC_URL) and are MASKED in all output. Nothing
 * secret is committed or printed (hard rule).
 *
 * TEST-ONLY ceremony substitution: node has no `navigator.credentials`, so
 * the WebAuthn CEREMONY is supplied via the `getAssertion` seam with the
 * smoke's deterministic fixture P-256 key (pinned JWK from
 * `contracts/test/kernel-sign.mjs` — obviously-fake test key) producing a
 * REAL ES256 assertion over the op hash. The APP PATH has no fixture keys:
 * `signKernel033UserOp` defaults to the real `getPasskeyAssertion`
 * (Touch ID / virtual authenticator). Everything else in this run —
 * initcode, sender derivation, sponsor-first flow, the LIVE hash guard,
 * tuple wrapping (DER → low-s), submission, receipt polling — is the
 * production `sendKernel033UserOp` code path end to end.
 */
import { createHash, createPrivateKey, sign as ecdsaSign } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createKernel033ChainRpc,
  sendKernel033UserOp,
} from "../web/src/features/identity/lib/kernel033.ts";
import { b64urlEncode } from "../web/src/features/identity/lib/passkey.ts";
import { PaymasterDeniedError } from "../web/src/features/identity/lib/zerodev.ts";

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

// ------------------------------------------------- fixture P-256 signer ---
// Provenance: contracts/test/kernel-sign.mjs (the pinned JWK fixture signer
// behind the in-repo forge proof and the wave-4c smoke). TEST-ONLY.

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
 * The `PasskeyAssertionSource` seam: a WebAuthn assertion over the RECEIVED
 * CHALLENGE (the op hash bytes `signKernel033UserOp` passes) — byte-for-byte
 * the forge-proven construction (`contracts/test/KernelWebAuthnUserOp.t.sol`):
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

// ------------------------------------------------------------- main ------

async function main() {
  console.log("kernel033 LIVE CHECK — Sepolia (production sendKernel033UserOp)");
  console.log(
    `  project  …${(ZERODEV_PROJECT_ID ?? "").slice(-4)}   api key ${mask(
      ZERODEV_API_KEY,
    )}   chain rpc host ${new URL(CHAIN_RPC_URL).host}`,
  );
  console.log(
    "  ceremony: TEST-ONLY fixture P-256 via the getAssertion seam " +
      "(the app path is the real passkey — Touch ID)",
  );

  const phases = [];
  const result = await sendKernel033UserOp({
    credentialId: "live-check-fixture",
    pubKeyX: fixturePub.x,
    pubKeyY: fixturePub.y,
    config: {
      projectId: ZERODEV_PROJECT_ID,
      apiKey: ZERODEV_API_KEY,
      chainId: CHAIN_ID,
    },
    rpc: createKernel033ChainRpc({ url: CHAIN_RPC_URL }),
    getAssertion: (options) => {
      console.log(
        `      ceremony over challenge ${options.challenge.length} bytes (op hash)`,
      );
      return fixtureAssertionSource(options);
    },
    onPhase: (phase) => {
      phases.push(phase);
      console.log(`      phase ${phase}`);
    },
    receipt: { pollIntervalMs: 2000, maxPolls: 90 },
  });

  console.log("\nRESULT");
  console.log(`      userOpHash  ${result.userOpHash}`);
  console.log(`      tx hash     ${result.txHash}`);
  console.log(
    `      block       ${BigInt(result.blockNumber)} (userOp success ${result.success})`,
  );
  console.log(
    `      sender      ${result.sender}${result.deployed ? " (deployed this run)" : " (pre-deployed — idempotent path)"}`,
  );
  console.log(
    `      gas used    ${BigInt(result.gasUsed).toString()} (sponsored)`,
  );
  console.log(`      paymaster   ${result.paymaster}`);
  console.log(`      pm limits   pv ${result.sponsorship.paymasterVerificationGasLimit ?? "-"} post ${result.sponsorship.paymasterPostOpGasLimit ?? "-"}`);
  console.log(`      phases      ${phases.join(" → ")}`);
  console.log(`      api key     ${mask(ZERODEV_API_KEY)}`);
  console.log(
    "\nLIVE CHECK OK — sendKernel033UserOp landed a sponsored UserOperation on Sepolia.",
  );
}

main().catch((error) => {
  if (error instanceof PaymasterDeniedError) {
    console.error("\nSPONSORSHIP DENIED BY DASHBOARD POLICY");
    console.error(`  server: ${error.serverMessage}`);
    console.error(`  action: ${error.dashboardAction}`);
    console.error(
      "\nThe module path (build → sponsor → hash-guard → sign → submit) is",
    );
    console.error("proven up to the policy gate; enable the policy and re-run.");
    process.exit(2);
  }
  console.error(`\nLIVE CHECK FAILED: ${error.stack ?? error.message}`);
  process.exit(1);
});
