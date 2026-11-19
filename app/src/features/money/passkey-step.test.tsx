// A passkey Back through the app's own send step (`useMoneySend`), with the real passkey sender and its real sending part:
// only the signing-and-sending call and the network answers are stand-ins. These bind the defects a review found at the
// seam between the step and the passkey sender: a Back is ONE operation of two calls, so a Back that timed out and
// landed must never be sent again as its second call alone; the record of a sent operation is written at signing, not
// when the wait ends; and the address shown is the sender's, not the other sender's.
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { BundlerRpcError, BundlerTimeoutError } from "@creaton/core/aa/aa.ts";
import { UserOpPendingError } from "@creaton/core/aa/zerodev.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { moneyProblem } from "./money-copy";
import { createPasskeyImpl } from "./passkey-sender-impl";
import {
  createPasskeySender,
  type PasskeyProbe,
  type PasskeySettings,
} from "./passkey-sender";
import { forgetPending, pendingSend, sendKey } from "./pending-sends";
import { type MoneyWallet, WalletStepError } from "./wallet";

const ROUNDS = `0x${"11".repeat(20)}`;
const TOKEN = `0x${"22".repeat(20)}`;
const FROM = `0x${"ab".repeat(20)}`;
const HASH = `0x${"cd".repeat(32)}`;
// The P-256 generator point: any valid uncompressed public key will do for the owner.
const R1 = `04${"6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296"}${"4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5"}`;
const SETTINGS: PasskeySettings = {
  chainId: 31337,
  rpcUrl: "http://rpc.invalid",
  bundlerUrl: "http://bundler.invalid",
};
const PROBE: PasskeyProbe = { credentialId: () => "cred", ownerKey: () => R1 };
const CALLS = [
  { to: TOKEN, data: "0x01", value: "0x0" as const },
  { to: ROUNDS, data: "0x02", value: "0x0" as const },
];
const INPUT = { chainId: 31337, build: () => CALLS, detail: "25000000" };
const KEY = sendKey("back:x", FROM);

type Hook = (options: {
  onSigned: (s: { userOpHash: string; sender: string; nonce: bigint }) => void;
}) => Promise<never>;

/** What the bundler and the node answer to the look-ups of a later press. */
const network = {
  receipt: null as null | { userOpHash: string; success: boolean },
  byHash: null as unknown,
  entryPointSequence: 3n,
};
const fetchImpl = (async (_url: string, init: { body: string }) => {
  const { method, id } = JSON.parse(init.body) as {
    method: string;
    id: number;
  };
  const result =
    method === "eth_getUserOperationReceipt"
      ? network.receipt && {
          ...network.receipt,
          sender: FROM,
          nonce: "0x3",
          actualGasCost: "0x1",
          actualGasUsed: "0x1",
          paymaster: FROM,
          receipt: { transactionHash: HASH, blockNumber: "0x1" },
          logs: [],
        }
      : method === "eth_getUserOperationByHash"
        ? network.byHash
        : method === "eth_call"
          ? `0x${network.entryPointSequence.toString(16).padStart(64, "0")}`
          : null;
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}) as unknown as typeof fetch;

const sendUserOp = vi.fn<(request: Parameters<Hook>[0]) => Promise<never>>();

function passkeySender(): MoneyWallet {
  const storage = {
    getItem: () => JSON.stringify({ chainId: 31337, r1: R1, address: FROM }),
    setItem: () => undefined,
  };
  const impl = createPasskeyImpl(SETTINGS, PROBE, {
    fetchImpl,
    storage,
    sendUserOp: sendUserOp as never,
  });
  return createPasskeySender(SETTINGS, {
    probe: PROBE,
    load: async () => impl,
    knownTargets: () => new Set([ROUNDS, TOKEN]),
  });
}

let current: MoneyWallet;
vi.mock("./sender", async (original) => ({
  ...(await original<typeof import("./sender")>()),
  useSender: () => current,
}));
vi.mock("../../lib/relay", () => ({ read: async () => [] }));

import { useMoneySend, useWalletAddress } from "./use-money";

function render<T>(hook: () => T) {
  const client = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(hook, { wrapper });
}

/** The operation is signed, then the wait ends without a receipt. */
function signedThen(error: () => unknown) {
  sendUserOp.mockImplementationOnce(async (request) => {
    request.onSigned({ userOpHash: HASH, sender: FROM, nonce: 3n });
    throw error();
  });
}

beforeEach(() => {
  applyServerSettings({ investing: true, self: "http://s.invalid" } as never);
  current = passkeySender();
  sendUserOp.mockReset();
  network.receipt = null;
  network.byHash = null;
  network.entryPointSequence = 3n;
  forgetPending(KEY);
});
afterEach(() => {
  cleanup();
  forgetPending(KEY);
  applyServerSettings(null);
});

const press = (
  result: { current: ReturnType<typeof useMoneySend> },
  input = INPUT,
) =>
  act(async () => {
    await result.current.sendAsync(input).catch((e: unknown) => e);
  });

describe("a passkey Back that timed out", () => {
  const timedOut = () =>
    new UserOpPendingError(
      { userOpHash: HASH, sender: FROM, nonce: 3n },
      90,
      2000,
    );

  it("is remembered as the whole step, and when it landed the next press sends nothing", async () => {
    signedThen(timedOut);
    const { result } = render(() => useMoneySend("back:x"));
    await press(result);
    expect(pendingSend(KEY)).toMatchObject({ index: 1, total: 2, hash: HASH });
    network.receipt = { userOpHash: HASH, success: true };
    let sent: unknown;
    await act(async () => {
      sent = await result.current.sendAsync(INPUT);
    });
    // Exactly the one operation of the first press: the ask is never sent again by itself.
    expect(sendUserOp).toHaveBeenCalledTimes(1);
    expect(sent).toMatchObject({ status: "confirmed", txHash: HASH });
    expect(pendingSend(KEY)).toBeNull();
  });

  it("when its place was taken, is looked up with `confirm` and not sent again when that finds it", async () => {
    signedThen(timedOut);
    const { result } = render(() => useMoneySend("back:x"));
    await press(result);
    network.entryPointSequence = 4n;
    const confirm = vi.fn(async () => true);
    await act(async () => {
      await result.current.sendAsync({ ...INPUT, confirm });
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(sendUserOp).toHaveBeenCalledTimes(1);
  });

  it("when its place was taken and there is no way to look, says so and sends nothing", async () => {
    signedThen(timedOut);
    const { result } = render(() => useMoneySend("back:x"));
    await press(result);
    network.entryPointSequence = 4n;
    let error: unknown;
    await act(async () => {
      error = await result.current.sendAsync(INPUT).catch((e: unknown) => e);
    });
    expect(error).toBeInstanceOf(WalletStepError);
    expect((error as WalletStepError).reason).toBe("replaced");
    expect(sendUserOp).toHaveBeenCalledTimes(1);
  });

  it("is sent afresh only once the bundler and the node both say it never was", async () => {
    signedThen(timedOut);
    const { result } = render(() => useMoneySend("back:x"));
    await press(result);
    sendUserOp.mockResolvedValueOnce({
      txHash: HASH,
      success: true,
      userOpHash: HASH,
    } as never);
    await act(async () => {
      await result.current.sendAsync(INPUT);
    });
    expect(sendUserOp).toHaveBeenCalledTimes(2);
  });

  it("a bundler that cannot answer the look-up is 'still pending', never 'never sent'", async () => {
    signedThen(timedOut);
    const { result } = render(() => useMoneySend("back:x"));
    await press(result);
    // It has no receipt, and cannot say whether it holds the operation (an error answer).
    const failing = vi.fn(async (_url: string, init: { body: string }) => {
      const { method, id } = JSON.parse(init.body) as {
        method: string;
        id: number;
      };
      return new Response(
        JSON.stringify(
          method === "eth_getUserOperationReceipt"
            ? { jsonrpc: "2.0", id, result: null }
            : method === "eth_call"
              ? { jsonrpc: "2.0", id, result: `0x${"0".repeat(63)}3` }
              : {
                  jsonrpc: "2.0",
                  id,
                  error: { code: -32000, message: "busy" },
                },
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const impl = createPasskeyImpl(SETTINGS, PROBE, {
      fetchImpl: failing as never,
      storage: {
        getItem: () =>
          JSON.stringify({ chainId: 31337, r1: R1, address: FROM }),
        setItem: () => undefined,
      },
    });
    current = createPasskeySender(SETTINGS, {
      probe: PROBE,
      load: async () => impl,
      knownTargets: () => new Set([ROUNDS, TOKEN]),
    });
    const second = render(() => useMoneySend("back:x"));
    let error: unknown;
    await act(async () => {
      error = await second.result.current
        .sendAsync(INPUT)
        .catch((e: unknown) => e);
    });
    expect((error as WalletStepError).reason).toBe("pending");
    expect(sendUserOp).toHaveBeenCalledTimes(1);
    expect(pendingSend(KEY)).not.toBeNull();
  }, 20_000);
});

describe("the record of a sent operation", () => {
  it("is written the moment it is signed, before any answer, and survives a reload", async () => {
    let release: (() => void) | undefined;
    sendUserOp.mockImplementationOnce(async (request) => {
      request.onSigned({ userOpHash: HASH, sender: FROM, nonce: 3n });
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      throw new BundlerTimeoutError(15_000);
    });
    const { result } = render(() => useMoneySend("back:x"));
    let done: Promise<unknown> = Promise.resolve();
    await act(async () => {
      done = result.current.sendAsync(INPUT).catch((e: unknown) => e);
      await waitFor(() => expect(pendingSend(KEY)).not.toBeNull());
    });
    expect(pendingSend(KEY)).toMatchObject({ hash: HASH, nonce: 3, index: 1 });
    await act(async () => {
      release?.();
      await done;
    });
    expect(pendingSend(KEY)).not.toBeNull(); // timed out: it may still land
  });

  it("is forgotten when the bundler plainly refused the operation", async () => {
    signedThen(
      () =>
        new BundlerRpcError("bundler: RPC error AA23 reverted", {
          code: -32500,
        }),
    );
    const { result } = render(() => useMoneySend("back:x"));
    let error: unknown;
    await act(async () => {
      error = await result.current.sendAsync(INPUT).catch((e: unknown) => e);
    });
    expect((error as WalletStepError).reason).toBe("failed");
    expect(pendingSend(KEY)).toBeNull();
  });

  it("is kept when a retry was told 'already known' after a first try whose answer was lost", async () => {
    signedThen(
      () =>
        new BundlerRpcError(
          "bundler: eth_sendUserOperation RPC error userOperation is already known",
          { code: -32602 },
        ),
    );
    const { result } = render(() => useMoneySend("back:x"));
    let error: unknown;
    await act(async () => {
      error = await result.current.sendAsync(INPUT).catch((e: unknown) => e);
    });
    expect((error as WalletStepError).reason).toBe("pending");
    expect(pendingSend(KEY)).toMatchObject({ hash: HASH });
  });

  it("is kept when a refusal came after a try that may have got through", async () => {
    const error = new BundlerRpcError(
      "bundler: RPC error replacement underpriced",
      { code: -32602 },
    );
    error.maybeDelivered = true;
    signedThen(() => error);
    const { result } = render(() => useMoneySend("back:x"));
    let caught: unknown;
    await act(async () => {
      caught = await result.current.sendAsync(INPUT).catch((e: unknown) => e);
    });
    expect((caught as WalletStepError).reason).toBe("pending");
  });

  it("is forgotten after the step landed", async () => {
    sendUserOp.mockImplementationOnce(async (request) => {
      request.onSigned({ userOpHash: HASH, sender: FROM, nonce: 3n });
      return { txHash: HASH, success: true, userOpHash: HASH } as never;
    });
    const { result } = render(() => useMoneySend("back:x"));
    await act(async () => {
      await result.current.sendAsync(INPUT);
    });
    expect(pendingSend(KEY)).toBeNull();
  });
});

describe("the account shown", () => {
  const stand = (kind: "wallet" | "passkey", address: string) =>
    ({
      kind,
      isAvailable: () => true,
      connectedAddress: async () => address,
      getAddress: async () => address,
    }) as unknown as MoneyWallet;

  it("is the sender's own, also right after the person switches sender", async () => {
    const wallet = stand("wallet", `0x${"11".repeat(20)}`);
    const passkey = stand("passkey", `0x${"22".repeat(20)}`);
    current = wallet;
    const { result, rerender } = render(() => useWalletAddress());
    await waitFor(() =>
      expect(result.current.data).toBe(`0x${"11".repeat(20)}`),
    );
    current = passkey;
    rerender();
    await waitFor(() =>
      expect(result.current.data).toBe(`0x${"22".repeat(20)}`),
    );
    current = wallet;
    rerender();
    await waitFor(() =>
      expect(result.current.data).toBe(`0x${"11".repeat(20)}`),
    );
  });
});

describe("what a person reads when the passkey account sent", () => {
  it("speaks of the account, not a wallet, for a send that is still out", async () => {
    signedThen(
      () =>
        new UserOpPendingError(
          { userOpHash: HASH, sender: FROM, nonce: 3n },
          90,
          2000,
        ),
    );
    const { result } = render(() => useMoneySend("back:x"));
    let error: unknown;
    await act(async () => {
      error = await result.current.sendAsync(INPUT).catch((e: unknown) => e);
    });
    const words = moneyProblem(error, "back");
    expect(words).not.toMatch(/wallet/i);
    expect(words).toMatch(/not landed yet/);
  });

  it("keeps the wallet's own words for the wallet", () => {
    const error = new WalletStepError("pending", 0);
    error.sender = "wallet";
    expect(moneyProblem(error, "back")).toMatch(/Your wallet sent it/);
    expect(moneyProblem(new WalletStepError("pending", 0), "back")).toMatch(
      /Your wallet sent it/,
    );
  });

  it("says the passkey account's own words for 'replaced' and 'wrong network'", () => {
    for (const reason of ["replaced", "wrong-network"] as const) {
      const error = new WalletStepError(reason, 0);
      error.sender = "passkey";
      expect(moneyProblem(error, "back")).not.toMatch(/wallet/i);
    }
  });
});
