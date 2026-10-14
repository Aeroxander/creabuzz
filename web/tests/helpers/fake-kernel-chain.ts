import { createHash, createPublicKey, verify } from "node:crypto";

import type { Page } from "@playwright/test";

import { kernelWrapHash } from "../../src/features/identity/lib/kernel-signature";

/**
 * A stand-in chain node for a passkey account, answering the few calls the app makes and judging `isValidSignature` the
 * way the deployed Kernel 0.3.3 and its passkey validator do (see `kernel-signature.ts`): the signature is
 * `0x00 ‖ (authenticatorData, clientDataJSON, responseTypeLocation, r, s, usePrecompiled)`, the challenge in
 * `clientDataJSON` has to be the Kernel-wrapped hash (account and chain included), and the ES256 signature has to verify
 * under the passkey's public key. So a proof built the wrong way is refused here as it would be on a real chain; one
 * built the right way is accepted. (The real account's answer is checked in `scripts/kernel-1271-live-check.mjs`.)
 */

const FACTORY = "0x2577507b78c2008ff367261cb6285d44ba5ef2e9";
const GET_ADDRESS = "0x48aac392";
const IS_VALID_SIGNATURE = "0x1626ba7e";
const MAGIC = `${IS_VALID_SIGNATURE}${"00".repeat(28)}`;
const REFUSED = `0xffffffff${"00".repeat(28)}`;

export interface FakeKernelChain {
  /** `isValidSignature` questions asked so far, with the verdict given. */
  asked: { account: string; verdict: boolean }[];
  /** Change how the node behaves from now on. */
  setMode: (mode: "honest" | "refuse" | "down") => void;
}

export async function installFakeKernelChain(
  page: Page,
  options: {
    account: string;
    chainId: number;
    /** The passkey's public key, 65-byte uncompressed hex (`04 ‖ x ‖ y`), as the app stores it. */
    publicKey: () => Promise<string>;
    endpoint?: string;
  },
): Promise<FakeKernelChain> {
  const endpoint = options.endpoint ?? "http://127.0.0.1:8545";
  const state: FakeKernelChain & { mode: "honest" | "refuse" | "down" } = {
    mode: "honest",
    asked: [],
    setMode(mode) {
      state.mode = mode;
    },
  };

  const judge = async (account: string, data: string): Promise<boolean> => {
    const bytes = Buffer.from(data.slice(2), "hex");
    const hash = `0x${bytes.subarray(4, 36).toString("hex")}`;
    const at = Number(BigInt(`0x${bytes.subarray(36, 68).toString("hex")}`));
    const length = Number(
      BigInt(`0x${bytes.subarray(at + 4, at + 36).toString("hex")}`),
    );
    const signature = bytes.subarray(at + 36, at + 36 + length);
    if (signature[0] !== 0x00) return false; // 0x00 picks the root validator
    const tuple = signature.subarray(1);
    const word = (i: number) => tuple.subarray(i * 32, i * 32 + 32);
    const number = (i: number) =>
      Number(BigInt(`0x${word(i).toString("hex")}`));
    const dynamic = (i: number) => {
      const start = number(i);
      const size = Number(
        BigInt(`0x${tuple.subarray(start, start + 32).toString("hex")}`),
      );
      return tuple.subarray(start + 32, start + 32 + size);
    };
    const authenticatorData = dynamic(0);
    const clientData = dynamic(1).toString("utf8");
    const wrapped = kernelWrapHash(hash, account, options.chainId);
    const challenge = /"challenge":"([^"]+)"/.exec(clientData)?.[1];
    if (
      clientData.indexOf('"challenge":"') !== 23 ||
      !challenge ||
      Buffer.from(challenge, "base64url").toString("hex") !== wrapped.slice(2)
    ) {
      return false;
    }
    const key = Buffer.from(
      (await options.publicKey()).replace(/^0x/, ""),
      "hex",
    );
    const publicKey = createPublicKey({
      key: {
        kty: "EC",
        crv: "P-256",
        x: key.subarray(1, 33).toString("base64url"),
        y: key.subarray(33, 65).toString("base64url"),
      },
      format: "jwk",
    });
    const signed = Buffer.concat([
      authenticatorData,
      createHash("sha256").update(clientData).digest(),
    ]);
    return verify(
      "sha256",
      signed,
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.concat([word(3), word(4)]),
    );
  };

  await page.route(`${endpoint}/**`, async (route) => {
    const request = JSON.parse(route.request().postData() ?? "{}") as {
      id?: number;
      method?: string;
      params?: unknown[];
    };
    const reply = (result: unknown) =>
      route.fulfill({
        json: { jsonrpc: "2.0", id: request.id ?? 1, result },
      });
    if (state.mode === "down") {
      await route.abort("connectionrefused");
      return;
    }
    if (request.method === "eth_chainId") {
      await reply(`0x${options.chainId.toString(16)}`);
      return;
    }
    if (request.method === "eth_getCode") {
      await reply("0x6080"); // the account exists
      return;
    }
    if (request.method === "eth_call") {
      const call = (request.params?.[0] ?? {}) as {
        to?: string;
        data?: string;
      };
      const to = (call.to ?? "").toLowerCase();
      const data = (call.data ?? "").toLowerCase();
      if (to === FACTORY && data.startsWith(GET_ADDRESS)) {
        await reply(`0x${"00".repeat(12)}${options.account.slice(2)}`);
        return;
      }
      if (data.startsWith(IS_VALID_SIGNATURE)) {
        const verdict =
          state.mode === "honest" && (await judge(to, data).catch(() => false));
        state.asked.push({ account: to, verdict });
        await reply(verdict ? MAGIC : REFUSED);
        return;
      }
    }
    await route.fulfill({
      json: {
        jsonrpc: "2.0",
        id: request.id ?? 1,
        error: { code: -32601, message: `not served: ${request.method}` },
      },
    });
  });
  return state;
}
