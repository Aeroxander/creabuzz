// The last step of Back (plan 4.7): the account is linked to the wallet that made the Back, with one signature (or, on a phone,
// one touch), no extra screen, and never any harm to the Back: a person who says no, or a step that fails, is told where to
// finish it. An account already linked to this wallet for a good while yet is asked for nothing.
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  accountOf,
  linkedWalletRecord,
} from "../../../tests/helpers/linked-wallet";
import { ToastProvider } from "../../ui/toast";
import type { MoneyWallet } from "../money/wallet";
import { reset, world } from "./room-harness";

vi.mock(
  "../../lib/relay",
  async () => (await import("./room-harness")).relayMock,
);
vi.mock(
  "../../lib/account",
  async () => (await import("./room-harness")).accountMock,
);

import { useLinkAfterBack } from "./use-link-after-back";

const KEY = "a3".repeat(32);
const ADDRESS = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";

function wallet(options: {
  kind?: "wallet" | "passkey";
  signs?: boolean;
  sign?: () => Promise<string>;
}) {
  const sign = vi.fn(options.sign ?? (async () => `0x${"11".repeat(65)}`));
  const stand = {
    kind: options.kind ?? "wallet",
    capabilities: {
      signsMessages: options.signs ?? true,
      atomicBatch: false,
      feeSponsored: false,
    },
    isAvailable: () => true,
    getAddress: async () => ADDRESS,
    chainId: async () => 31337,
    readCall: async () => "0x",
    signTypedData: sign,
  } as unknown as MoneyWallet;
  return { stand, sign };
}

function run(stand: MoneyWallet) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>
  );
  const { result } = renderHook(() => useLinkAfterBack(stand), { wrapper });
  return result.current;
}

beforeEach(() => {
  reset();
  world.me = accountOf(KEY);
  applyServerSettings({ investing: true, self: "http://s.invalid" } as never);
});
afterEach(() => {
  cleanup();
  applyServerSettings(null);
});

describe("linking after a Back", () => {
  it("links the account to the wallet with one signature and no other screen", async () => {
    const { stand, sign } = wallet({});
    await expect(run(stand)()).resolves.toBe("linked");
    expect(sign).toHaveBeenCalledTimes(1);
    expect(world.published).toHaveLength(1);
    const sent = world.published[0];
    expect(sent.kind).toBe(37017);
    expect(sent.tags).toContainEqual(["d", ADDRESS]);
    expect(sent.tags).toContainEqual(["chain", "31337"]);
    const body = JSON.parse(sent.content);
    expect(body.attestation.attestation.account).toBe(ADDRESS);
    expect(body.attestation.attestation.expires).toBeGreaterThan(
      Date.now() / 1000 + 360 * 86_400,
    );
  });

  it("has the room read what the person holds again, whatever becomes of the link", async () => {
    const client = new QueryClient();
    client.setQueryData(["room", "holding", "x"], { shares: 0n, team: 0n });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <ToastProvider>{children}</ToastProvider>
      </QueryClientProvider>
    );
    world.signedIn = false;
    const { result } = renderHook(() => useLinkAfterBack(wallet({}).stand), {
      wrapper,
    });
    await result.current();
    expect(client.getQueryState(["room", "holding", "x"])?.isInvalidated).toBe(
      true,
    );
  });

  it("asks for nothing when the account is already linked to this wallet for a good while yet", async () => {
    world.events.push(
      linkedWalletRecord(
        KEY,
        ADDRESS,
        Math.floor(Date.now() / 1000) - 3600,
      ) as never,
    );
    const { stand, sign } = wallet({});
    await expect(run(stand)()).resolves.toBe("already");
    expect(sign).not.toHaveBeenCalled();
    expect(world.published).toHaveLength(0);
  });

  it("asks again when the link is about to end", async () => {
    world.events.push(
      linkedWalletRecord(
        KEY,
        ADDRESS,
        Math.floor(Date.now() / 1000) - 340 * 86_400,
      ) as never,
    );
    const { stand } = wallet({});
    await expect(run(stand)()).resolves.toBe("linked");
  });

  it("does nothing for nobody signed in, a sender that cannot sign, or a phone account on a server that cannot check it", async () => {
    world.signedIn = false;
    expect(await run(wallet({}).stand)()).toBe("skipped");
    world.signedIn = true;
    expect(await run(wallet({ signs: false }).stand)()).toBe("skipped");
    applyServerSettings({
      investing: true,
      self: "http://s.invalid",
      smartAccountLinks: false,
    } as never);
    const phone = wallet({ kind: "passkey" });
    expect(await run(phone.stand)()).toBe("skipped");
    expect(phone.sign).not.toHaveBeenCalled();
    // The same server is no obstacle to an ordinary wallet.
    expect(await run(wallet({}).stand)()).toBe("linked");
  });

  it("a person who says no is not asked again, and the Back stands", async () => {
    const { stand, sign } = wallet({
      sign: async () => {
        throw new Error("You rejected the request in your wallet.");
      },
    });
    await expect(run(stand)()).resolves.toBe("declined");
    expect(sign).toHaveBeenCalledTimes(1);
    expect(world.published).toHaveLength(0);
  });

  it("a passkey prompt that was closed counts as a no", async () => {
    const { stand, sign } = wallet({
      kind: "passkey",
      sign: async () => {
        throw Object.assign(new Error("The operation is not allowed."), {
          name: "NotAllowedError",
        });
      },
    });
    await expect(run(stand)()).resolves.toBe("declined");
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it("a step that fails is tried once more, and then left for the Room tab's press", async () => {
    let calls = 0;
    const flaky = wallet({
      sign: async () => {
        calls += 1;
        if (calls === 1) throw new Error("The network hiccupped.");
        return `0x${"11".repeat(65)}`;
      },
    });
    await expect(run(flaky.stand)()).resolves.toBe("linked");
    expect(flaky.sign).toHaveBeenCalledTimes(2);
    const broken = wallet({
      sign: async () => {
        throw new Error("The network is down.");
      },
    });
    await expect(run(broken.stand)()).resolves.toBe("failed");
    expect(broken.sign).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(world.published).toHaveLength(1));
  });
});
