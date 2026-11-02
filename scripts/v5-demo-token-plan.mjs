// v5-demo-token-plan.mjs — mark the demo launch record as a DAO's Shares.
//
// `buzz launchpad curate` publishes a sale-shaped record: it has the chain, the
// token and the treasury, but no `tokenPlan`, so the app renders the sale page
// and never the project's Decisions/Work tabs. The founder re-signs their own
// record with `tokenPlan: { mode: "dao", … }` added — the same author, the same
// `d` tag, a replaceable event. Nothing is invented: the token and treasury are
// the ones the fixture just deployed, and the supply is that DAO's own.
//
// LOCAL ONLY: loopback relay, the fixture's public anvil key. No .env, no wallet.

import { createRequire } from "node:module";
import path from "node:path";

const RELAY = process.env.RELAY ?? "http://127.0.0.1:3030";
const PUB = process.env.FOUNDER_PUB ?? "";
const PK = (process.env.FOUNDER_PK ?? "").replace(/^0x/, "");
if (!/^[0-9a-f]{64}$/.test(PK) || !/^[0-9a-f]{64}$/.test(PUB)) {
  throw new Error("FOUNDER_PK and FOUNDER_PUB must be 32-byte hex");
}
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(RELAY)) {
  throw new Error(`refusing a non-loopback relay: ${RELAY}`);
}

const here = path.dirname(new URL(import.meta.url).pathname);
const require = createRequire(path.join(here, "..", "web", "node_modules", "package.json"));
const { finalizeEvent } = require("nostr-tools");

const headers = { "content-type": "application/json", "X-Pubkey": PUB };

const query = await fetch(`${RELAY}/query`, {
  method: "POST",
  headers,
  body: JSON.stringify([{ kinds: [37001], authors: [PUB], "#d": ["demo"] }]),
});
if (!query.ok) throw new Error(`query failed: HTTP ${query.status}`);
const [event] = await query.json();
if (!event) throw new Error("the demo launch record was not found");

const content = JSON.parse(event.content);
const supply = "200000000000000000000";
content.tokenPlan = {
  mode: "dao",
  name: "Docs Demo",
  symbol: "DOCS",
  supply,
};

const signed = finalizeEvent(
  {
    kind: 37001,
    created_at: Math.floor(Date.now() / 1000),
    tags: event.tags,
    content: JSON.stringify(content),
  },
  Uint8Array.from(Buffer.from(PK, "hex")),
);

const publish = await fetch(`${RELAY}/events`, {
  method: "POST",
  headers,
  body: JSON.stringify(signed),
});
const answer = await publish.text();
if (!publish.ok) throw new Error(`publish failed: HTTP ${publish.status} ${answer}`);
console.log(`demo record ${signed.id} now names a DAO token plan`);
