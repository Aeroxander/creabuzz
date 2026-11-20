// chain-loop-query.mjs — the HTTP half of scripts/chain-loop-pot.sh.
//
// Reads the relay's "project numbers" record (kind 39009) for one project with
// a NIP-98 signed POST /query, as any account on an open server would, and
// checks that a posted copy of the kind is refused by POST /events. The key is
// made for the run and never written down.
//
//   node scripts/chain-loop-query.mjs read   <relay http url> <project key> [wait-for dotted.path=value]
//   node scripts/chain-loop-query.mjs forge  <relay http url> <project key>
//
// `read` prints the record's content (JSON) on stdout. With a condition such as
// totals.tookOut=2500000000 it polls (up to CHAIN_LOOP_WAIT_SECS, default 60)
// until the record's content has that value; with asOf.block>=123 until the
// number is at least that (the record has caught up with a block).

import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, "..", "web", "node_modules", "package.json"));
const { finalizeEvent, generateSecretKey } = require("nostr-tools");

const KIND_PROJECT_NUMBERS = 39009;
const sk = generateSecretKey();

function token(method, url, body) {
  const auth = finalizeEvent(
    {
      kind: 27235,
      content: "",
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["u", url],
        ["method", method],
        ["payload", createHash("sha256").update(body, "utf8").digest("hex")],
      ],
    },
    sk,
  );
  return `Nostr ${Buffer.from(JSON.stringify(auth), "utf8").toString("base64")}`;
}

async function post(base, route, body) {
  const url = `${base}${route}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { authorization: token("POST", url, body), "content-type": "application/json" },
    body,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  return { status: res.status, text };
}

function valueAt(obj, dotted) {
  return dotted.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

async function read(base, key, condition) {
  const body = JSON.stringify([{ kinds: [KIND_PROJECT_NUMBERS], "#d": [key], limit: 1 }]);
  const [, want, op, wantValue] = condition ? (condition.match(/^([^=<>]+)(>=|=)(.*)$/) ?? []) : [];
  if (condition && !want) throw new Error(`cannot read the condition ${condition}`);
  const holds = (value) => (op === ">=" ? Number(value) >= Number(wantValue) : String(value) === wantValue);
  const deadline = Date.now() + Number(process.env.CHAIN_LOOP_WAIT_SECS ?? 60) * 1000;
  let last = "";
  while (Date.now() < deadline) {
    const { status, text } = await post(base, "/query", body);
    if (status !== 200) throw new Error(`POST /query answered ${status}: ${text.slice(0, 300)}`);
    const events = JSON.parse(text);
    const list = Array.isArray(events) ? events : (events.events ?? []);
    if (list.length > 0) {
      const content = JSON.parse(list[0].content);
      last = JSON.stringify(valueAt(content, want ?? "version"));
      if (!want || holds(valueAt(content, want))) {
        console.log(JSON.stringify({ event: { id: list[0].id, pubkey: list[0].pubkey, created_at: list[0].created_at, tags: list[0].tags }, content }));
        return;
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`no record with ${condition} in time (last value: ${last || "no record"})`);
}

async function forge(base, key) {
  const forged = finalizeEvent(
    {
      kind: KIND_PROJECT_NUMBERS,
      content: JSON.stringify({ version: 2, money: { pot: "999999999999" } }),
      created_at: Math.floor(Date.now() / 1000),
      tags: [["d", key]],
    },
    sk,
  );
  const body = JSON.stringify(forged);
  const { status, text } = await post(base, "/events", body);
  if (status === 200 && /"accepted"\s*:\s*true/.test(text)) {
    throw new Error(`a posted project numbers record was accepted: ${text}`);
  }
  if (!/relay-only/.test(text)) throw new Error(`refused, but not as relay-only (${status}): ${text}`);
  console.log(JSON.stringify({ status, refused: text.slice(0, 200) }));
}

const [mode, base, key, condition] = process.argv.slice(2);
try {
  if (mode === "read") await read(base, key, condition);
  else if (mode === "forge") await forge(base, key);
  else throw new Error(`unknown mode ${mode}`);
} catch (e) {
  console.error(String(e?.message ?? e));
  process.exit(1);
}
