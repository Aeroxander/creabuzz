#!/usr/bin/env node
// A stand-in for a web push service, for tests and loops. No dependencies, no real service, no real key.
//
//   node scripts/web-push-standin.mjs [--port N]      serve (prints "standin listening on 127.0.0.1:<port>")
//   node scripts/web-push-standin.mjs --self-test      decrypt RFC 8291 appendix A's own message and exit 0 when it reads
//
// It does what a push service and a browser do together, so a test can read what the relay really sent:
//
//   POST /_vapid     {"publicKey": "<base64url, 65 bytes>"}   the operator's public key the VAPID tokens are checked against
//   POST /_devices   {}  ->  {"endpoint", "keys": {"p256dh", "auth"}}   a new device: key pair and auth secret made here,
//                    the endpoint is this server's own address (put its host:port in BUZZ_WEB_PUSH_EXTRA_HOSTS)
//   POST /_script    {"answers": [201, 410, {"status": 429, "retryAfter": 120}]}   answer the next pushes as listed
//   GET  /_received  every push so far: path, headers, the decrypted message (or why not), the VAPID check
//   POST /_reset     forget what was received
//   POST /push/<id>  a push to a device (the relay's sender): decrypted (RFC 8291, aes128gcm), the token verified (RFC 8292)
//
// Answers 201 unless scripted. Everything lives in memory; nothing is written anywhere.

import crypto from "node:crypto";
import http from "node:http";

const b64u = (buffer) => Buffer.from(buffer).toString("base64url");
const unb64u = (text) => Buffer.from(text.replace(/=+$/, ""), "base64url");

/** Decrypt one aes128gcm push message with a device's private key, public key and auth secret (RFC 8291 section 3). */
export function decrypt(body, device) {
  if (body.length < 86 + 17) throw new Error("the body is too short for one record");
  const salt = body.subarray(0, 16);
  const recordSize = body.readUInt32BE(16);
  const idLength = body[20];
  if (recordSize !== 4096 || idLength !== 65) throw new Error("not the header this sender writes");
  const asPublic = body.subarray(21, 21 + idLength);
  const ciphertext = body.subarray(21 + idLength);
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.setPrivateKey(device.privateKey);
  const secret = ecdh.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), device.publicKey, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync("sha256", secret, device.auth, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const decipher = crypto.createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const plain = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
  let end = plain.length;
  while (end > 0 && plain[end - 1] === 0) end -= 1;
  if (end === 0 || plain[end - 1] !== 2) throw new Error("no padding delimiter");
  return plain.subarray(0, end - 1).toString("utf8");
}

/** Check a VAPID token (RFC 8292) against a public key (65 bytes, uncompressed); returns its claims. */
export function verifyVapid(token, publicKey) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("a token has three parts");
  const header = JSON.parse(unb64u(parts[0]).toString("utf8"));
  if (header.alg !== "ES256") throw new Error("the algorithm is not ES256");
  const key = crypto.createPublicKey({
    key: { kty: "EC", crv: "P-256", x: b64u(publicKey.subarray(1, 33)), y: b64u(publicKey.subarray(33, 65)) },
    format: "jwk",
  });
  const good = crypto.verify(
    "sha256",
    Buffer.from(`${parts[0]}.${parts[1]}`),
    { key, dsaEncoding: "ieee-p1363" },
    unb64u(parts[2]),
  );
  if (!good) throw new Error("the signature does not verify");
  return JSON.parse(unb64u(parts[1]).toString("utf8"));
}

function selfTest() {
  // RFC 8291 appendix A: the RFC's own device keys and the RFC's own message.
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.setPrivateKey(unb64u("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94"));
  const device = {
    privateKey: unb64u("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94"),
    publicKey: ecdh.getPublicKey(),
    auth: unb64u("BTBZMqHH6r4Tts7J_aSIgg"),
  };
  const message = Buffer.concat([
    unb64u("DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8"),
    unb64u("8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ"),
  ]);
  const plain = decrypt(message, device);
  if (plain !== "When I grow up, I want to be a watermelon") throw new Error(`read "${plain}"`);
  // RFC 8292 section 2's own token, against its own key.
  const claims = verifyVapid(
    "eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiJ9.eyJhdWQiOiJodHRwczovL3B1c2guZXhhbXBsZS5uZXQiLCJleHAiOjE0NTM1MjM3NjgsInN1YiI6Im1haWx0bzpwdXNoQGV4YW1wbGUuY29tIn0.i3CYb7t4xfxCDquptFOepC9GAu_HLGkMlMuCGSK2rpiUfnK9ojFwDXb1JrErtmysazNjjvW2L9OkSSHzvoD1oA",
    unb64u("BA1Hxzyi1RUM1b5wjxsn7nGxAszw2u61m164i3MrAIxHF6YK5h4SDYic-dRuU_RCPCfA5aq9ojSwk5Y2EmClBPs"),
  );
  if (claims.aud !== "https://push.example.net") throw new Error("the RFC's token reads wrong");
  console.log("web-push-standin: the RFC 8291 message and the RFC 8292 token read");
}

function serve(port) {
  const devices = new Map(); // path -> { privateKey, publicKey, auth }
  let received = [];
  let script = [];
  let vapidPublic = null;
  const server = http.createServer((request, response) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size <= 16 * 1024) chunks.push(chunk);
    });
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      const url = new URL(request.url, "http://127.0.0.1");
      const json = (status, value) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(value));
      };
      try {
        if (url.pathname === "/_vapid" && request.method === "POST") {
          vapidPublic = unb64u(JSON.parse(body.toString("utf8")).publicKey);
          return json(200, { ok: true });
        }
        if (url.pathname === "/_devices" && request.method === "POST") {
          const ecdh = crypto.createECDH("prime256v1");
          ecdh.generateKeys();
          const auth = crypto.randomBytes(16);
          const path = `/push/${crypto.randomBytes(12).toString("hex")}`;
          devices.set(path, { privateKey: ecdh.getPrivateKey(), publicKey: ecdh.getPublicKey(), auth });
          const host = request.headers.host;
          return json(200, {
            endpoint: `http://${host}${path}`,
            keys: { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(auth) },
          });
        }
        if (url.pathname === "/_script" && request.method === "POST") {
          script = JSON.parse(body.toString("utf8")).answers ?? [];
          return json(200, { ok: true });
        }
        if (url.pathname === "/_received") return json(200, received);
        if (url.pathname === "/_reset" && request.method === "POST") {
          received = [];
          script = [];
          return json(200, { ok: true });
        }
        if (url.pathname.startsWith("/push/") && request.method === "POST") {
          const device = devices.get(url.pathname);
          const entry = {
            path: url.pathname,
            topic: request.headers.topic ?? null,
            ttl: request.headers.ttl ?? null,
            urgency: request.headers.urgency ?? null,
            contentEncoding: request.headers["content-encoding"] ?? null,
            message: null,
            messageError: null,
            vapid: null,
            vapidError: null,
          };
          try {
            if (!device) throw new Error("no device is registered at this path");
            entry.message = decrypt(body, device);
          } catch (e) {
            entry.messageError = String(e.message ?? e);
          }
          try {
            const auth = request.headers.authorization ?? "";
            const token = /(?:^|, |\s)t=([^,\s]+)/.exec(auth)?.[1];
            const key = /(?:^|, |\s)k=([^,\s]+)/.exec(auth)?.[1];
            if (!auth.startsWith("vapid ") || !token || !key) throw new Error("not a vapid header");
            if (!vapidPublic) throw new Error("the operator's public key was not given to the stand-in");
            if (!unb64u(key).equals(vapidPublic)) throw new Error("k is not the operator's public key");
            entry.vapid = verifyVapid(token, vapidPublic);
          } catch (e) {
            entry.vapidError = String(e.message ?? e);
          }
          received.push(entry);
          const next = script.shift() ?? 201;
          const status = typeof next === "number" ? next : next.status;
          const headers = typeof next === "object" && next.retryAfter ? { "retry-after": String(next.retryAfter) } : {};
          response.writeHead(status, headers);
          return response.end();
        }
        response.writeHead(404);
        response.end();
      } catch (e) {
        json(400, { error: String(e.message ?? e) });
      }
    });
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`standin listening on 127.0.0.1:${server.address().port}`);
  });
}

const args = process.argv.slice(2);
if (args.includes("--self-test")) {
  selfTest();
} else {
  const at = args.indexOf("--port");
  serve(at >= 0 ? Number(args[at + 1]) : 0);
}
