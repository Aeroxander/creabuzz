/**
 * Blossom (BUD-11) blob upload to the community relay.
 *
 * PUT /upload with a NIP-98-style kind:24242 auth event (t=upload,
 * expiration, server tag) and the mandatory X-SHA-256 header.
 */

import { signAsUser } from "@/shared/lib/identity";
import { relayHttpBaseUrl } from "@/shared/lib/relay-url";
import { uploadSizeError } from "@/shared/lib/upload-limits";

export interface BlobDescriptor {
  url: string;
  sha256: string;
  size: number;
  type: string;
  uploaded: number;
}

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function uploadBlob(file: File): Promise<BlobDescriptor> {
  // Refuse before reading the file: the body is buffered whole and hashed, so
  // an oversized upload would cost the tab that memory and a full read before
  // the relay rejected it anyway.
  const tooBig = uploadSizeError(file);
  if (tooBig) throw new Error(tooBig);
  const data = await file.arrayBuffer();
  const sha256 = await sha256Hex(data);
  const uploadUrl = `${relayHttpBaseUrl()}/upload`;
  const now = Math.floor(Date.now() / 1000);

  const signed = await signAsUser({
    kind: 24242,
    tags: [
      ["t", "upload"],
      ["expiration", String(now + 3600)],
      ["server", new URL(uploadUrl).host],
      ["x", sha256],
    ],
    content: "buzz web upload",
  });

  const response = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      Authorization: `Nostr ${btoa(JSON.stringify(signed))}`,
      "X-SHA-256": sha256,
      "Content-Type": file.type || "application/octet-stream",
    },
    body: data,
  });

  if (!response.ok) {
    let detail = `upload failed (${response.status})`;
    try {
      const json = (await response.json()) as { error?: string };
      if (json.error) detail = json.error;
    } catch {
      // keep status detail
    }
    throw new Error(detail);
  }

  return (await response.json()) as BlobDescriptor;
}
