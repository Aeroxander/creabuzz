// scripts/loop-gateway.mjs — five NIP-98 signed chat calls to the relay's LLM gateway, for scripts/loop-test.sh.
//
// Usage: node scripts/loop-gateway.mjs <secret-key-hex> <host:port>
// Prints the five HTTP statuses on one line, comma separated.
import { createRequire } from "node:module";

const require = createRequire(new URL("../packages/creaton-core/package.json", import.meta.url));
const { schnorr } = require("@noble/curves/secp256k1.js");
const { sha256 } = require("@noble/hashes/sha2.js");

const [secretHex, host] = process.argv.slice(2);
if (!secretHex || !host) {
  console.error("usage: loop-gateway.mjs <secret-key-hex> <host:port>");
  process.exit(2);
}
const hex = (b) => Buffer.from(b).toString("hex");
const sk = Buffer.from(secretHex, "hex");
const pk = hex(schnorr.getPublicKey(sk));
const url = `http://${host}/llm/chat/completions`;
const out = [];
for (let i = 1; i <= 5; i++) {
  const body = JSON.stringify({ messages: [{ role: "user", content: `hi ${i}` }] });
  const tags = [["u", url], ["method", "POST"], ["payload", hex(sha256(new TextEncoder().encode(body)))]];
  const created_at = Math.floor(Date.now() / 1000);
  const id = hex(sha256(new TextEncoder().encode(JSON.stringify([0, pk, created_at, 27235, tags, ""]))));
  const sig = hex(schnorr.sign(Buffer.from(id, "hex"), sk));
  const ev = { id, pubkey: pk, created_at, kind: 27235, tags, content: "", sig };
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Nostr ${Buffer.from(JSON.stringify(ev)).toString("base64")}` },
    body,
  });
  out.push(r.status);
}
console.log(out.join(","));
