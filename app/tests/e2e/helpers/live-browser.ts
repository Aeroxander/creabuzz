/**
 * The browser side of a live spec: a wallet in the page (`window.ethereum`) whose every call goes to the real anvil through
 * the app's own test provider (the account's unlocked key, no key in this file), counting each wallet prompt; the server's
 * record seeded on the mock relay; and the page's clock moved to the chain's when a spec moved the chain forward.
 */
import { expect, type Page, test } from "@playwright/test";
import { providerFor } from "../../anvil/rpc";
import { createMockRelay } from "../mock-relay";
import {
  buildMismatch,
  chainNow,
  type LiveProject,
  type LiveWorld,
  startWorld,
} from "./live-chain";
import { liveRecord, type RecordOptions } from "./live-record";
import { RELAY } from "./money-world";
import {
  coordOf,
  DAY,
  event,
  install,
  now,
  profile,
  projectLink,
  projectRecord,
  pubkeyOf,
  type Relay,
} from "./world";

/** The people of the live specs: a founder, a reader and a backer, each with a key of their own on the server. */
export const FOUNDER_KEY = "a1".repeat(32);
export const READER_KEY = "a2".repeat(32);
export const FOUNDER_NOSTR = pubkeyOf(FOUNDER_KEY);

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

/**
 * Put the page's clock on the chain's when a spec moved the chain forward (a project that went quiet needs a browser that
 * agrees what day it is). The clock keeps running from there. A chain that is not ahead leaves the page's own clock alone.
 */
export async function syncClock(page: Page): Promise<void> {
  const chain = await chainNow();
  if (chain - Math.floor(Date.now() / 1000) > 30)
    await page.clock.install({ time: chain * 1000 });
}

/** The project's page on the server's address space. */
export const pageOf = (label: string) => projectLink(FOUNDER_NOSTR, label);

/** A server with the project's record and the server's reading of it (rebuilt from the chain on demand). */
export interface LiveServer {
  relay: Relay;
  /** Read the chain again and publish a newer record, as the server does every few minutes. */
  republish(options?: RecordOptions): Promise<void>;
}

/** Seed the founder, the project's record and the server's first reading of it. */
export async function seedServer(
  relay: Relay,
  world: LiveWorld,
  project: LiveProject,
  options: RecordOptions & { skipRecord?: boolean } = {},
): Promise<LiveServer> {
  relay.seed(
    profile(FOUNDER_NOSTR, "Fay Founder", "Building lamps that last."),
  );
  relay.seed(
    projectRecord(
      FOUNDER_NOSTR,
      project.label,
      "Lantern",
      "Solar lamps for night markets.",
      now() - 50 * DAY,
      [["chain-key", project.key]],
    ),
  );
  let tick = 0;
  const publish = async (extra: RecordOptions = {}) => {
    const content = await liveRecord(world, project, { ...options, ...extra });
    tick += 1;
    // A newer record wins: the page reads the newest the server signed for this project.
    const at = (extra.now ?? options.now ?? (await chainNow())) + tick;
    relay.seed(
      event(
        39009,
        RELAY,
        content,
        [
          ["d", project.key],
          ["chain", "31337"],
          ["launcher", project.launcher],
        ],
        at,
      ),
    );
  };
  if (!options.skipRecord) await publish();
  return { relay, republish: publish };
}

/** Wire a page to the server as `key` (or as nobody), with the server's own key named so its records are believed. */
export async function openServer(
  page: Page,
  relay: Relay,
  key: string | null,
): Promise<void> {
  await install(page, relay, key, { investing: true, relaySelf: RELAY });
}

/** The coordinate a project of `label` has on the server. */
export const coordinateOf = (label: string) => coordOf(FOUNDER_NOSTR, label);

/**
 * One real chain for every test of a file: started before the first, stopped after the last. `get()` is the world inside a
 * test. Fails the file, with the reason, when the app build does not name this chain's Launcher.
 */
export function liveWorld(options: { unit?: number } = {}): {
  get(): LiveWorld;
} {
  let world: LiveWorld | null = null;
  test.beforeAll(async () => {
    world = await startWorld(options);
    const why = buildMismatch(world);
    if (why) throw new Error(why);
  });
  test.afterAll(async () => {
    await world?.stop();
  });
  return {
    get() {
      if (!world) throw new Error("the chain is not started");
      return world;
    },
  };
}

export interface OpenOptions extends RecordOptions {
  /** The wallet's account; null puts no wallet in the page. */
  account: string | null;
  /** The server key the page is signed in as (default: a reader). */
  key?: string | null;
  /** The wallet shows its account without being asked (default true). */
  connected?: boolean;
  /** The server has no reading of this project. */
  skipRecord?: boolean;
  /** The server's reads of project numbers fail (it cannot be reached for them). */
  numbersDown?: boolean;
  /** Which tab to open (default: Money). */
  tab?: "money" | null;
}

/** A page opened on a project's Money tab, as a person with this wallet and this server reading. */
export async function openMoney(
  page: Page,
  world: LiveWorld,
  project: LiveProject,
  options: OpenOptions,
) {
  const relay = createMockRelay();
  const server = await seedServer(relay, world, project, options);
  if (options.numbersDown)
    relay.setClosingSockets((filter) =>
      Boolean((filter?.kinds as number[] | undefined)?.includes(39009)),
    );
  await openServer(
    page,
    relay,
    options.key === undefined ? READER_KEY : options.key,
  );
  const wallet = await installAnvilWallet(page, options.account, {
    connected: options.connected ?? true,
  });
  await syncClock(page);
  await page.goto(pageOf(project.label));
  if (options.tab !== null) {
    await page.getByTestId("tab-money").click({ timeout: 20_000 });
    await expect(
      page
        .getByTestId("project-money")
        .or(page.getByTestId("money-none"))
        .or(page.getByText("The numbers could not be read")),
    ).toBeVisible({ timeout: 20_000 });
  }
  return { relay, server, wallet };
}
