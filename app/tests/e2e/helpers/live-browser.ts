/**
 * The browser side of a live spec: a wallet in the page (`window.ethereum`) whose every call goes to the real anvil through
 * the app's own test provider (the account's unlocked key, no key in this file), counting each wallet prompt; the server's
 * record seeded on the mock relay; and the page's clock moved to the chain's when a spec moved the chain forward.
 */
import { expect, type Page, test } from "@playwright/test";
import { createMockRelay } from "../mock-relay";
import { installAnvilWallet } from "./live-wallet";
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
