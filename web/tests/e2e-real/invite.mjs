/**
 * Mint a relay invite over HTTP as an owner/admin, the way the app would.
 *
 * The endpoint requires NIP-98 (`kind:27235`) with the POST body covered by a
 * `payload` tag, so this signs exactly that — the same shape the web client
 * builds in `shared/lib/nip98.ts`, but reachable from Node where the suite runs.
 */
import { createHash, randomUUID } from "node:crypto";

import { finalizeEvent } from "nostr-tools/pure";

export async function mintInvite({
  nsec,
  baseUrl = "http://localhost:3199",
  body = "{}",
}) {
  const key = Uint8Array.from(
    nsec.match(/.{2}/g).map((byte) => Number.parseInt(byte, 16)),
  );
  const url = `${baseUrl.replace(/\/+$/, "")}/api/invites`;
  const event = finalizeEvent(
    {
      kind: 27235,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["u", url],
        ["method", "POST"],
        ["payload", createHash("sha256").update(body).digest("hex")],
        ["nonce", randomUUID()],
      ],
      content: "",
    },
    key,
  );

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}`,
      "Content-Type": "application/json",
    },
    body,
  });
  const json = await response.json();
  if (!response.ok) {
    throw new Error(
      `invite mint failed (${response.status}): ${JSON.stringify(json)}`,
    );
  }
  return json;
}
