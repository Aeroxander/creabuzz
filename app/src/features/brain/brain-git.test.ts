import type { HttpClient } from "@creaton/core/client/git-http.ts";
import { describe, expect, it } from "vitest";
import { BrainTooBigError, capped, DOWNLOAD_MAX_BYTES } from "./brain-git";

function replying(parts: Uint8Array[]): HttpClient {
  return {
    async request({ url }) {
      let at = 0;
      const body: AsyncIterableIterator<Uint8Array> = {
        async next() {
          return at < parts.length
            ? { done: false, value: parts[at++] }
            : { done: true, value: undefined };
        },
        [Symbol.asyncIterator]() {
          return body;
        },
      };
      return { url, statusCode: 200, statusMessage: "OK", body };
    },
  };
}

async function drain(http: HttpClient): Promise<number> {
  const reply = await http.request({ url: "https://server.example/git/x" });
  let total = 0;
  if (reply.body) for await (const part of reply.body) total += part.byteLength;
  return total;
}

describe("the download cap", () => {
  it("lets a small repository through untouched", async () => {
    expect(await drain(capped(replying([new Uint8Array(1000)])))).toBe(1000);
  });

  it("ends the read with a plain error when the replies add up to more than the cap", async () => {
    const chunk = new Uint8Array(512 * 1024);
    const parts = Array.from({ length: 3 }, () => chunk);
    await expect(drain(capped(replying(parts)))).rejects.toBeInstanceOf(
      BrainTooBigError,
    );
    expect(DOWNLOAD_MAX_BYTES).toBe(1024 * 1024);
  });

  it("counts across the requests of one read, not one at a time", async () => {
    const http = capped(replying([new Uint8Array(700 * 1024)]));
    expect(await drain(http)).toBe(700 * 1024);
    await expect(drain(http)).rejects.toBeInstanceOf(BrainTooBigError);
  });
});
