/**
 * Create the real-relay tests' channel the way a client does.
 *
 * Channel discovery metadata (kind:39000) is relay-authored, so a channel
 * inserted straight into Postgres stays invisible to every client. Publishing a
 * kind:9007 as a relay member makes the relay create the channel and emit its
 * discovery events.
 *
 * Usage: node create-channel.mjs [name] [relay-ws-url]
 *
 * The relay rate-limits channel creation per identity, so a re-run right after
 * a previous one waits for the quota instead of failing.
 */
import { finalizeEvent } from "nostr-tools/pure";

const DEV_NSEC =
  process.env.BUZZ_REAL_RELAY_NSEC ??
  "3dbaebadb5dfd777ff25149ee230d907a15a9e1294b40b830661e65bb42f6c03";
const name = process.argv[2] ?? "general";
const relay = process.argv[3] ?? "ws://localhost:3199";
const key = Uint8Array.from(
  DEV_NSEC.match(/.{2}/g).map((byte) => Number.parseInt(byte, 16)),
);

const ws = new WebSocket(relay);
const send = (payload) => ws.send(JSON.stringify(payload));
let sent = false;

const create = () =>
  send([
    "EVENT",
    finalizeEvent(
      {
        kind: 9007,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ["name", name],
          ["about", "General discussion"],
          ["visibility", "open"],
          ["channel_type", "stream"],
        ],
        content: "",
      },
      key,
    ),
  ]);

ws.addEventListener("message", (message) => {
  const data = JSON.parse(String(message.data));
  if (data[0] === "AUTH") {
    send([
      "AUTH",
      finalizeEvent(
        {
          kind: 22242,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ["relay", relay],
            ["challenge", String(data[1])],
          ],
          content: "",
        },
        key,
      ),
    ]);
    return;
  }
  if (data[0] !== "OK") return;
  if (!sent) {
    sent = true;
    create();
    return;
  }
  const [, id, accepted, reason = ""] = data;
  if (accepted) {
    console.log(`channel "${name}" ready (${id.slice(0, 12)})`);
    process.exit(0);
  }
  // Already there, or rate-limited: both are fine for a fixture.
  console.log(`channel "${name}": ${reason}`);
  process.exit(/already exists|duplicate/i.test(reason) ? 0 : 1);
});

setTimeout(() => {
  console.error("timed out creating the channel");
  process.exit(1);
}, 15_000);
