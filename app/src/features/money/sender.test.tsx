// Which sender sends, and what each says when it cannot: the rule that keeps a browser with a wallet exactly as it was,
// the plain words for a phone the server has not set up, and the one place a passkey send can be stopped before it loads
// anything (a wrong network, a contract this app does not know).
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installWallet,
  SERVER,
  wrap,
} from "../../../tests/helpers/money-harness";
import type { MoneyCall } from "./calls";
import { moneyProblem } from "./money-copy";
import {
  createPasskeySender,
  type PasskeyImpl,
  type PasskeyProbe,
  type PasskeySettings,
  passkeySendingOn,
  passkeySettings,
} from "./passkey-sender";
import {
  chooseSender,
  passkeyUnavailableSentence,
  readSenderChoice,
} from "./sender";
import { SenderChoice } from "./SenderChoice";
import {
  injectedWallet,
  type MoneyWallet,
  senderAvailability,
  senderCapabilities,
  senderKind,
  WalletStepError,
} from "./wallet";

const ROUNDS = "0x1111111111111111111111111111111111111111";
const STRANGER = "0x9999999999999999999999999999999999999999";
const SETTINGS: PasskeySettings = {
  chainId: 31337,
  rpcUrl: "http://rpc.invalid",
  bundlerUrl: "http://bundler.invalid",
};
const READY: PasskeyProbe = {
  credentialId: () => "cred",
  ownerKey: () => "04",
};
const NO_PASSKEY: PasskeyProbe = {
  credentialId: () => null,
  ownerKey: () => null,
};
const OLD_PASSKEY: PasskeyProbe = {
  credentialId: () => "cred",
  ownerKey: () => null,
};
const call = (to: string): MoneyCall => ({ to, data: "0xaa", value: "0x0" });

function neverLoaded() {
  const load = vi.fn(async (): Promise<PasskeyImpl> => {
    throw new Error("the sending part must not load here");
  });
  return load;
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  applyServerSettings(null);
  delete (window as { ethereum?: unknown }).ethereum;
});

describe("the build's settings", () => {
  const full = {
    VITE_CREATON_CHAIN_ID: "31337",
    VITE_CREATON_RPC_URL: "http://rpc.invalid",
    VITE_CREATON_BUNDLER_URL: "http://bundler.invalid",
  };
  it("are all three or nothing; the sponsor is optional", () => {
    expect(passkeySettings(full)).toEqual({
      chainId: 31337,
      rpcUrl: "http://rpc.invalid",
      bundlerUrl: "http://bundler.invalid",
    });
    expect(
      passkeySettings({ ...full, VITE_CREATON_SPONSOR_URL: "http://s.invalid" })
        ?.sponsorUrl,
    ).toBe("http://s.invalid");
    for (const missing of Object.keys(full))
      expect(passkeySettings({ ...full, [missing]: undefined })).toBeNull();
    expect(passkeySettings({ ...full, VITE_CREATON_CHAIN_ID: "x" })).toBeNull();
    expect(
      passkeySettings({ ...full, VITE_CREATON_RPC_URL: "javascript:alert(1)" }),
    ).toBeNull();
    expect(passkeySettings({})).toBeNull();
  });
  it("turn passkey sending on only with the switch set to 1", () => {
    expect(passkeySendingOn({})).toBe(false);
    expect(passkeySendingOn({ VITE_CREATON_PASSKEY_ACCOUNT: "0" })).toBe(false);
    expect(passkeySendingOn({ VITE_CREATON_PASSKEY_ACCOUNT: "1" })).toBe(true);
  });
});

describe("the injected wallet as a sender", () => {
  it("says what it is and can do, and is available exactly when a wallet is", () => {
    const wallet = injectedWallet(undefined);
    expect(senderKind(wallet)).toBe("wallet");
    expect(senderAvailability(wallet)).toEqual({
      ok: false,
      reason: "no-wallet",
    });
    expect(senderCapabilities(wallet)).toEqual({
      signsMessages: true,
      atomicBatch: false,
      feeSponsored: false,
    });
    const present = injectedWallet({ request: async () => null });
    expect(senderAvailability(present)).toEqual({ ok: true });
  });
  it("is read the same from a stand-in that says nothing of itself", () => {
    const stand = { isAvailable: () => true } as unknown as MoneyWallet;
    expect(senderKind(stand)).toBe("wallet");
    expect(senderAvailability(stand)).toEqual({ ok: true });
    expect(senderCapabilities(stand).signsMessages).toBe(true);
  });
});

describe("the passkey sender before anything loads", () => {
  it("says why it cannot send, in the order the person can act on it", () => {
    const not = (settings: PasskeySettings | null, probe: PasskeyProbe) =>
      senderAvailability(createPasskeySender(settings, { probe }));
    expect(not(null, READY)).toEqual({ ok: false, reason: "not-set-up" });
    expect(not(null, NO_PASSKEY)).toEqual({ ok: false, reason: "not-set-up" });
    expect(not(SETTINGS, NO_PASSKEY)).toEqual({
      ok: false,
      reason: "no-passkey",
    });
    expect(not(SETTINGS, OLD_PASSKEY)).toEqual({
      ok: false,
      reason: "no-passkey",
    });
    expect(not(SETTINGS, READY)).toEqual({ ok: true });
  });
  it("is a passkey sender that signs no messages and sponsors the fee", () => {
    const sender = createPasskeySender(SETTINGS, { probe: READY });
    expect(senderKind(sender)).toBe("passkey");
    expect(senderCapabilities(sender)).toEqual({
      signsMessages: false,
      atomicBatch: true,
      feeSponsored: true,
    });
    expect(sender.isAvailable()).toBe(true);
  });
  it("sends nothing and loads nothing when not set up, with no passkey, or on another network", async () => {
    const load = neverLoaded();
    const calls = [call(ROUNDS)];
    const known = () => new Set([ROUNDS]);
    await expect(
      createPasskeySender(null, {
        probe: READY,
        load,
        knownTargets: known,
      }).sendCalls(calls, 31337),
    ).rejects.toMatchObject({ reason: "not-set-up" });
    await expect(
      createPasskeySender(SETTINGS, {
        probe: NO_PASSKEY,
        load,
        knownTargets: known,
      }).sendCalls(calls, 31337),
    ).rejects.toMatchObject({ reason: "no-passkey" });
    await expect(
      createPasskeySender(SETTINGS, {
        probe: READY,
        load,
        knownTargets: known,
      }).sendCalls(calls, 1),
    ).rejects.toMatchObject({ reason: "wrong-network" });
    expect(load).not.toHaveBeenCalled();
  });
  it("refuses a contract this app does not know, before anything loads", async () => {
    const load = neverLoaded();
    const sender = createPasskeySender(SETTINGS, {
      probe: READY,
      load,
      knownTargets: () => new Set([ROUNDS]),
    });
    await expect(
      sender.sendCalls([call(ROUNDS), call(STRANGER)], 31337),
    ).rejects.toMatchObject({ reason: "not-known" });
    expect(load).not.toHaveBeenCalled();
  });
  it("hands the very calls it was given, in order, to the part that signs", async () => {
    const sendCalls = vi.fn(async () => ({
      txHash: "0xab",
      status: "confirmed" as const,
      userOpHash: "0xcd",
    }));
    const impl = { sendCalls } as unknown as PasskeyImpl;
    const sender = createPasskeySender(SETTINGS, {
      probe: READY,
      load: async () => impl,
      knownTargets: () => new Set([ROUNDS.toLowerCase(), STRANGER]),
    });
    const calls = [call(ROUNDS), call(STRANGER)];
    const options = { onPhase: () => {} };
    const result = await sender.sendCalls(calls, 31337, options);
    expect(result.userOpHash).toBe("0xcd");
    expect(sendCalls).toHaveBeenCalledWith(calls, 31337, options);
  });
  it("asks a second time for the part that signs when the first load failed", async () => {
    const impl = {
      getAddress: async () => "0xaccount",
    } as unknown as PasskeyImpl;
    let tries = 0;
    const sender = createPasskeySender(SETTINGS, {
      probe: READY,
      load: async () => {
        tries += 1;
        if (tries === 1) throw new Error("chunk failed");
        return impl;
      },
    });
    await expect(sender.getAddress()).rejects.toThrow("chunk failed");
    await expect(sender.getAddress()).resolves.toBe("0xaccount");
  });
  it("shows no account and signs no message", async () => {
    const load = neverLoaded();
    const sender = createPasskeySender(null, { probe: READY, load });
    await expect(sender.connectedAddress()).resolves.toBeNull();
    await expect(sender.signTypedData("0x1", {})).rejects.toThrow(
      /cannot sign messages/,
    );
    await expect(sender.ensureChain(31337)).rejects.toMatchObject({
      reason: "wrong-network",
    });
    expect(load).not.toHaveBeenCalled();
  });
});

describe("which sender sends", () => {
  const wallet = (on: boolean): MoneyWallet => ({
    ...injectedWallet(on ? { request: async () => null } : undefined),
  });
  const passkey = (
    probe: PasskeyProbe,
    set: PasskeySettings | null = SETTINGS,
  ) => createPasskeySender(set, { probe });

  it("is the wallet whenever the build has no passkey sending", () => {
    for (const on of [true, false])
      expect(
        chooseSender({
          wallet: wallet(on),
          passkey: null,
          preferred: "passkey",
        }).kind,
      ).toBe("wallet");
  });
  it("keeps the wallet when there is one, unless the person chose their passkey account and it can send", () => {
    const w = wallet(true);
    expect(
      chooseSender({ wallet: w, passkey: passkey(READY), preferred: null })
        .kind,
    ).toBe("wallet");
    expect(
      chooseSender({ wallet: w, passkey: passkey(READY), preferred: "wallet" })
        .kind,
    ).toBe("wallet");
    expect(
      chooseSender({ wallet: w, passkey: passkey(READY), preferred: "passkey" })
        .kind,
    ).toBe("passkey");
    expect(
      chooseSender({
        wallet: w,
        passkey: passkey(NO_PASSKEY),
        preferred: "passkey",
      }).kind,
    ).toBe("wallet");
    expect(
      chooseSender({
        wallet: w,
        passkey: passkey(READY, null),
        preferred: "passkey",
      }).kind,
    ).toBe("wallet");
  });
  it("is the passkey sender when there is no wallet, even when it cannot send, so it can say why", () => {
    const w = wallet(false);
    for (const p of [passkey(READY), passkey(NO_PASSKEY), passkey(READY, null)])
      expect(
        chooseSender({ wallet: w, passkey: p, preferred: null }).kind,
      ).toBe("passkey");
  });
});

describe("the words for a phone that cannot send", () => {
  it("name the server when it is not set up, and the passkey when there is none, and offer the wallet path", () => {
    const words = (set: PasskeySettings | null, probe: PasskeyProbe) =>
      passkeyUnavailableSentence(createPasskeySender(set, { probe }));
    expect(words(null, READY)).toBe(
      "Backing from this phone is not switched on for this server yet. Open this page in a browser with a wallet to back now.",
    );
    expect(words(SETTINGS, NO_PASSKEY)).toMatch(/signed in with a passkey/);
    expect(words(SETTINGS, NO_PASSKEY)).toMatch(/browser with a wallet/);
    expect(words(SETTINGS, READY)).toBeNull();
  });
  it("read as sentences when a step meets them, with no protocol words", () => {
    const say = (reason: ConstructorParameters<typeof WalletStepError>[0]) =>
      moneyProblem(new WalletStepError(reason, 0), "back");
    expect(say("not-set-up")).toMatch(/not switched on for this server/);
    expect(say("no-passkey")).toMatch(/passkey/);
    expect(say("not-known")).toMatch(/Nothing was sent/);
    for (const reason of ["not-set-up", "no-passkey", "not-known"] as const)
      expect(say(reason)).not.toMatch(
        /bundler|paymaster|sponsor|userop|0x|nonce|revert/i,
      );
  });
});

describe("You: the choice of where to back from", () => {
  const stubBuild = () => {
    vi.stubEnv("VITE_CREATON_PASSKEY_ACCOUNT", "1");
    vi.stubEnv("VITE_CREATON_CHAIN_ID", "31337");
    vi.stubEnv("VITE_CREATON_RPC_URL", "http://rpc.invalid");
    vi.stubEnv("VITE_CREATON_BUNDLER_URL", "http://bundler.invalid");
  };
  const registerPasskey = () => {
    localStorage.setItem("buzz.passkey.credentialId", "cred");
    localStorage.setItem(
      "buzz.passkey.salt",
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQ",
    );
    localStorage.setItem("buzz.passkey.pubkey", "a".repeat(64));
    localStorage.setItem("buzz.passkey.mode", "unlock");
    localStorage.setItem(
      "buzz.passkey.r1",
      `04${"11".repeat(32)}${"22".repeat(32)}`,
    );
  };
  beforeEach(() => applyServerSettings({ investing: true, self: SERVER }));

  it("shows nothing when the build has no passkey sending", () => {
    installWallet();
    wrap(<SenderChoice />);
    expect(screen.queryByTestId("sender-choice")).toBeNull();
  });
  it("tells a phone with no wallet that the server has not set backing up, and offers the wallet path", () => {
    vi.stubEnv("VITE_CREATON_PASSKEY_ACCOUNT", "1");
    wrap(<SenderChoice />);
    expect(screen.getByTestId("sender-not-ready").textContent).toMatch(
      /not switched on for this server yet.*browser with a wallet/,
    );
  });
  it("offers the two ways to a browser that has both, wallet first, and remembers the choice", () => {
    stubBuild();
    registerPasskey();
    installWallet();
    wrap(<SenderChoice />);
    const wallet = screen.getByTestId("sender-wallet") as HTMLInputElement;
    const passkey = screen.getByTestId("sender-passkey") as HTMLInputElement;
    expect(wallet.checked).toBe(true);
    expect(passkey.checked).toBe(false);
    // Each choice is a labelled radio of one group, so the screen reader says its name and the group's.
    expect(screen.getByRole("group", { name: "Back from" })).not.toBeNull();
    expect(screen.getByRole("radio", { name: /My passkey account/ })).toBe(
      passkey,
    );
    fireEvent.click(passkey);
    expect(readSenderChoice()).toBe("passkey");
    expect(
      (screen.getByTestId("sender-passkey") as HTMLInputElement).checked,
    ).toBe(true);
    expect(screen.getByTestId("sender-passkey-words").textContent).toMatch(
      /only key to the money in this account/,
    );
  });
  it("says the passkey is the only key to a phone that backs from its passkey account", () => {
    stubBuild();
    registerPasskey();
    wrap(<SenderChoice />);
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.getByTestId("sender-passkey-words").textContent).toMatch(
      /if you lose it, that money cannot be got back/,
    );
  });
});
