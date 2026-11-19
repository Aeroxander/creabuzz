import type { Page } from "@playwright/test";
import { pubkeyOf } from "./world";

/** The mock server's own signing key: the only key whose project numbers the app believes. */
const RELAY_KEY = "c7".repeat(32);
export const RELAY = pubkeyOf(RELAY_KEY);

/**
 * A bare wallet in the page (`window.ethereum`) for a spec that only needs the page to see one: it shares `account` and says
 * it is on the test chain, and answers nothing else. A spec that sends money uses the real chain (`live-wallet.ts`).
 */
export async function installWallet(
  page: Page,
  options: { account: string | null },
) {
  await page.addInitScript((account) => {
    const w = window as unknown as { ethereum: unknown };
    w.ethereum = {
      async request({ method }: { method: string }) {
        if (method === "eth_accounts" || method === "eth_requestAccounts")
          return account ? [account] : [];
        if (method === "eth_chainId") return "0x7a69";
        throw { code: 4200, message: `unsupported ${method}` };
      },
    };
  }, options.account);
}
