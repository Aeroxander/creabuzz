/**
 * The passkey account's address, worked out on the phone, against the real deployed factory on a real chain: for the
 * phone's own passkey and for fresh keys the two agree, and a node that lies about the factory's answer is refused before
 * anything is shown, signed or sent. Run by `scripts/phone-loop.sh`; skipped without `M7_ANVIL_RPC`.
 */
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getKernel033Sender } from "../../../packages/creaton-core/src/aa/kernel033.ts";
import { kernel033AddressLocal } from "../../../packages/creaton-core/src/aa/kernel033-address.ts";
import { passkeyIdentity } from "../../../packages/creaton-core/src/account/passkey-identity.ts";
import { createPasskeyImpl } from "../../src/features/money/passkey-sender-impl";
import { createPasskeySender } from "../../src/features/money/passkey-sender";
import { isAccountMismatch } from "../../src/features/money/wallet";
import { pass, phoneWorld } from "./phone-world";
import { accounts, call, RPC } from "./rpc";

const run = RPC ? describe : describe.skip;
const big = (b64url: string) =>
  BigInt(`0x${Buffer.from(b64url, "base64url").toString("hex")}`);

run("the passkey account's address against the real factory", () => {
  it("is the factory's own answer for the phone's passkey and for fresh keys", async () => {
    const [admin] = await accounts();
    const world = await phoneWorld(admin);
    try {
      const rpc = {
        ethCall: ({ to, data }: { to: string; data: string }) => call(to, data),
      };
      // The phone's own passkey: the sender returns an address only when the factory says the same.
      const shown = (await world.sender.getAddress()).toLowerCase();
      const owner = passkeyIdentity()?.evmOwner.r1UncompressedHex;
      expect(owner).toBeTruthy();
      pass(
        "the phone's account address is worked out from its passkey and equals what the real factory says",
      );
      // Fresh keys: the local derivation and the factory agree for each.
      for (let i = 0; i < 5; i += 1) {
        const jwk = generateKeyPairSync("ec", {
          namedCurve: "P-256",
        }).publicKey.export({
          format: "jwk",
        });
        const key = {
          pubKeyX: big(String(jwk.x)),
          pubKeyY: big(String(jwk.y)),
        };
        expect(kernel033AddressLocal(key)).toBe(
          (await getKernel033Sender({ ...key, rpc })).toLowerCase(),
        );
      }
      expect(shown).toMatch(/^0x[0-9a-f]{40}$/);
      pass(
        "for five fresh passkey keys the address worked out on the phone equals the real factory's answer",
      );
    } finally {
      await world.close();
    }
  });

  it("refuses a node that lies about the factory's answer: nothing shown, no passkey prompt, nothing sent", async () => {
    const [admin] = await accounts();
    const world = await phoneWorld(admin);
    try {
      const liar = `0x${"ee".repeat(20)}`;
      const lyingFetch = (async (url: string, init: { body: string }) => {
        const body = JSON.parse(init.body) as {
          method: string;
          id: number;
          params?: { to?: string }[];
        };
        // The factory's `getAddress` answer is replaced; every other answer is the chain's own.
        if (
          body.method === "eth_call" &&
          body.params?.[0]?.to?.toLowerCase() ===
            "0x2577507b78c2008ff367261cb6285d44ba5ef2e9"
        )
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              result: `0x${liar.slice(2).padStart(64, "0")}`,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        return fetch(url, init as RequestInit);
      }) as unknown as typeof fetch;
      const sender = createPasskeySender(world.settings, {
        knownTargets: () => new Set([world.chain.token]),
        load: async (s, p) =>
          createPasskeyImpl(s, p, { fetchImpl: lyingFetch, storage: null }),
      });
      const sentBefore = world.bundler.sent.length;
      const promptsBefore = world.authenticator.calls.get;
      const caught = await sender.connectedAddress().then(
        () => null,
        (e: unknown) => e,
      );
      expect(isAccountMismatch(caught)).toBe(true);
      const sent = await sender
        .sendCalls([{ to: world.chain.token, data: "0x", value: "0x0" }], 31337)
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(isAccountMismatch(sent)).toBe(true);
      expect(world.bundler.sent.length).toBe(sentBefore);
      expect(world.authenticator.calls.get).toBe(promptsBefore);
      pass(
        "a node that lies about the account address is refused: no address is shown, no passkey prompt, nothing sent",
      );
    } finally {
      await world.close();
    }
  });
});
