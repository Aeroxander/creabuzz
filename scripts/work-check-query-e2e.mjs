// work-check-query-e2e.mjs — bounded fixture harness for the kind:47010 #c
// query pushdown validation. Publishes 1 older target + N newer unrelated
// work-check-run records as a FRESH fixture identity through the REAL relay
// HTTP bridge (POST /events, NIP-98), then exercises the frozen UI query shape
// {"kinds":[47010],"#c":[target],"limit":N} via POST /query, POST /count, and
// the WS REQ path (NIP-42 auth), asserting:
//   1. the older target is returned (pre-LIMIT pushdown, newer records intact)
//   2. COUNT over the same filter returns exactly 1
//   3. a wrong #c context returns nothing
//   4. community scope does not cross hosts (event not visible via host B)
//
// LOCAL ONLY: every endpoint env var is validated to be a loopback host on a
// non-default port. Any non-loopback host or default port aborts before any
// network call. No secrets are printed (the fresh fixture key exists only in
// this process's memory).
//
// Env:
//   WC_E2E_MAIN   http://127.0.0.1:<mainport>   (host A — fixture community)
//   WC_E2E_ALT    http://localhost:<mainport>   (host B — cross-scope probe)
//   WC_E2E_WS     ws://127.0.0.1:<mainport>     (WS REQ probe, host A)
//   WC_NOISE_COUNT  number of newer unrelated records (default 60)

import { createRequire } from "node:module";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const modulesDir =
  process.env.WC_E2E_NODE_MODULES ??
  path.join(here, "..", "web", "node_modules");
const require = createRequire(path.join(modulesDir, "package.json"));
const {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} = require("nostr-tools");

const MAIN = validateLocalEndpoint(
  process.env.WC_E2E_MAIN,
  "WC_E2E_MAIN",
  "http:",
);
const ALT = validateLocalEndpoint(
  process.env.WC_E2E_ALT,
  "WC_E2E_ALT",
  "http:",
);
const WS_URL = validateLocalEndpoint(process.env.WC_E2E_WS, "WC_E2E_WS", "ws:");
const NOISE_COUNT = Number(process.env.WC_NOISE_COUNT ?? 60);
if (!Number.isInteger(NOISE_COUNT) || NOISE_COUNT < 1 || NOISE_COUNT > 500) {
  fail(
    `WC_NOISE_COUNT must be an integer in [1, 500], got ${process.env.WC_NOISE_COUNT}`,
  );
}

const results = [];
function pass(label) {
  results.push({ label, passed: true });
  console.log(`PASS ${label}`);
}
function fail(label) {
  throw new Error(`FAIL ${label}`);
}
function assert(cond, label, detail) {
  if (!cond) {
    results.push({ label, passed: false });
    throw new Error(
      `FAIL ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`,
    );
  }
  pass(label);
}

function randomHex(bytes) {
  return `0x${randomBytes(bytes).toString("hex").toLowerCase()}`;
}
function hashWord() {
  return randomHex(32);
}

// Local-only endpoint validation: hostname must be loopback alias, port must
// be non-default. Anything else aborts before a single request is made.
function validateLocalEndpoint(raw, name, scheme) {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error(`FAIL ${name} env var is required`);
  }
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`FAIL ${name} is not a valid URL: ${raw}`);
  }
  if (url.protocol !== scheme) {
    throw new Error(
      `FAIL ${name} must use ${scheme} protocol, got ${url.protocol}`,
    );
  }
  const loopback = new Set(["127.0.0.1", "localhost", "[::1]"]);
  if (!loopback.has(url.hostname)) {
    throw new Error(
      `FAIL ${name} must target a loopback host (127.0.0.1/localhost/[::1]) for local-only tests; refusing public endpoint ${url.hostname}`,
    );
  }
  const port = Number(url.port ?? (scheme === "ws:" ? 80 : 80));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`FAIL ${name} must carry an explicit port, got ${raw}`);
  }
  if (port === 80 || port === 443) {
    throw new Error(
      `FAIL ${name} must use a dedicated non-default port for local-only tests`,
    );
  }
  return url;
}

// ── NIP-98 auth token ────────────────────────────────────────────────────────
// tag set: ["u", url], ["method", m], ["payload", sha256(body)] — matches
// buzz-auth normalize_url + body-hash verification (bridge passes require_payload
// in NIP-FI enforce mode; harmless otherwise).
function hex(buf) {
  return buf.toString("hex");
}
function nip98Token(skFixed, method, url, bodyString = "") {
  const authEvent = {
    kind: 27235,
    content: "",
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["u", url],
      ["method", method.toUpperCase()],
      [
        "payload",
        hex(createHash("sha256").update(bodyString, "utf8").digest()),
      ],
    ],
  };
  const signed = finalizeEvent(authEvent, skFixed);
  return `Nostr ${Buffer.from(JSON.stringify(signed), "utf8").toString("base64")}`;
}

const SH = { sk: generateSecretKey() };
const SK_PUBKEY = getPublicKey(SH.sk);

async function postBridge(url, path, filter) {
  // Bridge POST /query and /count take a raw JSON ARRAY of NIP-01 filters.
  const body = JSON.stringify([filter]);
  const target = `${url.origin}${path}`;
  const token = nip98Token(SH.sk, "POST", target, body);
  const res = await fetch(target, {
    method: "POST",
    headers: {
      authorization: token,
      "content-type": "application/json",
    },
    body,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(
      `FAIL ${path} returned non-JSON (${res.status}): ${text.slice(0, 400)}`,
    );
  }
  if (res.status !== 200) {
    throw new Error(`FAIL ${path} HTTP ${res.status}: ${text.slice(0, 400)}`);
  }
  return json;
}

// ── fixture events ──────────────────────────────────────────────────────────
function checkRunEvent(ctx, claim, evidence, mandate, createdAt) {
  const record = {
    claim,
    mandate,
    evidence: hashWord(), // illustrative run output; identity lives in #c tags
    checks: [{ name: "fixture-check", status: "passed" }],
    summary: { fixture: true },
    claimed: false,
  };
  return finalizeEvent(
    {
      kind: 47010,
      content: JSON.stringify(record),
      created_at: createdAt,
      tags: [
        ["c", ctx],
        ["claim", claim],
        ["evidence", evidence],
        ["mandate", mandate],
      ],
    },
    SH.sk,
  );
}

// Canonical #c triplet retained by the frozen plan: '0x'+20-byte address
// ':' + '0x'+32-byte claim + ':' + '0x'+32-byte evidence (lowercase hex).
function buildContext() {
  return `${randomHex(20)}:${hashWord()}:${hashWord()}`;
}

async function publish(event) {
  const body = JSON.stringify(event);
  const token = nip98Token(SH.sk, "POST", `${MAIN.origin}/events`, body);
  const res = await fetch(`${MAIN.origin}/events`, {
    method: "POST",
    headers: { authorization: token, "content-type": "application/json" },
    body,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(
      `FAIL publish ${event.id} returned non-JSON (${res.status}): ${text.slice(0, 400)}`,
    );
  }
  if (res.status !== 200) {
    throw new Error(
      `FAIL publish ${event.id} HTTP ${res.status}: ${text.slice(0, 400)}`,
    );
  }
  assert(
    json.accepted === true,
    `publish accepted kind=47010 id=${event.id.slice(0, 12)}…`,
    json,
  );
  if (json.event_id) {
    assert(
      json.event_id === event.id,
      "publish event_id matches signed event id",
    );
  }
}

async function main() {
  console.log(`fixture identity: ${SK_PUBKEY}`);
  console.log(
    `fixture endpoints (local only): ${MAIN.origin}, ${ALT.origin}, ${WS_URL.origin}`,
  );

  const now = Math.floor(Date.now() / 1000);
  const targetCtx = buildContext();
  // Ingest enforces ±15 min (900 s) created_at drift; keep the target at the
  // deepest legal "older" depth and the noise strictly between it and "now".
  const targetEvent = checkRunEvent(
    targetCtx,
    hashWord(),
    hashWord(),
    randomHex(20),
    now - 890, // OLDER than every noise record
  );
  const noise = [];
  const baseTs = now - 450;
  for (let i = 0; i < NOISE_COUNT; i++) {
    const ctx = buildContext();
    noise.push(
      checkRunEvent(
        ctx,
        hashWord(),
        hashWord(),
        randomHex(20),
        baseTs + i, // newer than target, strictly increasing, within drift bounds
      ),
    );
  }

  // Publish noise first, then the older target (arrival order must not matter —
  // ordering in SQL is created_at DESC and the target is fully pushable).
  for (const ev of noise) {
    await publish(ev);
  }
  await publish(targetEvent);

  // ── A. frozen UI shape: target reachable under newer noise ───────────────
  const queried = await postBridge(MAIN, "/query", {
    kinds: [47010],
    "#c": [targetCtx],
    limit: 1,
  });
  assert(Array.isArray(queried), "/query returns a JSON array", queried);
  assert(
    queried.length === 1,
    "/query limit=1 returns exactly the target",
    queried.length,
  );
  assert(
    queried[0].id === targetEvent.id,
    "/query returns the OLDER target id despite newer records",
  );
  assert(
    queried[0].pubkey === SK_PUBKEY,
    "/query target pubkey is the fixture identity",
  );
  const targetTags = JSON.stringify(queried[0].tags ?? []).toLowerCase();
  assert(
    targetTags.includes(targetCtx.toLowerCase()),
    "returned target carries the #c context",
  );

  const wide = await postBridge(MAIN, "/query", {
    kinds: [47010],
    "#c": [targetCtx],
    limit: 50,
  });
  assert(
    Array.isArray(wide) && wide.length === 1 && wide[0].id === targetEvent.id,
    "/query UI shape (limit=50) returns exactly the target",
  );

  // Sanity control: without #c the newest noise wins before any post-filter —
  // proves ordering + LIMIT are active and the target is genuinely older.
  const control = await postBridge(MAIN, "/query", {
    kinds: [47010],
    limit: 1,
  });
  assert(
    Array.isArray(control) &&
      control.length === 1 &&
      control[0].id === noise[NOISE_COUNT - 1].id,
    "control (no #c, limit=1) returns the newest unrelated record",
  );

  // ── B. COUNT over the pushable filter ────────────────────────────────────
  const counted = await postBridge(MAIN, "/count", {
    kinds: [47010],
    "#c": [targetCtx],
  });
  assert(
    counted.count === 1,
    "/count for target context returns exactly 1",
    counted,
  );

  // ── C. wrong #c context matches nothing ──────────────────────────────────
  const wrongCtx = buildContext();
  const wrong = await postBridge(MAIN, "/query", {
    kinds: [47010],
    "#c": [wrongCtx],
    limit: 10,
  });
  assert(
    Array.isArray(wrong) && wrong.length === 0,
    "/query for a never-published context returns []",
  );
  const wrongCount = await postBridge(MAIN, "/count", {
    kinds: [47010],
    "#c": [wrongCtx],
  });
  assert(
    wrongCount.count === 0,
    "/count for a never-published context returns 0",
    wrongCount,
  );

  // ── D. community scope does not cross hosts ──────────────────────────────
  const cross = await postBridge(ALT, "/query", {
    kinds: [47010],
    "#c": [targetCtx],
    limit: 10,
  });
  assert(
    Array.isArray(cross) && cross.length === 0,
    "the same query via host B returns [] (no cross-community leak)",
  );
  const crossCount = await postBridge(ALT, "/count", {
    kinds: [47010],
    "#c": [targetCtx],
  });
  assert(
    crossCount.count === 0,
    "/count via host B returns 0 (no cross-community leak)",
    crossCount,
  );

  // ── E. WS REQ path (NIP-42 auth + main client query builder) ─────────────
  await wsReqProbe(targetEvent.id, targetCtx);

  console.log("WORK-CHECK-QUERY-E2E: ALL PASS");
}

function wsSend(ws, obj) {
  ws.send(JSON.stringify(obj));
}

async function wsReqProbe(targetId, targetCtx) {
  if (typeof WebSocket === "undefined") {
    throw new Error(
      "FAIL ws probe requires the WebSocket global — run node with --experimental-websocket ...",
    );
  }
  const ws = new WebSocket(WS_URL);
  const subCursor = {
    id: null,
    event: null,
    eose: false,
    opened: false,
    authOk: false,
  };
  const donePromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("FAIL ws probe timed out after 15s")),
      15_000,
    );
    const finish = (cb) => {
      clearTimeout(timeout);
      cb();
    };
    try {
      ws.addEventListener("open", () => {
        subCursor.opened = true;
      });
      ws.addEventListener("message", async (evt) => {
        let frame;
        try {
          frame = JSON.parse(String(evt.data));
        } catch {
          return;
        }
        const [type, subOrId, payload] = frame;
        if (type === "AUTH") {
          const challenge = subOrId;
          if (typeof challenge !== "string" || challenge.length === 0) {
            reject(new Error("FAIL ws AUTH challenge is empty"));
            return;
          }
          const authEvent = finalizeEvent(
            {
              kind: 22242,
              content: "",
              created_at: Math.floor(Date.now() / 1000),
              tags: [
                ["relay", WS_URL.origin],
                ["challenge", challenge],
              ],
            },
            SH.sk,
          );
          wsSend(ws, ["AUTH", authEvent]);
          return;
        }
        if (type === "OK") {
          // The AUTH event's OK (kind 22242 with -1 suffix absent) gates REQ.
          if (payload === true) {
            subCursor.authOk = true;
            wsSend(ws, [
              "REQ",
              "wc-e2e-1",
              { kinds: [47010], "#c": [targetCtx], limit: 1 },
            ]);
          }
          return;
        }
        if (type === "EVENT") {
          if (subOrId === "wc-e2e-1") {
            subCursor.id = payload.id;
            subCursor.event = payload;
          }
          return;
        }
        if (type === "EOSE" && subOrId === "wc-e2e-1") {
          subCursor.eose = true;
          // WS REQ note: the NIP-42 identity auth proves the REQ path, even
          // though the anonymous-open connection never got a challenge deny.
          finish(() =>
            resolve({
              authOk: subCursor.authOk,
              id: subCursor.id,
              eose: subCursor.eose,
              event: subCursor.event,
            }),
          );
          return;
        }
        if (type === "CLOSED" && subOrId === "wc-e2e-1") {
          reject(new Error(`FAIL ws REQ closed before EOSE: ${payload}`));
        }
      });
      ws.addEventListener("error", () => {
        reject(new Error("FAIL ws connection error"));
      });
      ws.addEventListener("close", () => {
        if (!subCursor.eose) {
          reject(new Error("FAIL ws connection closed before EOSE"));
        }
      });
    } catch (err) {
      finish(() => reject(err));
    }
  });
  try {
    const out = await donePromise;
    assert(out.authOk === true, "ws NIP-42 auth accepted");
    assert(out.eose === true, "ws REQ reached EOSE");
    assert(
      out.id === targetId,
      "ws REQ returned the OLDER target id with #c filter",
      out.id,
    );
    ws.close();
  } catch (err) {
    try {
      ws.close();
    } catch {}
    throw err;
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  const failures = results.filter((r) => !r.passed);
  console.log(
    JSON.stringify(
      {
        note: "work-check-query-e2e",
        failedLabel: failures.map((f) => f.label),
      },
      null,
      2,
    ),
  );
  process.exit(1);
});
