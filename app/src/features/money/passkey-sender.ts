/**
 * The passkey account as a sender: the person's own account, made from the passkey they signed in with, sending their
 * money steps with the network fee paid by the server. This file is the small part that stays in the first download
 * (settings, availability, the choice of network); everything that sends, signs or reads the chain is in
 * `passkey-sender-impl.ts`, loaded only when a passkey send or read is made.
 *
 * It needs three settings the person running the site gives it (see `app/.env.example`): the chain's address to read,
 * and where to send the signed step and ask for the fee to be paid. Without them it says it is not switched on, in
 * plain words, and the browser-wallet path is unchanged.
 */
import {
  passkeyCredentialId,
  passkeyIdentity,
} from "@creaton/core/account/passkey-identity.ts";
import { knownSendTargets } from "./send-targets";
import {
  type MoneyWallet,
  type SenderAvailability,
  type SenderCapabilities,
  WalletStepError,
} from "./wallet";

/** What the person running the site set: the network, where to read it, and the bundler and sponsor to send through. */
export interface PasskeySettings {
  chainId: number;
  rpcUrl: string;
  bundlerUrl: string;
  /** Where the fee is asked for; the bundler's address when unset. */
  sponsorUrl?: string;
}

/** Whether the build turned passkey sending on (`VITE_CREATON_PASSKEY_ACCOUNT=1`). */
export function passkeySendingOn(
  env: Record<string, unknown> = import.meta.env,
): boolean {
  return env.VITE_CREATON_PASSKEY_ACCOUNT === "1";
}

/**
 * A setting that is an address, or null. An address that carries a name and password, or a key in its query, is refused:
 * every setting ends up in the page each visitor downloads, so a key must sit in a proxy, never in the address.
 */
const url = (value: unknown): string | null => {
  if (typeof value !== "string" || !/^https?:\/\/\S+$/.test(value.trim()))
    return null;
  try {
    const parsed = new URL(value.trim());
    if (parsed.username || parsed.password) return null;
    for (const name of parsed.searchParams.keys())
      if (/key|token|secret|auth|password/i.test(name)) return null;
  } catch {
    return null;
  }
  return value.trim();
};

/** The build's settings, or null when any of the three is missing (so nothing is half-set). */
export function passkeySettings(
  env: Record<string, unknown> = import.meta.env,
): PasskeySettings | null {
  const chainId = Number(env.VITE_CREATON_CHAIN_ID);
  const rpcUrl = url(env.VITE_CREATON_RPC_URL);
  const bundlerUrl = url(env.VITE_CREATON_BUNDLER_URL);
  const sponsorUrl = url(env.VITE_CREATON_SPONSOR_URL);
  // A sponsor address that was set but is not usable is never quietly dropped: the fee would then be asked at the bundler.
  const sponsorSet =
    typeof env.VITE_CREATON_SPONSOR_URL === "string" &&
    env.VITE_CREATON_SPONSOR_URL.trim() !== "";
  if (
    !Number.isSafeInteger(chainId) ||
    chainId <= 0 ||
    !rpcUrl ||
    !bundlerUrl ||
    (sponsorSet && !sponsorUrl)
  )
    return null;
  return { chainId, rpcUrl, bundlerUrl, ...(sponsorUrl ? { sponsorUrl } : {}) };
}

/** What the passkey in this browser says about itself, read without a prompt. */
export interface PasskeyProbe {
  credentialId(): string | null;
  /** The passkey's public key (uncompressed P-256 hex) that fixes the account, or null for an older passkey without one. */
  ownerKey(): string | null;
}

const browserProbe: PasskeyProbe = {
  credentialId: passkeyCredentialId,
  ownerKey: () => passkeyIdentity()?.evmOwner.r1UncompressedHex ?? null,
};

/** The sending part, loaded on first use. */
export interface PasskeyImpl {
  connectedAddress(): Promise<string | null>;
  getAddress(): Promise<string>;
  sendCalls: MoneyWallet["sendCalls"];
  readCall: MoneyWallet["readCall"];
  blockNumber: MoneyWallet["blockNumber"];
  /** The time of a block: optional, so a test double without it still stands in; the wallet then says the read failed. */
  blockTime?: NonNullable<MoneyWallet["blockTime"]>;
  chainId: MoneyWallet["chainId"];
  getLogs: MoneyWallet["getLogs"];
  outcomeOf: MoneyWallet["outcomeOf"];
}

/** Everything a test may replace. */
export interface PasskeyDeps {
  probe?: PasskeyProbe;
  /** Where the sending part comes from (default: the lazy chunk). */
  load?: (
    settings: PasskeySettings,
    probe: PasskeyProbe,
  ) => Promise<PasskeyImpl>;
  knownTargets?: () => ReadonlySet<string>;
}

const CAPABILITIES: SenderCapabilities = {
  signsMessages: false,
  atomicBatch: true,
  feeSponsored: true,
};

/**
 * The passkey sender. `settings` null means the build did not set it up. Never throws from construction; every async
 * method loads the sending part first, so this file stays small.
 */
export function createPasskeySender(
  settings: PasskeySettings | null,
  deps: PasskeyDeps = {},
): MoneyWallet {
  const probe = deps.probe ?? browserProbe;
  let loaded: Promise<PasskeyImpl> | undefined;

  const availability = (): SenderAvailability => {
    if (!settings) return { ok: false, reason: "not-set-up" };
    if (!probe.credentialId() || !probe.ownerKey())
      return { ok: false, reason: "no-passkey" };
    return { ok: true };
  };

  const impl = (): Promise<PasskeyImpl> => {
    const now = availability();
    if (!now.ok || !settings) {
      return Promise.reject(
        new WalletStepError(now.ok ? "not-set-up" : now.reason, 0),
      );
    }
    loaded ??= (
      deps.load ??
      (async (s, p) =>
        (await import("./passkey-sender-impl")).createPasskeyImpl(s, p))
    )(settings, probe).catch((error: unknown) => {
      // A chunk that failed to load is not a decision: the next try loads again.
      loaded = undefined;
      throw error;
    });
    return loaded;
  };

  const need = async <T>(use: (i: PasskeyImpl) => Promise<T>): Promise<T> =>
    use(await impl());

  return {
    kind: "passkey",
    availability,
    capabilities: CAPABILITIES,
    isAvailable: () => availability().ok,
    connectedAddress: async () => {
      // No prompt and no failure: a phone that cannot read its account yet shows none.
      if (!availability().ok) return null;
      try {
        return await need((i) => i.connectedAddress());
      } catch {
        return null;
      }
    },
    getAddress: () => need((i) => i.getAddress()),
    sendCalls: async (calls, chainId, options) => {
      const now = availability();
      if (!now.ok) throw new WalletStepError(now.reason, 0);
      if (chainId !== settings?.chainId)
        throw new WalletStepError("wrong-network", 0);
      const known = (deps.knownTargets ?? knownSendTargets)();
      for (const call of calls)
        if (!known.has(call.to.toLowerCase()))
          throw new WalletStepError("not-known", 0);
      return need((i) => i.sendCalls(calls, chainId, options));
    },
    readCall: (to, data) => need((i) => i.readCall(to, data)),
    blockNumber: () => need((i) => i.blockNumber()),
    blockTime: (block) =>
      need((i) =>
        i.blockTime
          ? i.blockTime(block)
          : Promise.reject(
              new Error("This account cannot say a block's time."),
            ),
      ),
    chainId: () => need((i) => i.chainId()),
    getLogs: (filter) => need((i) => i.getLogs(filter)),
    signTypedData: () =>
      Promise.reject(
        new Error("A passkey account cannot sign messages here yet."),
      ),
    ensureChain: async (chainId) => {
      if (!settings || chainId !== settings.chainId)
        throw new WalletStepError("wrong-network", 0);
    },
    outcomeOf: (sent) => need((i) => i.outcomeOf(sent)),
  };
}
