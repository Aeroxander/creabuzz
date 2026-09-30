/**
 * Publish one signed event to the relay, completing NIP-42 first.
 *
 * Used by the real-relay suite to act as a second person: the app under test is
 * one identity, and the test needs another to mention it.
 */
import { finalizeEvent } from "nostr-tools/pure";

export function keyFromNsec(nsec) {
  return Uint8Array.from(
    nsec.match(/.{2}/g).map((byte) => Number.parseInt(byte, 16)),
  );
}

/** Publish `event` (an unsigned template) as `nsec`. Resolves with the relay's OK. */
export function publishAs(nsec, event, relay = "ws://localhost:3199") {
  const key = keyFromNsec(nsec);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(relay);
    const send = (payload) => ws.send(JSON.stringify(payload));
    let sent = false;

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
        send(["EVENT", finalizeEvent(event, key)]);
        return;
      }
      resolve({
        id: data[1],
        accepted: Boolean(data[2]),
        reason: data[3] ?? "",
      });
    });

    setTimeout(() => reject(new Error("timed out publishing")), 15_000);
  });
}
