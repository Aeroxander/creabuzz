// A person's linked wallet as the app reads it: an ordinary wallet's proof is checked on this device, a phone account's is
// checked by asking the account on the network (its own ERC-1271 answer), and until that can be asked it is "not checked",
// never "linked".
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { ERC1271_MAGIC } from "@creaton/core/aa/kernel-signature.ts";
import {
  newWalletAttestation,
  siweMessageHash,
} from "@creaton/core/account/wallet-proof.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MoneyWallet } from "../money/wallet";

const KEY = Uint8Array.from(Buffer.from("a3".repeat(32), "hex"));
const ME = getPublicKey(KEY);
const ACCOUNT = `0x${"ab".repeat(20)}`;
const NOW = Math.floor(Date.now() / 1000);

/** A phone account's link: its signature is no 65-byte wallet signature, so only the account itself can say it is valid. */
function phoneLink(at = NOW - 3600) {
  const attestation = newWalletAttestation(ACCOUNT, ME, 31337, at, 9);
  attestation.signature = `0x00${"cd".repeat(150)}`;
  return finalizeEvent(
    {
      kind: 37017,
      created_at: at,
      tags: [
        ["d", ACCOUNT],
        ["address", ACCOUNT],
        ["chain", "31337"],
      ],
      content: JSON.stringify({
        v: 1,
        address: ACCOUNT,
        siweMessageHash: siweMessageHash(
          "Link this wallet to my Creaton account.",
        ),
        attestation,
      }),
    },
    KEY,
  );
}

let stored: unknown[] = [];
vi.mock("../../lib/relay", () => ({
  read: async () => stored,
  publishAsUser: async () => undefined,
}));
let current: MoneyWallet;
vi.mock("../money/sender", async (original) => ({
  ...(await original<typeof import("../money/sender")>()),
  useSender: () => current,
}));

import { useTeamWallets } from "./use-wallets";

const account = (answer: string, chain = 31337, available = true) =>
  ({
    kind: "passkey",
    isAvailable: () => available,
    chainId: async () => chain,
    readCall: vi.fn(async () => answer),
  }) as unknown as MoneyWallet;

function link() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(() => useTeamWallets([ME]), { wrapper });
}

beforeEach(() => {
  applyServerSettings({ investing: true, self: "http://s.invalid" } as never);
  stored = [phoneLink()];
});
afterEach(() => applyServerSettings(null));

describe("a phone account's wallet link", () => {
  it("is linked when the account says its signature is valid, and keeps when the proof ends", async () => {
    current = account(`${ERC1271_MAGIC}${"0".repeat(56)}`);
    const { result } = link();
    await waitFor(() => expect(result.current.data?.[ME]).toBeDefined());
    expect(result.current.data?.[ME]).toEqual({
      state: "linked",
      address: ACCOUNT,
      expires: NOW - 3600 + 365 * 86400,
    });
  });

  it("is not linked when the account says no", async () => {
    current = account(`0xffffffff${"0".repeat(56)}`);
    const { result } = link();
    await waitFor(() => expect(result.current.data?.[ME]).toBeDefined());
    expect(result.current.data?.[ME]).toEqual({ state: "none" });
  });

  it("is only 'not checked' when the network cannot be asked: no sender, or another network", async () => {
    current = account(`${ERC1271_MAGIC}${"0".repeat(56)}`, 31337, false);
    const none = link();
    await waitFor(() => expect(none.result.current.data?.[ME]).toBeDefined());
    expect(none.result.current.data?.[ME]).toEqual({ state: "unchecked" });
    current = account(`${ERC1271_MAGIC}${"0".repeat(56)}`, 1);
    const other = link();
    await waitFor(() => expect(other.result.current.data?.[ME]).toBeDefined());
    expect(other.result.current.data?.[ME]).toEqual({ state: "unchecked" });
  });
});
