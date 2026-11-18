/**
 * Helpers for the social real-relay suite: other people's keys, publishing
 * pre-signed events (gift wraps are not signed by the person authenticating),
 * and reading as someone (p-gated reads need that person's NIP-42 auth).
 */
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";

export const keyFromHex = (hex) =>
  Uint8Array.from(hex.match(/.{2}/g).map((b) => Number.parseInt(b, 16)));

/** Deterministic test people. The app under test is DEV (see seed.sql). */
export const PEOPLE = {
  dev: "3dbaebadb5dfd777ff25149ee230d907a15a9e1294b40b830661e65bb42f6c03",
  alice: "a1".repeat(32),
  bob: "b2".repeat(32),
  carol: "c3".repeat(32),
};
export const pubkeyOf = (name) => getPublicKey(keyFromHex(PEOPLE[name]));

function authEvent(key, relay, challenge) {
  return finalizeEvent(
    {
      kind: 22242,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["relay", relay],
        ["challenge", String(challenge)],
      ],
      content: "",
    },
    key,
  );
}

/** Publish an already-signed event while authenticated as `authNsec`. */
export function publishSigned(authNsec, event, relay = "ws://localhost:3199") {
  const key = keyFromHex(authNsec);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(relay);
    let sent = false;
    ws.addEventListener("message", (message) => {
      const data = JSON.parse(String(message.data));
      if (data[0] === "AUTH") {
        ws.send(JSON.stringify(["AUTH", authEvent(key, relay, data[1])]));
        return;
      }
      if (data[0] !== "OK") return;
      if (!sent) {
        sent = true;
        ws.send(JSON.stringify(["EVENT", event]));
        return;
      }
      ws.close();
      resolve({
        id: data[1],
        accepted: Boolean(data[2]),
        reason: data[3] ?? "",
      });
    });
    setTimeout(() => reject(new Error("timed out publishing")), 15_000);
  });
}

/** Sign `template` as `name` and publish it. Resolves with the signed event. */
export async function post(name, template, relay) {
  const signed = finalizeEvent(
    { created_at: Math.floor(Date.now() / 1000), ...template },
    keyFromHex(PEOPLE[name]),
  );
  const result = await publishSigned(PEOPLE[name], signed, relay);
  if (!result.accepted) {
    throw new Error(`${name} kind ${template.kind} refused: ${result.reason}`);
  }
  return signed;
}

/** Read events as `name` (so p-gated filters such as gift wraps are allowed). */
export function readAs(name, filter, relay = "ws://localhost:3199") {
  const key = keyFromHex(PEOPLE[name]);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(relay);
    const events = [];
    let asked = false;
    const ask = () => {
      if (asked) return;
      asked = true;
      ws.send(JSON.stringify(["REQ", "r", filter]));
    };
    ws.addEventListener("message", (message) => {
      const data = JSON.parse(String(message.data));
      if (data[0] === "AUTH") {
        ws.send(JSON.stringify(["AUTH", authEvent(key, relay, data[1])]));
        return;
      }
      if (data[0] === "OK") ask();
      else if (data[0] === "EVENT") events.push(data[2]);
      else if (data[0] === "EOSE") {
        ws.close();
        resolve(events);
      } else if (data[0] === "CLOSED") {
        ws.close();
        reject(new Error(`closed: ${data[2]}`));
      }
    });
    setTimeout(() => reject(new Error("timed out reading")), 15_000);
  });
}

/** Wait until the relay has `count` events matching the filter. */
export async function waitForEvents(name, filter, count = 1, relay) {
  for (let i = 0; i < 40; i += 1) {
    const events = await readAs(name, filter, relay);
    if (events.length >= count) return events;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `relay never held ${count} events for ${JSON.stringify(filter)}`,
  );
}
