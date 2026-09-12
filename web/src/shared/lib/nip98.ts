/**
 * NIP-98 HTTP Auth helper — signs a kind:27235 event for authenticating
 * HTTP requests to the relay (used by isomorphic-git for smart HTTP transport).
 */

import { signForRelay } from "./relay-auth";

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Build a NIP-98 Authorization header value.
 *
 * Signed POST bodies include the payload digest required by invite endpoints.
 */
export async function makeNip98AuthHeader(
  url: string,
  method: string,
  options?: {
    body?: string;
    /** The signer must be a browser extension. */
    requireNip07?: boolean;
    /** The signer must be an identity that survives a reload (see `relay-auth`). */
    requireDurable?: boolean;
  },
): Promise<string> {
  const tags = [
    ["u", url],
    ["method", method],
  ];
  if (options?.body !== undefined) {
    tags.push(["payload", await sha256Hex(options.body)]);
    tags.push(["nonce", crypto.randomUUID()]);
  }
  const event = await signForRelay(
    {
      kind: 27235,
      tags,
      content: "",
    },
    {
      requireNip07: options?.requireNip07,
      requireDurable: options?.requireDurable,
    },
  );

  const json = JSON.stringify(event);
  const base64 = btoa(json);
  return `Nostr ${base64}`;
}
