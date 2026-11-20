// What a passkey account signs besides its money steps: the link that names the person's account, and nothing else. The
// digest the passkey is asked about is the link's own EIP-712 digest wrapped for the account (the way the network's account
// checks it), and a message that is not that link, or that names another account, is refused before any prompt.
import { kernelWrapHash } from "@creaton/core/aa/kernel-signature.ts";
import {
  newWalletAttestation,
  walletAttestationDigest,
  walletTypedData,
} from "@creaton/core/account/wallet-proof.ts";
import { describe, expect, it, vi } from "vitest";
import { createPasskeyImpl, walletLinkDigest } from "./passkey-sender-impl";
import type { PasskeyProbe, PasskeySettings } from "./passkey-sender";

const ACCOUNT = `0x${"ab".repeat(20)}`;
const ME = "cd".repeat(32);
const R1 = `04${"6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296"}${"4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5"}`;
const SETTINGS: PasskeySettings = {
  chainId: 31337,
  rpcUrl: "http://rpc.invalid",
  bundlerUrl: "http://bundler.invalid",
};
const PROBE: PasskeyProbe = { credentialId: () => "cred", ownerKey: () => R1 };
const STORAGE = {
  getItem: () => JSON.stringify({ chainId: 31337, r1: R1, address: ACCOUNT }),
  setItem: () => undefined,
};
const link = () => newWalletAttestation(ACCOUNT, ME, 31337, 1_700_000_000, 7);
const hex = (bytes: Uint8Array) =>
  `0x${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;

describe("the passkey account's link signature", () => {
  it("is asked about the link's own digest, wrapped for the account, in one prompt", async () => {
    const attestation = link();
    const assertion = vi.fn(async () => {
      throw new Error("stop after the challenge");
    });
    const impl = createPasskeyImpl(SETTINGS, PROBE, {
      storage: STORAGE,
      getAssertion: assertion,
    });
    await expect(
      impl.signTypedData?.(ACCOUNT, walletTypedData(attestation)),
    ).rejects.toThrow("stop after the challenge");
    expect(assertion).toHaveBeenCalledTimes(1);
    const asked = (
      assertion.mock.calls[0] as unknown as [{ challenge: Uint8Array }]
    )[0].challenge;
    expect(hex(asked)).toBe(
      kernelWrapHash(hex(walletAttestationDigest(attestation)), ACCOUNT, 31337),
    );
  });

  it("refuses anything that is not that link, and a link naming another account, before any prompt", async () => {
    const assertion = vi.fn();
    const impl = createPasskeyImpl(SETTINGS, PROBE, {
      storage: STORAGE,
      getAssertion: assertion,
    });
    const typed = walletTypedData(link());
    const other = {
      ...typed,
      message: { ...typed.message, expires: 5 },
      types: {
        ...typed.types,
        NostrSigner: [...typed.types.NostrSigner, { name: "x", type: "bool" }],
      },
    };
    await expect(impl.signTypedData?.(ACCOUNT, other)).rejects.toThrow(
      /only the link/,
    );
    await expect(impl.signTypedData?.(ACCOUNT, { hello: 1 })).rejects.toThrow(
      /only the link/,
    );
    await expect(
      impl.signTypedData?.(`0x${"11".repeat(20)}`, typed),
    ).rejects.toMatchObject({ reason: "failed" });
    expect(assertion).not.toHaveBeenCalled();
  });

  it("names the account that signs: a link for someone else's account is not signed", () => {
    const typed = walletTypedData(link());
    expect(() => walletLinkDigest(`0x${"22".repeat(20)}`, typed)).toThrow(
      /only the link/,
    );
    expect(walletLinkDigest(ACCOUNT, typed)).toBe(
      hex(walletAttestationDigest(link())),
    );
  });
});
