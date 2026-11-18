import type { Page } from "@playwright/test";
import {
  CONTRACTS,
  chainIdentity,
  type NumbersOptions,
  numbersContent,
} from "../../helpers/numbers-fixture";
import { event, now, pubkeyOf, type Relay } from "./world";

/** The mock server's own signing key: the only key whose project numbers the app believes. */
export const RELAY_KEY = "e1".repeat(32);
export const RELAY = pubkeyOf(RELAY_KEY);

/** The record tag that names a project's launch, for a project record seeded with one. */
export function chainKeyTag(coordinate: string): string[] {
  return ["chain-key", chainIdentity(coordinate).key];
}

/** A project-numbers record (kind 39009) the server signed, as the chain reader stores it. */
export function numbersRecord(
  options: Omit<NumbersOptions, "now"> & { now?: number },
  signer = RELAY,
) {
  const at = options.now ?? now();
  const { key } = chainIdentity(options.coordinate);
  return event(
    39009,
    signer,
    numbersContent({ ...options, now: at }),
    [
      ["d", key],
      ["chain", "31337"],
      ["launcher", CONTRACTS.launcher],
    ],
    at,
  );
}

export interface SentCall {
  from: string;
  to: string;
  data: string;
  value: string;
}

/**
 * A wallet in the page (`window.ethereum`) that answers as anvil would and records every transaction it is asked to
 * send, so a spec checks the exact calls. `account` is the wallet's account (null: a wallet with nothing connected
 * until the page asks). `refuseNext` makes the next send fail the way a contract refusal does, with that error's
 * selector in its data.
 */
export async function installWallet(
  page: Page,
  options: { account: string | null; refuseNextWith?: string },
) {
  await page.addInitScript(
    ([account, quote, refuseWith]) => {
      const w = window as unknown as {
        ethereum: unknown;
        __sent: unknown[];
        __connected: boolean;
        __refuse: string | null;
      };
      w.__sent = [];
      w.__connected = account !== null;
      w.__refuse = refuseWith;
      const me = account ?? "0x90f79bf6eb2c4f870365e785982e1f101e93b906";
      w.ethereum = {
        async request({
          method,
          params,
        }: {
          method: string;
          params?: unknown[];
        }) {
          if (method === "eth_accounts") return w.__connected ? [me] : [];
          if (method === "eth_requestAccounts") {
            w.__connected = true;
            return [me];
          }
          if (method === "eth_chainId") return "0x7a69";
          if (method === "eth_call")
            return `0x${"0".repeat(24)}${quote.slice(2)}`;
          if (method === "eth_getTransactionReceipt")
            return { status: "0x1" };
          if (method === "eth_sendTransaction") {
            if (w.__refuse) {
              const data = w.__refuse;
              w.__refuse = null;
              throw {
                code: -32603,
                message: "execution reverted",
                data: { data },
              };
            }
            w.__sent.push(params?.[0]);
            return `0x${w.__sent.length.toString(16).padStart(64, "0")}`;
          }
          throw { code: 4200, message: `unsupported ${method}` };
        },
      };
    },
    [options.account, CONTRACTS.quote, options.refuseNextWith ?? null] as const,
  );
}

/** Every transaction the page's wallet sent, in order. */
export function sentCalls(page: Page): Promise<SentCall[]> {
  return page.evaluate(
    () => (window as unknown as { __sent: SentCall[] }).__sent,
  );
}

/** Seed the server with a project-numbers record and keep its id for later checks. */
export function seedNumbers(
  relay: Relay,
  options: Omit<NumbersOptions, "now"> & { now?: number },
  signer = RELAY,
) {
  const record = numbersRecord(options, signer);
  relay.seed(record);
  return record;
}
