// room-loop-client.mjs: the Nostr half of scripts/room-loop.sh.
//
// Signs real records with real keys made for the run (never written anywhere but the run's own scratch file) and posts them
// to a real relay with NIP-98 signed `POST /events` and `POST /query`, then checks the server's answer word by word. The
// wallet links are built with the app's own code (packages/creaton-core/src/account/wallet-proof.ts: the same typed data
// the app asks a wallet to sign), signed by anvil's public development keys through `cast`, so a link the app writes is
// what the server's rule reads.
//
//   node --experimental-strip-types scripts/room-loop-client.mjs keys   <keys file>
//   node --experimental-strip-types scripts/room-loop-client.mjs pubkey <keys file> <role>
//   node --experimental-strip-types scripts/room-loop-client.mjs phase1 <keys file>   (the room, the team's tools)
//   node --experimental-strip-types scripts/room-loop-client.mjs phase2 <keys file>   (a unit later, on the chain's clock)
//   node --experimental-strip-types scripts/room-loop-client.mjs season <keys file> entry|again|stranger|leave|reenter
//
// Reads from the environment: BASE (the relay's http url), KEY (the project's chain key), COORD (its address),
// and the public development keys K_A, K_B, K_C, K_D, K_E of the wallets that back, take out, hold one wei and hold.
// Prints one `ok ...` line per check; exits 1 with the reason at the first that fails.

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
const KEY = process.env.KEY;
const COORD = process.env.COORD;
const ROOM = `room:${KEY}`;
const CHAIN = 31337;

const SENTENCES = {
  link: "link your wallet to your account first",
  holding: "only people who back this project can write in its room",
  muted: "the team has stopped you writing in this room",
  outside: "a reply belongs in the same room as the post it answers",
  shape: "a room post names its project and its room",
  textOnly: "the room is for text",
  tooLong: "a room post is at most 2000 characters",
  notKeeper: "only the people who keep this room can remove a post from it",
  notTeam: "only this project's team can post this",
  already: "this project is already in this season",
  removed: "this project was taken out of this season",
  notOperator: "only the people who run this server",
};

let checks = 0;
const ok = (what) => {
  checks += 1;
  console.log(`ok ${what}`);
};
const fail = (what) => {
  console.error(`FAIL ${what}`);
  process.exit(1);
};

function token(sk, method, url, body) {
  const auth = finalizeEvent(
    {
      kind: 27235,
      content: "",
      created_at: Math.floor(Date.now() / 1000),
      tags: [["u", url], ["method", method], ["payload", createHash("sha256").update(body, "utf8").digest("hex")]],
    },
    sk,
  );
  return `Nostr ${Buffer.from(JSON.stringify(auth), "utf8").toString("base64")}`;
}

async function post(sk, route, body) {
  const url = `${BASE}${route}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { authorization: token(sk, "POST", url, body), "content-type": "application/json" },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  return { status: res.status, text: await res.text() };
}

const now = () => Math.floor(Date.now() / 1000);
const secret = (keys, role) => hexToBytes(keys[role]);

/** Sign a record as `role` and send it. */
async function send(keys, role, template) {
  const sk = secret(keys, role);
  const event = finalizeEvent({ created_at: now(), content: "", tags: [], ...template }, sk);
  const { status, text } = await post(sk, "/events", JSON.stringify(event));
  let accepted = false;
  try {
    accepted = JSON.parse(text).accepted === true;
  } catch {
    accepted = false;
  }
  return { event, status, text, accepted };
}

async function accepted(keys, role, template, what) {
  const r = await send(keys, role, template);
  if (!r.accepted) fail(`${what}: refused (${r.status}): ${r.text.slice(0, 300)}`);
  ok(what);
  return r.event;
}

async function refused(keys, role, template, tail, what) {
  const r = await send(keys, role, template);
  if (r.accepted) fail(`${what}: accepted, it should be refused with "${tail}"`);
  if (!r.text.includes(tail)) fail(`${what}: refused for another reason (${r.status}): ${r.text.slice(0, 300)}`);
  ok(`${what} -> "${tail}"`);
}

async function query(keys, role, filters) {
  const { status, text } = await post(secret(keys, role), "/query", JSON.stringify(filters));
  if (status !== 200) fail(`POST /query answered ${status}: ${text.slice(0, 300)}`);
  const body = JSON.parse(text);
  return Array.isArray(body) ? body : (body.events ?? []);
}

const roomTags = [["a", COORD], ["t", ROOM]];
const roomPost = (content, extra = []) => ({ kind: 1, content, tags: [...roomTags, ...extra] });

/** A wallet link, built with the app's own typed data and signed by an anvil key through `cast`. */
function bindingTemplate(pubkey, address, anvilKey) {
  const attestation = proof.newWalletAttestation(address, pubkey, CHAIN, now(), Math.floor(Math.random() * 2 ** 31));
  const dir = mkdtempSync(path.join(tmpdir(), "room-loop-"));
  try {
    const file = path.join(dir, "typed.json");
    writeFileSync(file, JSON.stringify(proof.walletTypedData(attestation)));
    const signature = execFileSync("cast", ["wallet", "sign", "--data", "--from-file", file, "--private-key", anvilKey], { encoding: "utf8" }).trim();
    attestation.signature = signature;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // The signature recovers to the wallet under the app's own digest, as the app checks before it sends.
  const recovered = proof.recoverWallet(proof.walletAttestationDigest(attestation), attestation.signature);
  if (recovered.toLowerCase() !== address.toLowerCase()) fail(`the app's digest does not recover to ${address}: ${recovered}`);
  return {
    kind: 37017,
    created_at: now(),
    tags: [["d", address], ["address", address], ["chain", String(CHAIN)]],
    content: JSON.stringify({ v: 1, address, siweMessageHash: proof.siweMessageHash("Link this wallet to my Creaton account."), attestation }),
  };
}

function addressOf(anvilKey) {
  return execFileSync("cast", ["wallet", "address", "--private-key", anvilKey], { encoding: "utf8" }).trim().toLowerCase();
}

const WALLETS = () => ({
  holder: process.env.K_A,
  other: process.env.K_B,
  leaver: process.env.K_C,
  dust: process.env.K_D,
  third: process.env.K_E,
});

const mode = process.argv[2];
const keysFile = process.argv[3];

if (mode === "keys") {
  const roles = ["founder", "mate", "operator", "stranger", "holder", "other", "leaver", "dust", "third", "newkey"];
  writeFileSync(keysFile, JSON.stringify(Object.fromEntries(roles.map((r) => [r, bytesToHex(generateSecretKey())]))));
  process.exit(0);
}
const keys = JSON.parse(readFileSync(keysFile, "utf8"));
if (mode === "pubkey") {
  console.log(getPublicKey(secret(keys, process.argv[4])));
  process.exit(0);
}
const pub = (role) => getPublicKey(secret(keys, role));
const w = WALLETS();

if (mode === "phase1") {
  // The project's own record, and the wallet links the app builds.
  await accepted(keys, "founder", {
    kind: 37001,
    tags: [["d", COORD.split(":")[2]], ["name", "Room loop"], ["team", pub("mate"), "engineer"], ["chain-key", KEY]],
    content: "{}",
  }, "the founder's project record names the launch on the chain");
  for (const [role, k] of [["holder", w.holder], ["other", w.other], ["leaver", w.leaver], ["dust", w.dust], ["third", w.third]]) {
    await accepted(keys, role, bindingTemplate(pub(role), addressOf(k), k), `${role}: the wallet link the app builds is accepted (one signature)`);
  }

  await refused(keys, "stranger", roomPost("hello"), SENTENCES.link, "a stranger with no linked wallet writes");
  await refused(keys, "dust", roomPost("one wei"), SENTENCES.holding, "an account whose wallet holds one wei, below the floor, writes");
  const first = await accepted(keys, "holder", roomPost("the first post in the room"), "a holder writes in the room");
  const reply = await accepted(
    keys, "other",
    roomPost("a reply", [["e", first.id, "", "root"], ["e", first.id, "", "reply"]]),
    "a second holder replies in the same room",
  );
  await accepted(keys, "third", { kind: 7, content: "+", tags: [...roomTags, ["e", first.id], ["p", first.pubkey], ["k", "1"]] }, "a third holder likes the post");

  // Whatever answers a room post is a room event, whatever tags it carries.
  await refused(keys, "stranger", { kind: 1, content: "no tags", tags: [["e", first.id, "", "root"]] }, SENTENCES.outside, "a stranger's untagged reply");
  await refused(keys, "stranger", { kind: 7, content: "+", tags: [["e", first.id], ["p", first.pubkey]] }, SENTENCES.outside, "a stranger's untagged like");
  await refused(keys, "holder", { kind: 1, content: "x", tags: [["e", first.id, "", "reply"]] }, SENTENCES.outside, "even a holder's untagged reply");
  await refused(keys, "stranger", { kind: 7, content: "+", tags: [...roomTags, ["e", first.id], ["p", first.pubkey]] }, SENTENCES.link, "a stranger's tagged like");

  // The shape of the room.
  await refused(keys, "holder", { kind: 1, content: "x", tags: [["a", COORD], ["t", `room:0x${"ab".repeat(32)}`]] }, SENTENCES.shape, "another project's room tag");
  await refused(keys, "holder", roomPost("with a picture", [["url", "https://example.com/a.png"]]), SENTENCES.textOnly, "a picture in a room post");
  await refused(keys, "holder", roomPost("a".repeat(2001)), SENTENCES.tooLong, "a post of 2001 characters");

  // The leaver took out their whole stake a moment ago on the chain's clock: one unit of grace.
  await accepted(keys, "leaver", roomPost("I took my money out"), "a person who took out writes inside the unit");

  // The team stops a person, naming their wallet; a new account with the same wallet is stopped too; a later record lifts it.
  const muteTags = (until, wallets) => [["a", COORD], ["room-mute", pub("other")], ...wallets.map((x) => ["room-mute-wallet", x]), ["expiration", String(until)]];
  await refused(keys, "stranger", { kind: 47003, content: "{}", tags: muteTags(now() + 3600, []) }, SENTENCES.notTeam, "a stranger tries to stop a person");
  await accepted(keys, "founder", { kind: 47003, content: "{}", tags: muteTags(now() + 3600, [addressOf(w.other)]) }, "the founder stops the second holder for an hour");
  await refused(keys, "other", roomPost("still here?"), SENTENCES.muted, "the stopped person writes");
  await accepted(keys, "newkey", bindingTemplate(pub("newkey"), addressOf(w.other), w.other), "a new account links the same wallet");
  await refused(keys, "newkey", roomPost("a new key"), SENTENCES.muted, "the new account with the same wallet writes");
  await accepted(keys, "mate", { kind: 47003, content: "{}", created_at: now() + 2, tags: muteTags(now() - 1, [addressOf(w.other)]) }, "a team member lifts it with a later record");
  await accepted(keys, "other", roomPost("back again"), "the person writes again");
  await accepted(keys, "newkey", roomPost("and so does the new key"), "so does the new account");

  // The team removes a post, with a public reason; it leaves every read and a public entry names the author.
  await refused(keys, "stranger", { kind: 9005, content: "", tags: [["e", reply.id], ["public_reason", "No"]] }, SENTENCES.notKeeper, "a stranger removes a post");
  await accepted(keys, "founder", { kind: 9005, content: "", tags: [["e", reply.id], ["public_reason", "Off topic"]] }, "the founder removes the reply with a public reason");
  const room = await query(keys, "stranger", [{ kinds: [1, 7], "#a": [COORD], "#t": [ROOM], limit: 200 }]);
  if (room.some((e) => e.id === reply.id)) fail("the removed reply is still read");
  if (!room.some((e) => e.id === first.id)) fail("the room does not show the first post");
  ok(`the room reads ${room.length} events and the removed reply is not among them`);
  const log = await query(keys, "stranger", [{ kinds: [45004], "#p": [reply.pubkey], limit: 10 }]);
  if (!log.some((e) => e.tags.some((t) => t[0] === "e" && t[1] === reply.id) && e.tags.some((t) => t[0] === "role" && t[1] === "project_team"))) {
    fail("no public log entry names the removed post and the team");
  }
  ok("a public log entry names the removed post, its author and the team");
} else if (mode === "phase2") {
  // A unit later on the chain's own clock: the leaver is read-only, the holders are not touched.
  await refused(keys, "leaver", roomPost("too late"), SENTENCES.holding, "the person who took out writes after one unit");
  await accepted(keys, "holder", roomPost("the holders are still here"), "a holder writes after the clock moved");
} else if (mode === "season") {
  const step = process.argv[4];
  const entry = (family, ahead = 0) => ({ kind: 47003, content: "{}", created_at: now() + ahead, tags: [["a", COORD], ["t", "season-1"], [family, "1"]] });
  if (step === "entry") {
    await refused(keys, "stranger", entry("season-entry"), SENTENCES.notTeam, "a stranger enters the project");
    await accepted(keys, "founder", entry("season-entry"), "the founder enters the project in season 1");
  } else if (step === "again") {
    await refused(keys, "mate", entry("season-entry", 1), SENTENCES.already, "a second entry of the same project");
    await accepted(keys, "mate", entry("season-leave", 2), "a team member takes the project out again");
    await accepted(keys, "founder", entry("season-entry", 3), "the founder puts it back in");
  } else if (step === "removed") {
    await refused(keys, "founder", entry("season-entry", 5), SENTENCES.removed, "the founder enters after the operator took the project out");
    await refused(keys, "founder", entry("season-remove", 6), SENTENCES.notOperator, "the founder signs a removal");
    const lineup = await query(keys, "stranger", [{ kinds: [47003], "#t": ["season-1"], limit: 200 }]);
    if (!lineup.some((e) => e.tags.some((t) => t[0] === "season-remove"))) fail("the lineup does not carry the removal");
    ok(`the lineup reads ${lineup.length} records of season 1, the removal among them`);
  } else {
    fail(`unknown season step ${step}`);
  }
} else {
  fail(`unknown mode ${mode}`);
}
console.log(`CHECKS ${checks}`);
