#!/usr/bin/env node
// scripts/m8-sign.mjs — sign one record with a key and send it to a server, for scripts/m8-agent-week.sh.
//
// The buzz command line has no command for the steps a person takes in the app (post a task, accept work), so the
// real-server loop signs those here, exactly as the app does: one signed record, sent to POST /events with a NIP-98
// authorization. The key is read from the environment (BUZZ_PRIVATE_KEY, hex) and never printed or written anywhere.
//
// Usage:  BUZZ_PRIVATE_KEY=<hex> [BUZZ_AUTH_TAG=<json>] node scripts/m8-sign.mjs <server-base-url> '<{"kind","tags","content"} JSON>'
// Prints one line of JSON: {"status": <http status>, "id": <record id>, "body": <the server's answer>}. Exit 0
// whenever it reached the server (the caller reads `status`); exit 2 when it did not.
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(new URL("../app/package.json", import.meta.url));
const { finalizeEvent } = require("nostr-tools/pure");

const [base, template] = process.argv.slice(2);
const keyHex = process.env.BUZZ_PRIVATE_KEY ?? "";
if (!base || !template || !/^[0-9a-f]{64}$/.test(keyHex)) {
  console.error(
    "usage: BUZZ_PRIVATE_KEY=<64 hex> node scripts/m8-sign.mjs <base-url> '<record JSON>'",
  );
  process.exit(2);
}
const key = Uint8Array.from(Buffer.from(keyHex, "hex"));
const { kind, tags, content } = JSON.parse(template);
const now = () => Math.floor(Date.now() / 1000);
const event = finalizeEvent(
  { kind, tags, content: content ?? "", created_at: now() },
  key,
);
const body = JSON.stringify(event);
const url = `${base.replace(/\/$/, "")}/events`;
const auth = finalizeEvent(
  {
    kind: 27235,
    created_at: now(),
    content: "",
    tags: [
      ["u", url],
      ["method", "POST"],
      ["nonce", randomUUID()],
      ["payload", createHash("sha256").update(body).digest("hex")],
    ],
  },
  key,
);
const headers = {
  "content-type": "application/json",
  authorization: `Nostr ${Buffer.from(JSON.stringify(auth)).toString("base64")}`,
};
if (process.env.BUZZ_AUTH_TAG)
  headers["x-auth-tag"] = process.env.BUZZ_AUTH_TAG;
try {
  const response = await fetch(url, { method: "POST", headers, body });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  console.log(
    JSON.stringify({ status: response.status, id: event.id, body: parsed }),
  );
} catch (error) {
  console.error(`could not reach ${url}: ${error.message}`);
  process.exit(2);
}
