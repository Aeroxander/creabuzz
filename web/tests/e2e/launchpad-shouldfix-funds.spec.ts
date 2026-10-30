import { expect, test, type Page } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";

import { expectAccessible } from "../helpers/a11y";
import { createMockRelay } from "./mock-relay";

/**
 * Leaving a project from a wallet (D144), against a stubbed server and a stubbed chain (same-origin `/test-rpc`, which
 * also serves the browser wallet's sends and receipts).
 *
 * - With nothing in the treasury, leaving pays nothing and destroys the Shares: the page says so, and the dialog will not
 *   send until the person ticks that they understand.
 * - A wallet on another network is refused before anything is sent: no transaction, no "Exit confirmed".
 * - Once an exit lands the page reads the position again, so the old Shares and the Leave button do not stay up.
 *
 * The panel and its send are the same on a contributor project's Funds tab, where the send goes through the acting
 * account (a build without a contributor kit cannot show that tab, so this runs on a raise's Treasury tab). The real
 * run, from a passkey account on a Sepolia fork, is `passkey-contributor.spec.ts`.
 */

const NSEC = "7".repeat(64);
const ME = getPublicKey(Uint8Array.from(Buffer.from(NSEC, "hex")));
const E18 = 10n ** 18n;

const a = (byte: string) => `0x${byte.repeat(20)}`;
const word = (n: bigint | string) =>
  (typeof n === "bigint" ? n.toString(16) : n.replace(/^0x/, "")).padStart(
    64,
    "0",
  );

const DAO = a("da");
const SHARES = a("5e");
const LOOT = a("10");
const HOLDER = a("a1");
const TX = `0x${"e1".repeat(32)}`;
const SLUG = "leave-test";

const CALL = {
  ragequittable: "0x14a6d7de",
  shares: "0x03314efa",
  loot: "0x9b7b2ab0",
  totalSupply: "0x18160ddd",
  balanceOf: "0x70a08231",
  delegates: "0x587cde1e",
};

const record = {
  id: "b".repeat(64),
  pubkey: ME,
  created_at: 100,
  kind: 37001,
  tags: [
    ["d", SLUG],
    ["name", "Leave Test"],
    ["t", "dao-launchpad"],
    ["chain", "31337"],
  ],
  content: JSON.stringify({
    pitch: "A project whose DAO a holder can leave.",
    stage: "graduated",
  }),
  sig: "sig",
};

/** The DAO this launch was summoned into: the Treasury tab's binding. */
const summon = {
  id: "c".repeat(64),
  pubkey: ME,
  created_at: 101,
  kind: 47005,
  tags: [
    ["a", `37001:${ME}:${SLUG}`],
    ["kind", "summon"],
    ["tx", `0x${"5c".repeat(32)}`],
  ],
  content: JSON.stringify({ dao: DAO }),
  sig: "sig",
};

interface Chain {
  /** The holder's Shares, whole. */
  shares: bigint;
  /** What the DAO holds in ETH, in wei. */
  eth: bigint;
  /** Transactions the wallet sent. */
  sent: { to: string; data: string }[];
}

async function installChain(page: Page, chain: Chain) {
  await page.route("**/test-rpc", async (route) => {
    const { id, method, params } = JSON.parse(
      route.request().postData() ?? "{}",
    ) as { id: number; method: string; params: Record<string, unknown>[] };
    const reply = (body: Record<string, unknown>) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ jsonrpc: "2.0", id: id ?? 1, ...body }),
      });
    if (method === "eth_chainId") return reply({ result: "0x7a69" });
    if (method === "eth_blockNumber") return reply({ result: "0x20" });
    if (method === "eth_getLogs") return reply({ result: [] });
    if (method === "eth_getBalance") {
      const who = String(params[0] ?? "").toLowerCase();
      return reply({
        result: `0x${(who === DAO ? chain.eth : 0n).toString(16)}`,
      });
    }
    if (method === "eth_sendTransaction") {
      const tx = params[0] as { to: string; data: string };
      chain.sent.push({ to: tx.to, data: tx.data });
      // The exit lands: the Shares are burned and the holder's part leaves the treasury.
      chain.eth -= (chain.eth * chain.shares) / 1000n;
      chain.shares = 0n;
      return reply({ result: TX });
    }
    if (method === "eth_getTransactionReceipt") {
      return reply({
        result: { status: "0x1", blockNumber: "0x21", gasUsed: "0x5208" },
      });
    }
    if (method === "eth_call") {
      const target = String(params[0]?.to ?? "").toLowerCase();
      const data = String(params[0]?.data ?? "");
      const arg = `0x${data.slice(-40)}`;
      if (target === DAO && data === CALL.ragequittable)
        return reply({ result: `0x${word(1n)}` });
      if (target === DAO && data === CALL.shares)
        return reply({ result: `0x${word(SHARES)}` });
      if (target === DAO && data === CALL.loot)
        return reply({ result: `0x${word(LOOT)}` });
      if (target === SHARES && data === CALL.totalSupply)
        return reply({ result: `0x${word(1000n * E18)}` });
      if (target === SHARES && data.startsWith(CALL.balanceOf))
        return reply({
          result: `0x${word(arg === HOLDER ? chain.shares * E18 : 0n)}`,
        });
      if (target === SHARES && data.startsWith(CALL.delegates))
        return reply({ result: `0x${word(HOLDER)}` });
      // Loot, the lock guard, the exit fee's terms and the rest: nothing there.
      return reply({ result: `0x${word(0n)}` });
    }
    return reply({ error: { code: -32601, message: `no ${method}` } });
  });
}

/** A browser wallet holding HOLDER, on `chainHex`; it sends and reads receipts through the stub chain. */
async function installWallet(page: Page, chainHex: string) {
  await page.addInitScript(
    ([holder, chain]) => {
      (window as unknown as { ethereum: unknown }).ethereum = {
        request: async ({
          method,
          params,
        }: {
          method: string;
          params?: unknown[];
        }) => {
          if (method === "eth_requestAccounts" || method === "eth_accounts")
            return [holder];
          if (method === "eth_chainId") return chain;
          const res = await fetch("/test-rpc", {
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
          if (body.error) throw new Error(body.error.message);
          return body.result;
        },
        on() {},
        removeListener() {},
      };
    },
    [HOLDER, chainHex],
  );
}

async function openTreasury(page: Page, chain: Chain, walletChain = "0x7a69") {
  const relay = createMockRelay();
  relay.seed(record);
  relay.seed(summon);
  await relay.install(page);
  await installChain(page, chain);
  await installWallet(page, walletChain);
  await page.addInitScript((nsec) => {
    window.localStorage.setItem("buzz.identity.nsec", nsec);
    window.localStorage.setItem("buzz.identity.backedUp", "1");
    window.localStorage.setItem(
      "buzz.launchpad.rpc",
      `${window.location.origin}/test-rpc`,
    );
  }, NSEC);
  await page.goto(`/launchpad/${SLUG}?author=${ME}&tab=treasury`);
  await expect(page.getByTestId("ragequit-panel")).toBeVisible({
    timeout: 20_000,
  });
  return relay;
}

test("leaving an empty treasury says it pays nothing and asks before the Shares are destroyed", async ({
  page,
}) => {
  const chain: Chain = { shares: 300n, eth: 0n, sent: [] };
  await openTreasury(page, chain);
  const panel = page.getByTestId("ragequit-panel");
  await expect(panel.getByTestId("ragequit-shares")).toHaveText("300", {
    timeout: 20_000,
  });
  await expect(panel.getByTestId("ragequit-pays-nothing")).toHaveText(
    "Leaving now pays you nothing, and your 300 Shares would be destroyed.",
  );
  await panel.getByTestId("ragequit-exit").click();

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByTestId("ragequit-dialog-nothing")).toContainText(
    "Your 300 Shares are destroyed all the same",
  );
  // The token is named, never shown as an address.
  await expect(dialog).toContainText("Leaving pays out ETH.");
  const run = dialog.getByTestId("ragequit-run");
  await expect(run).toBeDisabled();
  await expectAccessible(page, "leaving with nothing to take");
  const ack = dialog.getByRole("checkbox", {
    name: "I understand that my 300 Shares are destroyed and I get nothing back.",
  });
  // Keyboard reaches the tick as well as the pointer.
  await ack.focus();
  await page.keyboard.press("Space");
  await expect(ack).toBeChecked();
  await expect(run).toBeEnabled();
  await expect(run).toHaveText("Leave with nothing");
  expect(chain.sent).toHaveLength(0);
});

test("a wallet on another network is refused before anything is sent", async ({
  page,
}) => {
  const chain: Chain = { shares: 300n, eth: 2n * E18, sent: [] };
  await openTreasury(page, chain, "0x1");
  const panel = page.getByTestId("ragequit-panel");
  await expect(panel.getByTestId("ragequit-claim-row")).toHaveText(
    "You get 0.6 ETH",
    { timeout: 20_000 },
  );
  await expect(panel.getByRole("group", { name: "Act as" })).toBeVisible();
  await panel.getByTestId("ragequit-exit").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByTestId("ragequit-dialog-summary")).toContainText(
    "Your 300 Shares are destroyed, and you get 0.6 ETH",
  );
  await dialog.getByTestId("ragequit-run").click();
  await expect(dialog.getByTestId("ragequit-failure")).toContainText(
    "Your wallet is on chain 1, but this launch is on chain 31337",
  );
  await expect(dialog.getByTestId("ragequit-done")).toHaveCount(0);
  expect(chain.sent).toHaveLength(0);
});

test("once an exit lands, the page reads the position again", async ({
  page,
}) => {
  const chain: Chain = { shares: 300n, eth: 2n * E18, sent: [] };
  const relay = await openTreasury(page, chain);
  const panel = page.getByTestId("ragequit-panel");
  await expect(panel.getByTestId("ragequit-shares")).toHaveText("300", {
    timeout: 20_000,
  });
  await panel.getByTestId("ragequit-exit").click();
  const dialog = page.getByRole("dialog");
  await dialog.getByTestId("ragequit-run").click();
  await expect(dialog.getByTestId("ragequit-done")).toContainText(
    "Exit confirmed",
    { timeout: 20_000 },
  );
  expect(chain.sent).toHaveLength(1);
  expect(chain.sent[0].to.toLowerCase()).toBe(DAO);
  // Nothing to press again once the exit landed.
  await expect(dialog.getByTestId("ragequit-run")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Close" }).click();
  // The position is read again: no Shares left, so no Leave button.
  await expect(panel).toContainText(
    "This account holds no shares, so there is nothing to leave with.",
  );
  await expect(panel.getByTestId("ragequit-exit")).toHaveCount(0);
  // The record of the exit names the Shares that were burned, not the re-read zero.
  await expect
    .poll(() =>
      relay.events
        .filter(
          (e) =>
            e.kind === 47005 &&
            e.tags.some((t) => t[0] === "kind" && t[1] === "ragequit"),
        )
        .map((e) => JSON.parse(e.content).sharesBurned),
    )
    .toEqual([(300n * E18).toString()]);
});
