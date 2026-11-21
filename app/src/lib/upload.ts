/**
 * Sending a picture to this server's media store (Blossom, BUD-11): `PUT /upload` with a signed upload permit
 * (kind 24242: `t=upload`, an expiry, this server, and the picture's hash) and the hash again in `X-SHA-256`.
 *
 * Only bytes that are already clean are sent (`features/pictures`); this module hashes and sends them and says why a
 * refusal happened in the server's words, which the caller turns into plain ones (`uploadFailureWords`).
 */
import { assertMayAct } from "@creaton/core/client/action-guard.ts";
import { signAsUser } from "@creaton/core/client/identity.ts";
import { relayHttpBaseUrl } from "@creaton/core/client/relay-url.ts";
import { timedFetchBody } from "@creaton/core/client/timed-fetch.ts";

/** What the server answers for a stored picture. */
export interface UploadedBlob {
  url: string;
  sha256: string;
  size: number;
  type: string;
}

/** How long an upload may take before it is given up (a picture is at most a few megabytes). */
const UPLOAD_DEADLINE_MS = 60_000;

/** The lower-case hex SHA-256 of `bytes`. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/** Store `bytes` as a picture of kind `mime` on this server. Throws with the server's own reason when it refuses. */
export async function uploadPicture(
  bytes: Uint8Array,
  mime: string,
): Promise<UploadedBlob> {
  // Changed terms not yet agreed to: nothing goes out as the person.
  assertMayAct();
  const sha256 = await sha256Hex(bytes);
  const uploadUrl = `${relayHttpBaseUrl()}/upload`;
  const now = Math.floor(Date.now() / 1000);
  const permit = await signAsUser({
    kind: 24242,
    tags: [
      ["t", "upload"],
      ["expiration", String(now + 3600)],
      ["server", new URL(uploadUrl).host],
      ["x", sha256],
    ],
    content: "Upload a picture",
  });
  const reply = await timedFetchBody(uploadUrl, {
    method: "PUT",
    headers: {
      Authorization: `Nostr ${btoa(JSON.stringify(permit))}`,
      "X-SHA-256": sha256,
      "Content-Type": mime,
    },
    body: bytes as BodyInit,
    timeoutMs: UPLOAD_DEADLINE_MS,
  });
  const status = reply.response.status;
  const body = (reply.json ?? {}) as {
    error?: unknown;
  } & Partial<UploadedBlob>;
  if (status < 200 || status >= 300) {
    throw new Error(
      typeof body.error === "string" && body.error
        ? body.error
        : `upload failed (${status})`,
    );
  }
  if (typeof body.url !== "string" || typeof body.sha256 !== "string")
    throw new Error("upload failed (no address)");
  return {
    url: body.url,
    sha256: body.sha256,
    size: typeof body.size === "number" ? body.size : bytes.length,
    type: typeof body.type === "string" ? body.type : mime,
  };
}
