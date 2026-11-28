// The Launcher refuses an unknown key with a custom error. A node puts that error's selector in `data` and only decoded junk
// in `message`; a founder on a passkey phone reaches the Launch press only if the chain client keeps the data.
import { createKernel033ChainRpc } from "@creaton/core/aa/kernel033.ts";
import { describe, expect, it } from "vitest";
import { isLaunched } from "./launch-read";

const LAUNCHER = "0x1111111111111111111111111111111111111111";
const KEY = `0x${"ab".repeat(32)}`;

function nodeAnswering(
  error: object,
): ReturnType<typeof createKernel033ChainRpc> {
  return createKernel033ChainRpc({
    url: "http://node.invalid",
    maxAttempts: 1,
    fetchImpl: async () =>
      ({
        status: 200,
        text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, error }),
      }) as Response,
  });
}

describe("isLaunched over the chain client a passkey phone reads with", () => {
  it("reads the Launcher's own refusal, sent as data beside decoded junk, as not launched", async () => {
    const rpc = nodeAnswering({
      code: 3,
      message: "execution reverted: f1A\u000f",
      data: "0x6631410f",
    });
    const read = (to: string, data: string) => rpc.ethCall({ to, data });
    expect(await isLaunched(read, LAUNCHER, KEY)).toBe(false);
  });

  it("still throws when the node refused for another reason", async () => {
    const rpc = nodeAnswering({ code: -32000, message: "header not found" });
    const read = (to: string, data: string) => rpc.ethCall({ to, data });
    await expect(isLaunched(read, LAUNCHER, KEY)).rejects.toThrow();
  });
});
