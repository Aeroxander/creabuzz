#!/usr/bin/env node
/**
 * kernel 1271 LIVE CHECK — a passkey account's proof that "this Nostr key may act for me", checked by a REAL deployed
 * Kernel 0.3.3 account on Sepolia through its own `isValidSignature` (ERC-1271). Read-only: it only ever makes
 * `eth_call`s, spends nothing, and needs no key of yours.
 *
 * Run under the repo's Hermit toolchain (node >= 22.18 strips TS types):
 *   . ./bin/activate-hermit && node scripts/kernel-1271-live-check.mjs
 *   … --print     # also print the signed attestation envelope, the golden vector the Rust test pins
 *
 * Env: CHAIN_RPC_URL (default: the public Sepolia endpoint). Nothing secret is read.
 *
 * What it proves, with the PRODUCTION modules (`kernel-signature.ts`, `wallet-proof.ts`):
 *   1. the fixture passkey's Kernel account (the one `kernel033-live-check.mjs` deploys) accepts the attestation
 *      signature the app would publish;
 *   2. the same signature is refused for a different Nostr key, a different expiry, and a different account;
 *   3. a reader that resolves the record and asks the chain ends with the proof verified, and an account with no code
 *      (an ordinary address claiming a smart-account proof) ends with it invalid.
 *
 * TEST-ONLY ceremony: node has no `navigator.credentials`, so the WebAuthn ceremony is the pinned fixture P-256 key of
 * `contracts/test/kernel-sign.mjs` (obviously fake) through the same `getAssertion` seam the app's tests use.
 */
import { createHash, createPrivateKey, sign as ecdsaSign } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

// `nostr-tools` is a dependency of the web app, not of the repo root: resolve it from there.
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
const nostrTools = await import(
  pathToFileURL(webRequire.resolve("nostr-tools/pure")).href
);
const { finalizeEvent, getPublicKey } = nostrTools.default ?? nostrTools;

import { createKernel033ChainRpc, getKernel033Sender } from "../web/src/features/identity/lib/kernel033.ts";
import {
  isValidKernelSignature,
  signKernelHash,
} from "../web/src/features/identity/lib/kernel-signature.ts";
import { b64urlEncode } from "../web/src/features/identity/lib/passkey.ts";
import {
  newWalletAttestation,
  resolvePaymentWalletChecked,
  siweMessageHash,
  walletAttestationDigest,
} from "../web/src/features/identity/lib/wallet-proof.ts";

const CHAIN_ID = 11155111;
const RPC_URL = process.env.CHAIN_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
const FAR_FUTURE = 4102444800; // 2100-01-01: the pinned vector never expires
const NOSTR_SECRET = Uint8Array.from({ length: 32 }, () => 0x33);

const JWK = {
  kty: "EC",
  x: "BqjPovesWJOn2eU86PyU1j9LVKlpvYN2w5KCEzAus2Y",
  y: "Ii_D2wwf1j9Rb0hDdPZvMCEM57JNbv48Uk62463QVG4",
  crv: "P-256",
  d: "T4FCxtt1hQgHJSwFv78_S0LGYtVvt73h7-RikHaQ_G8",
};
const key = createPrivateKey({ key: JWK, format: "jwk" });
const toBig = (b64) => BigInt(`0x${Buffer.from(b64, "base64url").toString("hex")}`);

function ceremony({ credentialId, challenge }) {
  const authenticatorData = Buffer.concat([
    createHash("sha256").update("localhost").digest(),
    Buffer.from([0x05]),
    Buffer.alloc(4),
  ]);
  const clientDataJSON = `{"type":"webauthn.get","challenge":"${b64urlEncode(
    challenge,
  )}","origin":"https://example.com","crossOrigin":false}`;
  const message = Buffer.concat([authenticatorData, createHash("sha256").update(clientDataJSON).digest()]);
  return Promise.resolve({
    credentialId,
    signature: new Uint8Array(ecdsaSign("sha256", message, key)),
    authenticatorData: new Uint8Array(authenticatorData),
    clientDataJSON: new TextEncoder().encode(clientDataJSON),
  });
}

let failures = 0;
function expect(label, ok) {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) failures += 1;
}

async function main() {
  const rpc = createKernel033ChainRpc({ url: RPC_URL });
  const ethCall = (tx) => rpc.ethCall(tx);
  const pubkey = getPublicKey(NOSTR_SECRET);

  const account = await getKernel033Sender({ pubKeyX: toBig(JWK.x), pubKeyY: toBig(JWK.y), rpc });
  const code = await rpc.getCode(account);
  console.log(`kernel 1271 live check on chain ${CHAIN_ID} (${new URL(RPC_URL).host})`);
  console.log(`  account ${account}  deployed: ${code.length > 2}`);
  if (code.length <= 2) {
    console.error("The fixture account is not deployed on this chain; run scripts/kernel033-live-check.mjs first.");
    process.exit(2);
  }

  const attestation = newWalletAttestation(account, pubkey, CHAIN_ID, FAR_FUTURE - 365 * 86400, 1);
  attestation.attestation.expires = FAR_FUTURE;
  const digest = `0x${Buffer.from(walletAttestationDigest(attestation)).toString("hex")}`;
  attestation.signature = await signKernelHash({
    credentialId: "live-check-fixture",
    hash: digest,
    account,
    chainId: CHAIN_ID,
    getAssertion: ceremony,
  });

  expect("the account accepts the attestation its passkey signed", await isValidKernelSignature(ethCall, account, digest, attestation.signature));

  const moved = (change) => {
    const copy = structuredClone(attestation);
    change(copy);
    return `0x${Buffer.from(walletAttestationDigest(copy)).toString("hex")}`;
  };
  expect(
    "…and refuses it for a different Nostr key",
    !(await isValidKernelSignature(ethCall, account, moved((a) => { a.attestation.npub[0] ^= 1; }), attestation.signature)),
  );
  expect(
    "…and for a later expiry",
    !(await isValidKernelSignature(ethCall, account, moved((a) => { a.attestation.expires += 1; }), attestation.signature)),
  );
  expect(
    "…and for another account",
    !(await isValidKernelSignature(ethCall, account, moved((a) => { a.attestation.account = `0x${"11".repeat(20)}`; }), attestation.signature)),
  );

  // The whole reader path: the signed record, resolved, then the chain asked.
  const body = { v: 1, address: account, siweMessageHash: siweMessageHash("passkey account"), attestation };
  const event = finalizeEvent(
    {
      kind: 37017,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["d", account], ["address", account], ["chain", String(CHAIN_ID)]],
      content: JSON.stringify(body),
    },
    NOSTR_SECRET,
  );
  const checker = (check) => isValidKernelSignature(ethCall, check.account, check.digest, check.signature);
  const verified = await resolvePaymentWalletChecked([event], pubkey, Math.floor(Date.now() / 1000), checker);
  expect("a reader verifies the published record against the chain", verified.state === "verified");

  const ordinary = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
  const forged = structuredClone(body);
  forged.address = ordinary;
  forged.attestation.attestation.account = ordinary;
  const forgedEvent = finalizeEvent(
    {
      kind: 37017,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["d", ordinary], ["address", ordinary], ["chain", String(CHAIN_ID)]],
      content: JSON.stringify(forged),
    },
    NOSTR_SECRET,
  );
  const refused = await resolvePaymentWalletChecked([forgedEvent], pubkey, Math.floor(Date.now() / 1000), checker);
  expect("an address with no account behind it cannot claim the same proof", refused.state === "invalid");

  if (process.argv.includes("--print")) {
    console.log("\nGOLDEN envelope (attestation JSON):");
    console.log(JSON.stringify(attestation));
    console.log(`npub ${pubkey}`);
  }
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nLIVE CHECK OK: a real Kernel 0.3.3 account accepts the passkey proof, and only that proof.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
