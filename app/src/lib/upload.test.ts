// Sending a picture: a signed permit naming this server and the picture's hash, the hash again in a header, the bytes as they
// are; a refusal is thrown with the server's own words so the screen can say them plainly.
import { beforeEach, describe, expect, it, vi } from "vitest";

const signed: { kind: number; tags: string[][]; content: string }[] = [];
vi.mock("@creaton/core/client/identity.ts", () => ({
  signAsUser: async (template: {
    kind: number;
    tags: string[][];
    content: string;
  }) => {
    signed.push(template);
    return {
      ...template,
      id: "1".repeat(64),
      pubkey: "2".repeat(64),
      sig: "3".repeat(128),
      created_at: 1,
    };
  },
}));

import { sha256Hex, uploadPicture } from "./upload";

const calls: { url: string; init: RequestInit }[] = [];
let answer: () => Response;
beforeEach(() => {
  signed.length = 0;
  calls.length = 0;
  answer = () =>
    new Response(
      JSON.stringify({
        url: "http://localhost:3000/media/x.jpg",
        sha256: "ab".repeat(32),
        size: 3,
        type: "image/jpeg",
      }),
      { status: 200 },
    );
  globalThis.fetch = vi.fn(
    async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return answer();
    },
  ) as typeof fetch;
});

describe("uploading a picture", () => {
  it("hashes the bytes, signs a permit for that hash and this server, and sends them as they are", async () => {
    const bytes = Uint8Array.of(1, 2, 3);
    const sha = await sha256Hex(bytes);
    expect(sha).toBe(
      "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
    );
    const stored = await uploadPicture(bytes, "image/jpeg");
    expect(stored.url).toBe("http://localhost:3000/media/x.jpg");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://localhost:3000/upload");
    expect(calls[0].init.method).toBe("PUT");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["X-SHA-256"]).toBe(sha);
    expect(headers["Content-Type"]).toBe("image/jpeg");
    expect(headers.Authorization.startsWith("Nostr ")).toBe(true);
    const permit = JSON.parse(atob(headers.Authorization.slice(6)));
    expect(permit.kind).toBe(24242);
    expect(permit.tags).toContainEqual(["t", "upload"]);
    expect(permit.tags).toContainEqual(["x", sha]);
    expect(permit.tags).toContainEqual(["server", "localhost:3000"]);
    expect(calls[0].init.body).toBe(bytes);
  });

  it("throws the server's own words when it refuses", async () => {
    answer = () =>
      new Response(
        JSON.stringify({
          error: "media contains metadata or a non-canonical metadata channel",
        }),
        { status: 422 },
      );
    await expect(uploadPicture(Uint8Array.of(1), "image/jpeg")).rejects.toThrow(
      "media contains metadata or a non-canonical metadata channel",
    );
  });

  it("throws the status when the refusal has no words, and when the answer has no address", async () => {
    answer = () => new Response("nope", { status: 413 });
    await expect(uploadPicture(Uint8Array.of(1), "image/jpeg")).rejects.toThrow(
      "upload failed (413)",
    );
    answer = () => new Response("{}", { status: 200 });
    await expect(uploadPicture(Uint8Array.of(1), "image/jpeg")).rejects.toThrow(
      "upload failed (no address)",
    );
  });
});
