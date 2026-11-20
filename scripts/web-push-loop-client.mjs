// web-push-loop-client.mjs: the Nostr half of scripts/web-push-loop.sh.
//
// Signs real records with real keys made for the run (kept only in the run's own scratch file), sends them to a real relay
// with NIP-98 signed requests, and makes the devices a person's browser would make by asking the stand-in push service
// (scripts/web-push-standin.mjs) for them. The wallet links are built with the app's own code
// (packages/creaton-core/src/account/wallet-proof.ts) and signed by anvil's public development keys through `cast`.
//
//   node --experimental-strip-types scripts/web-push-loop-client.mjs keys   <keys file>
//   node --experimental-strip-types scripts/web-push-loop-client.mjs pubkey <keys file> <role>
//   node --experimental-strip-types scripts/web-push-loop-client.mjs setup  <keys file> <devices file>
//   node --experimental-strip-types scripts/web-push-loop-client.mjs remove <keys file> <devices file> <role>
//   node --experimental-strip-types scripts/web-push-loop-client.mjs again  <keys file> <devices file> <role>
//
// Reads from the environment: BASE (the relay's http url), STANDIN (the stand-in's http url), KEY (the project's chain key),
// PROJECT_D (the project record's id), and the public development keys K_A, K_C, K_E of the wallets that hold, took out
// everything, and hold without having linked. Prints one `ok ...` line per check; exits 1 with the reason at the first
// that fails.

import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, "..", "web", "node_modules", "package.json"));
const { finalizeEvent, generateSecretKey, getPublicKey } = require("nostr-tools");
const { hexToBytes, bytesToHex } = require(path.join(here, "..", "packages", "creaton-core", "node_modules", "@noble", "hashes", "utils.js"));
const proof = await import("../packages/creaton-core/src/account/wallet-proof.ts");

const BASE = process.env.BASE;
const STANDIN = process.env.STANDIN;
const KEY = process.env.KEY;
const PROJECT_D = process.env.PROJECT_D;
const CHAIN = 31337;
const ROLES = ["founder", "holder", "leaver", "unlinked", "stranger"];

let checks = 0;
const ok = (what) => {
  checks += 1;
  console.log(`ok ${what}`);
};
const fail = (what) => {
  console.error(`FAIL ${what}`);
  process.exit(1);
};
const now = () => Math.floor(Date.now() / 1000);
const secret = (keys, role) => hexToBytes(keys[role]);

function token(sk, method, url, body) {
  const tags = [["u", url], ["method", method]];
  if (body) tags.push(["payload", createHash("sha256").update(body, "utf8").digest("hex")]);
  const auth = finalizeEvent({ kind: 27235, content: "", created_at: now(), tags }, sk);
  return `Nostr ${Buffer.from(JSON.stringify(auth), "utf8").toString("base64")}`;
}

async function call(sk, method, route, body, signed = true) {
  const url = `${BASE}${route}`;
  const headers = { "content-type": "application/json" };
  if (signed) headers.authorization = token(sk, method, url, body ?? "");
  const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(30_000) });
  return { status: res.status, text: await res.text() };
}

async function standIn(route, method = "GET", body) {
  const res = await fetch(`${STANDIN}${route}`, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  return res.json();
}

async function publish(keys, role, template) {
  const sk = secret(keys, role);
  const event = finalizeEvent({ created_at: now(), content: "", tags: [], ...template }, sk);
  const { status, text } = await call(sk, "POST", "/events", JSON.stringify(event));
  let accepted = false;
  try {
    accepted = JSON.parse(text).accepted === true;
  } catch {
    accepted = false;
  }
  if (!accepted) fail(`a ${template.kind} record was refused (${status}): ${text.slice(0, 300)}`);
  return event;
}

function addressOf(anvilKey) {
  return execFileSync("cast", ["wallet", "address", "--private-key", anvilKey], { encoding: "utf8" }).trim().toLowerCase();
}

/** A wallet link, built with the app's own typed data and signed by an anvil key through `cast`. */
function bindingTemplate(pubkey, address, anvilKey) {
  const attestation = proof.newWalletAttestation(address, pubkey, CHAIN, now(), Math.floor(Math.random() * 2 ** 31));
  const dir = mkdtempSync(path.join(tmpdir(), "web-push-loop-"));
  try {
    const file = path.join(dir, "typed.json");
    writeFileSync(file, JSON.stringify(proof.walletTypedData(attestation)));
    attestation.signature = execFileSync("cast", ["wallet", "sign", "--data", "--from-file", file, "--private-key", anvilKey], { encoding: "utf8" }).trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return {
    kind: 37017,
    created_at: now(),
    tags: [["d", address], ["address", address], ["chain", String(CHAIN)]],
    content: JSON.stringify({ v: 1, address, siweMessageHash: proof.siweMessageHash("Link this wallet to my Creaton account."), attestation }),
  };
}

const mode = process.argv[2];
const keysFile = process.argv[3];
if (mode === "keys") {
  writeFileSync(keysFile, JSON.stringify(Object.fromEntries(ROLES.map((r) => [r, bytesToHex(generateSecretKey())]))));
  process.exit(0);
}
const keys = JSON.parse(readFileSync(keysFile, "utf8"));
if (mode === "pubkey") {
  console.log(getPublicKey(secret(keys, process.argv[4])));
  process.exit(0);
}
const pub = (role) => getPublicKey(secret(keys, role));
const wallets = { holder: process.env.K_A, leaver: process.env.K_C, unlinked: process.env.K_E };

if (mode === "setup") {
  const devicesFile = process.argv[4];
  await publish(keys, "founder", { kind: 37001, tags: [["d", PROJECT_D], ["name", "Web push loop"], ["chain-key", KEY]], content: "{}" });
  ok("the founder's project record names the launch on the chain");
  // The wallets a person proves are their own: the holder, and the person who took everything out. The third holder never links.
  for (const role of ["holder", "leaver"]) {
    await publish(keys, role, bindingTemplate(pub(role), addressOf(wallets[role]), wallets[role]));
    ok(`${role}: the wallet link the app builds is accepted`);
  }
  // Every account keeps a device: the stand-in makes the keys a browser would make.
  const devices = {};
  const standInHost = new URL(STANDIN).host;
  for (const role of ["holder", "leaver", "unlinked", "stranger"]) {
    const device = await standIn("/_devices", "POST", {});
    devices[role] = device;
    const sk = secret(keys, role);
    const body = JSON.stringify(device);
    const unsigned = await call(sk, "PUT", "/push/web", body, false);
    if (unsigned.status !== 401) fail(`an unsigned PUT /push/web answered ${unsigned.status}, not 401`);
    const done = await call(sk, "PUT", "/push/web", body);
    if (!device.endpoint.includes(standInHost)) fail("the stand-in's device is not at the stand-in");
    if (role === "holder" || role === "leaver") {
      if (done.status !== 200) fail(`PUT /push/web for ${role} answered ${done.status}: ${done.text.slice(0, 300)}`);
      ok(`${role}: a device is kept (the unsigned call was refused with 401)`);
    } else {
      // An account with no linked wallet gets no device kept: the server reads the chain, and alerts are for people who back a project.
      if (done.status !== 403) fail(`PUT /push/web for ${role}, who linked no wallet, answered ${done.status}, not 403: ${done.text.slice(0, 300)}`);
      ok(`${role}: no device is kept for an account with no linked wallet (403)`);
    }
  }
  // A bad subscription is refused and writes nothing: a host that is not a push service and not on the operator's list.
  const bad = await call(secret(keys, "stranger"), "PUT", "/push/web", JSON.stringify({ endpoint: "https://169.254.169.254/latest", keys: devices.stranger.keys }));
  if (bad.status !== 400) fail(`a subscription to the metadata address answered ${bad.status}, not 400`);
  ok("a subscription to a host that is no push service is refused with 400");
  writeFileSync(devicesFile, JSON.stringify(devices));
} else if (mode === "remove") {
  const devices = JSON.parse(readFileSync(process.argv[4], "utf8"));
  const role = process.argv[5];
  const done = await call(secret(keys, role), "DELETE", "/push/web", JSON.stringify({ endpoint: devices[role].endpoint }));
  if (done.status !== 200) fail(`DELETE /push/web answered ${done.status}: ${done.text.slice(0, 300)}`);
  ok(`${role}: the device is removed by its address (the app's "Turn off")`);
} else if (mode === "again") {
  const devices = JSON.parse(readFileSync(process.argv[4], "utf8"));
  const role = process.argv[5];
  const done = await call(secret(keys, role), "PUT", "/push/web", JSON.stringify(devices[role]));
  if (done.status !== 200) fail(`PUT /push/web answered ${done.status}: ${done.text.slice(0, 300)}`);
  ok(`${role}: the device is kept again`);
} else {
  fail(`unknown mode ${mode}`);
}
console.log(`CHECKS ${checks}`);
