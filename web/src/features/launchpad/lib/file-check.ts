/**
 * Checking a file someone handed in against the fingerprint they stated for it.
 *
 * A fingerprint in a record is its signer's word. Until the file is downloaded and its SHA-256 worked out here, the
 * page has checked nothing, and says so. The check downloads the file (up to a bound, and no further), works out the
 * fingerprint in the browser and compares the two.
 *
 * Pure and alias-free: `file-check.test.mjs` drives it under `node --test`.
 */

/** The most a check downloads. A larger file is not read to the end and is not called a match or a mismatch. */
const CHECK_MAX_BYTES = 25 * 1024 * 1024;

export type FileCheck =
  | { result: "match" }
  /** The file at the address is not the one the fingerprint is of. */
  | { result: "differs"; found: string }
  | { result: "too-big" }
  /** It could not be downloaded here (the address is gone, or its server does not let this page read it). */
  | { result: "failed" };

interface CheckResponse {
  ok: boolean;
  headers: { get: (name: string) => string | null };
  body: {
    getReader: () => {
      read: () => Promise<{ done: boolean; value?: Uint8Array }>;
      cancel: () => Promise<void>;
    };
  } | null;
  arrayBuffer: () => Promise<ArrayBuffer>;
}

const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

/** Download `url` (at most `max` bytes) and compare its SHA-256 with `hash`. Never throws. */
export async function checkFile(
  url: string,
  hash: string,
  deps: {
    fetch: (url: string) => Promise<CheckResponse>;
    digest: (bytes: Uint8Array) => Promise<ArrayBuffer>;
    max?: number;
  },
): Promise<FileCheck> {
  const max = deps.max ?? CHECK_MAX_BYTES;
  try {
    const response = await deps.fetch(url);
    if (!response.ok) return { result: "failed" };
    const stated = Number(response.headers.get("content-length") ?? "0");
    if (stated > max) return { result: "too-big" };
    const parts: Uint8Array[] = [];
    let size = 0;
    if (response.body) {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        size += value.length;
        // The stated length is the server's word; the bytes that arrive are what is counted.
        if (size > max) {
          await reader.cancel().catch(() => undefined);
          return { result: "too-big" };
        }
        parts.push(value);
      }
    } else {
      const all = new Uint8Array(await response.arrayBuffer());
      if (all.length > max) return { result: "too-big" };
      parts.push(all);
      size = all.length;
    }
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const part of parts) {
      bytes.set(part, at);
      at += part.length;
    }
    const found = hex(await deps.digest(bytes));
    return found === hash.toLowerCase()
      ? { result: "match" }
      : { result: "differs", found };
  } catch {
    return { result: "failed" };
  }
}

/** What the page says after a check. */
export function fileCheckLine(check: FileCheck): string {
  switch (check.result) {
    case "match":
      return "Checked just now: the file at this address matches the fingerprint.";
    case "differs":
      return "Checked just now: the file at this address does NOT match the fingerprint. It is not the file that was handed in.";
    case "too-big":
      return "This file is too large to check here.";
    case "failed":
      return "The file could not be downloaded to check it. Its address may be gone, or its server may not let this page read it.";
  }
}

/** The site a link goes to ("example.org"), or null when it is not a web link. */
export function linkHost(href: string): string | null {
  try {
    const url = new URL(href);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.host
      : null;
  } catch {
    return null;
  }
}
