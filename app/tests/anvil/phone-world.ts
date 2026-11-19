/**
 * What the phone-path scenarios share: the chain with EntryPoint, the Kernel stack and a paymaster; the stand-in bundler
 * and sponsor in front of it; a software passkey behind `navigator.credentials` that signs in the production way; and
 * the passkey sender the app builds, loaded as the app loads it.
 */
import { appendFileSync } from "node:fs";
import { installFakeWebAuthn } from "./fake-webauthn";
import { setupPasskey } from "../../../packages/creaton-core/src/account/passkey-identity.ts";
import {
  createPasskeyImpl,
  type PasskeyImplDeps,
} from "../../src/features/money/passkey-sender-impl";
import {
  createPasskeySender,
  type PasskeySettings,
} from "../../src/features/money/passkey-sender";
import {
  forgetSendTargets,
  knownSendTargets,
  rememberSendTargets,
} from "../../src/features/money/send-targets";
import type { MoneyWallet } from "../../src/features/money/wallet";
import { type PhoneChain, setUpPhoneChain } from "./phone-chain";
import { RPC } from "./rpc";
import { type StandInBundler, startStandInBundler } from "./stand-in-bundler";

/** A line of the run's own report: printed, and kept for `scripts/phone-loop.sh` to list at the end. */
export function pass(claim: string): void {
  const line = `PASS ${claim}`;
  console.log(line);
  const file = process.env.PHONE_LOOP_REPORT;
  if (file) appendFileSync(file, `${line}\n`);
}

function installStorage(): void {
  const map = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      get length() {
        return map.size;
      },
      key: (i: number) => [...map.keys()][i] ?? null,
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, String(v)),
      removeItem: (k: string) => void map.delete(k),
      clear: () => void map.clear(),
    },
  });
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  });
}

export interface PhoneWorld {
  chain: PhoneChain;
  bundler: StandInBundler;
  settings: PasskeySettings;
  /** The software passkey's counters: `get` is the number of passkey prompts so far. */
  authenticator: { calls: { create: number; get: number } };
  /** A sender as the app builds it, with `deps` for the part that signs. */
  senderWith(deps?: PasskeyImplDeps): MoneyWallet;
  /** The sender with the app's own timing for the tests. */
  sender: MoneyWallet;
  close(): Promise<void>;
}

export async function phoneWorld(
  admin: string,
  options: {
    simulate?: boolean;
    sponsorPolicy?: Parameters<typeof startStandInBundler>[0]["sponsorPolicy"];
  } = {},
): Promise<PhoneWorld> {
  installStorage();
  const authenticator = installFakeWebAuthn();
  const chain = await setUpPhoneChain(admin);
  const bundler = await startStandInBundler({
    rpcUrl: RPC,
    paymaster: chain.paymaster,
    submitter: chain.submitter,
    ...options,
  });
  // A person signs up with a passkey: the production ceremony makes the credential and stores the owner key.
  await setupPasskey("Tester");
  forgetSendTargets();
  rememberSendTargets([chain.token]);
  const settings: PasskeySettings = {
    chainId: 31337,
    rpcUrl: RPC,
    bundlerUrl: bundler.url,
  };
  const senderWith = (deps: PasskeyImplDeps = {}) =>
    createPasskeySender(settings, {
      knownTargets: knownSendTargets,
      load: async (s, p) =>
        createPasskeyImpl(s, p, {
          receipt: { pollIntervalMs: 10, maxPolls: 100 },
          ...deps,
        }),
    });
  return {
    chain,
    bundler,
    settings,
    authenticator,
    senderWith,
    sender: senderWith(),
    close: () => bundler.close(),
  };
}
