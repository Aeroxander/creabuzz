/**
 * A wallet in the page (`window.ethereum`) whose every call goes to a real anvil through the app's own test provider (the
 * account's unlocked key, no key in this file), counting each wallet prompt. Shared by the specs that use the mock server
 * (`live-browser.ts`) and the one that uses a real server (`../../e2e-pot-full`).
 */
import type { Page } from "@playwright/test";
import { providerFor } from "../../anvil/rpc";

/** What the page's wallet was asked, and what it was told to do next. */
export interface WalletLog {
  /** Every transaction the wallet was asked to send and the person said yes to. */
  sent: { to: string; data: string }[];
  /** Every time the wallet asked the person (a yes, or a no): the number of signatures asked for. */
  prompts: number;
  /** Times the page asked the wallet to connect. */
  connects: number;
  /** Make the next `n` prompts end in "the person said no". */
  rejectNext: number;
  /** Hold every prompt this long before answering (the person is thinking). */
  delayMs: number;
  /** The wallet shows no account until the page asks to connect. */
  connected: boolean;
}

/**
 * A wallet for `account` on the page. `account` null puts no wallet in the page at all (a browser without one). The returned log
 * is live: a spec reads `sent.length` for the prompts so far.
 */
export async function installAnvilWallet(
  page: Page,
  account: string | null,
  options: { connected?: boolean } = {},
): Promise<WalletLog> {
  const log: WalletLog = {
    sent: [],
    prompts: 0,
    connects: 0,
    rejectNext: 0,
    delayMs: 0,
    connected: options.connected ?? true,
  };
  if (account === null) return log;
  const provider = providerFor(account);
  await page.exposeFunction(
    "__anvilRpc",
    async (method: string, params: unknown[]) => {
      try {
        if (method === "eth_accounts")
          return { result: log.connected ? [account] : [] };
        if (method === "eth_requestAccounts") {
          log.connected = true;
          log.connects += 1;
          return { result: [account] };
        }
        if (method === "eth_sendTransaction") {
          const tx = (params[0] ?? {}) as { to: string; data: string };
          log.prompts += 1;
          if (log.delayMs > 0)
            await new Promise((r) => setTimeout(r, log.delayMs));
          if (log.rejectNext > 0) {
            log.rejectNext -= 1;
            return {
              error: { code: 4001, message: "User rejected the request." },
            };
          }
          log.sent.push({ to: tx.to, data: tx.data });
        }
        return { result: await provider.request({ method, params }) };
      } catch (error) {
        const e = error as { code?: number; message?: string; data?: unknown };
        return {
          error: {
            code: e.code ?? -32603,
            message: e.message ?? "failed",
            data: e.data,
          },
        };
      }
    },
  );
  await page.addInitScript(() => {
    const call = (
      window as unknown as {
        __anvilRpc: (
          m: string,
          p: unknown[],
        ) => Promise<{
          result?: unknown;
          error?: { code: number; message: string; data?: unknown };
        }>;
      }
    ).__anvilRpc;
    (window as unknown as { ethereum: unknown }).ethereum = {
      async request({
        method,
        params,
      }: {
        method: string;
        params?: unknown[];
      }) {
        const answer = await call(method, params ?? []);
        if (answer.error)
          throw Object.assign(new Error(answer.error.message), answer.error);
        return answer.result;
      },
    };
  });
  return log;
}
