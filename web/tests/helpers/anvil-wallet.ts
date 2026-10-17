import type { Page } from "@playwright/test";

/**
 * `window.ethereum` forwarding to a local Anvil, signing as one of its
 * unlocked accounts.
 *
 * Shared by `tests/e2e/launchpad-auction.spec.ts` and the simulation's
 * chain-backed story (`tests/simulate/story-anvil.spec.ts`) so the two cannot
 * drift. Extracted verbatim from the auction spec: `eth_requestAccounts` and
 * `eth_accounts` answer with the chosen account, everything else is proxied
 * to the node — so a `rejectFirstSend` run behaves like a user who pressed
 * Reject once and then let the flow finish.
 */
export async function installAnvilWallet(
  page: Page,
  account: string,
  options: {
    rpcUrl: string;
    rejectFirstSend?: boolean;
    /** Decline the nth transaction the page sends (0 is the first), once: a prompt cancelled part way through a flow. */
    rejectSendAt?: number;
  } = { rpcUrl: "" },
): Promise<void> {
  await page.addInitScript(
    ({ url, account, rejectFirstSend, rejectSendAt }) => {
      let sends = 0;
      Object.defineProperty(window, "ethereum", {
        configurable: true,
        value: {
          request: async ({
            method,
            params,
          }: {
            method: string;
            params?: unknown[];
          }) => {
            if (method === "eth_requestAccounts" || method === "eth_accounts") {
              return [account];
            }
            // The first send is declined (as if the user pressed Reject); every
            // later one goes through, so the flow can be retried to the end.
            if (method === "eth_sendTransaction") {
              const nth = sends++;
              if (
                (rejectFirstSend && nth === 0) ||
                (rejectSendAt !== undefined && nth === rejectSendAt)
              ) {
                throw {
                  code: 4001,
                  message: "User denied transaction signature",
                };
              }
            }
            const res = await fetch(url, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method,
                params: params ?? [],
              }),
            });
            const body = await res.json();
            if (body.error) {
              throw { code: body.error.code, message: body.error.message };
            }
            return body.result;
          },
          on() {},
          removeListener() {},
        },
      });
    },
    {
      url: options.rpcUrl,
      account,
      rejectFirstSend: options.rejectFirstSend ?? false,
      rejectSendAt: options.rejectSendAt,
    },
  );
}

/**
 * Point the app's chain reads at this node. `getRpcEndpoint` prefers the
 * saved choice in localStorage over any build-time default
 * (`web/src/features/launchpad/chain.ts`).
 */
export async function pointChainAt(page: Page, rpcUrl: string): Promise<void> {
  await page.addInitScript(
    ({ url }) => window.localStorage.setItem("buzz.launchpad.rpc", url),
    { url: rpcUrl },
  );
}
