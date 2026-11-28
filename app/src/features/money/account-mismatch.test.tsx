// The passkey account's address is worked out on the phone and checked against the server's node: a node that gives
// another address for the same passkey is refused, and nothing is shown or sent from it. Each test goes through the
// production seam (the impl the sender loads, the sender, the You card), with a node that answers `eth_call` as told.
import { kernel033AddressLocal } from "@creaton/core/aa/kernel033-address.ts";
import { parseR1PublicKey } from "@creaton/core/aa/kernel033.ts";
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SERVER, wrap } from "../../../tests/helpers/money-harness";
import { ACCOUNT_MISMATCH_WORDS } from "./copy";
import { potProblem } from "./problems";
import {
  createPasskeySender,
  type PasskeyProbe,
  type PasskeySettings,
} from "./passkey-sender";
import { createPasskeyImpl } from "./passkey-sender-impl";
import { SenderChoice } from "./SenderChoice";
import { isAccountMismatch, WalletStepError } from "./wallet";

const R1 = `04${"11".repeat(32)}${"22".repeat(32)}`;
const MINE = kernel033AddressLocal(parseR1PublicKey(R1));
const LIAR = `0x${"ee".repeat(20)}`;
const SETTINGS: PasskeySettings = {
  chainId: 31337,
  rpcUrl: "http://rpc.invalid",
  bundlerUrl: "http://bundler.invalid",
};
const PROBE: PasskeyProbe = { credentialId: () => "cred", ownerKey: () => R1 };
const TOKEN = `0x${"22".repeat(20)}`;

/** A node whose answer to every `eth_call` is the account `says` (its asks are counted). */
function node(says: string) {
  const asked: string[] = [];
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    const { method, id } = JSON.parse(init.body) as {
      method: string;
      id: number;
    };
    asked.push(method);
    const result =
      method === "eth_call" ? `0x${says.slice(2).padStart(64, "0")}` : null;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, asked };
}

function memory(initial?: string) {
  let saved = initial ?? null;
  return {
    getItem: () => saved,
    setItem: (_key: string, value: string) => {
      saved = value;
    },
    read: () => saved,
  };
}

describe("the account address, worked out on the phone and checked against the node", () => {
  it("is the node's address when the two agree, and is remembered after one match", async () => {
    const { fetchImpl, asked } = node(MINE);
    const storage = memory();
    const impl = createPasskeyImpl(SETTINGS, PROBE, { fetchImpl, storage });
    expect(await impl.getAddress()).toBe(MINE);
    expect(JSON.parse(storage.read() ?? "{}")).toMatchObject({ address: MINE });
    // A reload with the match remembered asks the node nothing more.
    const calls = asked.length;
    const again = createPasskeyImpl(SETTINGS, PROBE, {
      fetchImpl,
      storage: memory(storage.read() ?? undefined),
    });
    expect(await again.getAddress()).toBe(MINE);
    expect(asked.length).toBe(calls);
  });

  it("refuses a node that gives another address: nothing is returned, remembered or sent", async () => {
    const { fetchImpl } = node(LIAR);
    const storage = memory();
    const sendUserOp = vi.fn();
    const impl = createPasskeyImpl(SETTINGS, PROBE, {
      fetchImpl,
      storage,
      sendUserOp: sendUserOp as never,
    });
    const refused = (promise: Promise<unknown>) =>
      promise.then(
        () => null,
        (e: unknown) => e,
      );
    expect(isAccountMismatch(await refused(impl.getAddress()))).toBe(true);
    expect(isAccountMismatch(await refused(impl.connectedAddress()))).toBe(
      true,
    );
    const sent = await refused(
      impl.sendCalls([{ to: TOKEN, data: "0x01", value: "0x0" }], 31337),
    );
    expect(isAccountMismatch(sent)).toBe(true);
    expect(sendUserOp).not.toHaveBeenCalled();
    expect(storage.read()).toBeNull();
  });

  it("does not trust a remembered address that is not the one worked out here, and asks the node again", async () => {
    const stale = JSON.stringify({ chainId: 31337, r1: R1, address: LIAR });
    const honest = createPasskeyImpl(SETTINGS, PROBE, {
      fetchImpl: node(MINE).fetchImpl,
      storage: memory(stale),
    });
    expect(await honest.getAddress()).toBe(MINE);
    const lying = createPasskeyImpl(SETTINGS, PROBE, {
      fetchImpl: node(LIAR).fetchImpl,
      storage: memory(stale),
    });
    await expect(lying.getAddress()).rejects.toMatchObject({
      reason: "account-mismatch",
    });
  });

  it("is told by the sender, not shown as an account that is just not read yet", async () => {
    const lying = createPasskeySender(SETTINGS, {
      probe: PROBE,
      load: async () =>
        createPasskeyImpl(SETTINGS, PROBE, {
          fetchImpl: node(LIAR).fetchImpl,
          storage: memory(),
        }),
    });
    await expect(lying.connectedAddress()).rejects.toBeInstanceOf(
      WalletStepError,
    );
    // Any other failure to read is still "no account yet".
    const down = createPasskeySender(SETTINGS, {
      probe: PROBE,
      load: async () =>
        createPasskeyImpl(SETTINGS, PROBE, {
          fetchImpl: (async () => {
            throw new Error("offline");
          }) as unknown as typeof fetch,
          storage: memory(),
        }),
    });
    expect(await down.connectedAddress()).toBeNull();
  });

  it("reads as a plain sentence with no protocol words", () => {
    const words = potProblem(
      new WalletStepError("account-mismatch", 0),
      "back",
    );
    expect(words).toBe(ACCOUNT_MISMATCH_WORDS);
    expect(words).toMatch(/does not match/);
    expect(words).toMatch(/nothing was sent/i);
    expect(words).not.toMatch(/factory|CREATE2|bundler|paymaster|0x|nonce/i);
  });
});

describe("You: the passkey account's address", () => {
  const stubBuild = () => {
    vi.stubEnv("VITE_CREATON_PASSKEY_ACCOUNT", "1");
    vi.stubEnv("VITE_CREATON_CHAIN_ID", "31337");
    vi.stubEnv("VITE_CREATON_RPC_URL", "http://rpc.invalid");
    vi.stubEnv("VITE_CREATON_BUNDLER_URL", "http://bundler.invalid");
    localStorage.setItem("buzz.passkey.credentialId", "cred");
    localStorage.setItem(
      "buzz.passkey.salt",
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQ",
    );
    localStorage.setItem("buzz.passkey.pubkey", "a".repeat(64));
    localStorage.setItem("buzz.passkey.mode", "unlock");
    localStorage.setItem("buzz.passkey.r1", R1);
  };
  beforeEach(() => {
    localStorage.clear();
    applyServerSettings({ investing: true, self: SERVER });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    applyServerSettings(null);
  });

  it("shows the address when the node agrees", async () => {
    stubBuild();
    vi.stubGlobal("fetch", node(MINE).fetchImpl);
    wrap(<SenderChoice />);
    await waitFor(() =>
      expect(screen.getByTestId("sender-address").textContent).toBe(MINE),
    );
    expect(screen.queryByTestId("sender-address-mismatch")).toBeNull();
  });

  it("shows no address, and says why, when the node gives another one", async () => {
    stubBuild();
    vi.stubGlobal("fetch", node(LIAR).fetchImpl);
    wrap(<SenderChoice />);
    const alert = await screen.findByTestId("sender-address-mismatch");
    expect(alert.textContent).toBe(ACCOUNT_MISMATCH_WORDS);
    expect(alert.getAttribute("role")).toBe("alert");
    expect(screen.queryByTestId("sender-address")).toBeNull();
    expect(document.body.textContent).not.toContain(LIAR);
  });
});
