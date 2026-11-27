/**
 * What the joined-up journey (`pot-full.spec.ts`, run by `scripts/pot-full-loop.sh`) does outside the browser: speak to the
 * real server over HTTP the way any account does (a signed request for what it has stored, a signed record from a founder),
 * move the real local chain with the app's own call builders, and compare the record with the contracts' own views.
 * Every key here is made for the run; the chain's accounts are anvil's public development accounts.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as nip49 from "nostr-tools/nip49";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import { bytesToHex, hexToBytes } from "nostr-tools/utils";
import { withChainKey } from "../../../packages/creaton-core/src/launchpad/project-chain.ts";
import { expect, type Page } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";
import { accounts, pointAtRpc, rpc } from "../anvil/rpc";
import type { PotChain } from "../anvil/pot-chain";
import {
  chainNow,
  launchedProject,
  type LiveProject,
} from "../e2e/helpers/live-chain";
import { buildPost } from "../../../packages/creaton-core/src/social/feed/feed-events.ts";
import type { LiveWorld } from "../e2e/helpers/live-chain";

const need = (name: string): string => {
  const value = process.env[name];
  if (!value)
    throw new Error(
      `${name} is not set: run this journey with scripts/pot-full-loop.sh`,
    );
  return value;
};

/** Where this run's server, chain and files are (all set by the script that starts them). */
export const RUN = {
  relay: process.env.BUZZ_REAL_RELAY_URL ?? "",
  rpc: process.env.POT_RPC_URL ?? "",
  stateDir: process.env.POT_STATE_DIR ?? "",
  repoRoot: process.env.POT_REPO_ROOT ?? "",
  checksFile: process.env.POT_CHECKS_FILE ?? "",
  shots: process.env.POT_SHOTS_DIR ?? "",
  helper: (process.env.POT_HELPER_ADDRESS ?? "").toLowerCase(),
};

/** Why the journey cannot run here, or null. */
export const NOT_RUNNABLE: string | null = (() => {
  for (const name of [
    "BUZZ_REAL_RELAY_URL",
    "POT_RPC_URL",
    "POT_DEPLOYMENTS_FILE",
    "POT_STATE_DIR",
    "POT_REPO_ROOT",
    "POT_CHECKS_FILE",
    "POT_DB_URL",
  ])
    if (!process.env[name])
      return `${name} is not set: run this journey with scripts/pot-full-loop.sh (it starts the chain, the server and the app)`;
  return null;
})();

// --- Checks --------------------------------------------------------------------------------------------------------

let checks = 0;

/** One check that passed: said on the output and counted by the script. A check that fails throws, so nothing false is counted. */
export function ok(what: string): void {
  checks += 1;
  const line = `ok ${String(checks).padStart(3, "0")} ${what}`;
  console.log(`  ${line}`);
  if (RUN.checksFile) appendFileSync(RUN.checksFile, `${line}\n`);
}

/** A condition that must hold; counted when it does. */
export function check(condition: boolean, what: string): void {
  if (!condition) throw new Error(`check failed: ${what}`);
  ok(what);
}

/** Two values that must be equal; counted when they are. The message names both. */
export function same<T>(got: T, want: T, what: string): void {
  if (got !== want)
    throw new Error(
      `check failed: ${what}: got ${String(got)}, expected ${String(want)}`,
    );
  ok(`${what}: ${String(got)}`);
}

/** Add checks that another tool counted (the field-by-field comparison with the contracts). */
export function plus(count: number, what: string): void {
  checks += count;
  console.log(`  plus ${count} ${what}`);
  if (RUN.checksFile) appendFileSync(RUN.checksFile, `plus ${count} ${what}\n`);
}

// --- The server over HTTP ------------------------------------------------------------------------------------------

const ephemeral = generateSecretKey();

function token(
  key: Uint8Array,
  method: string,
  url: string,
  body: string,
): string {
  const auth = finalizeEvent(
    {
      kind: 27235,
      content: "",
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["u", url],
        ["method", method],
        ["payload", createHash("sha256").update(body, "utf8").digest("hex")],
        // Two requests in one second must not be the same signed request (the server refuses a replay).
        ["nonce", randomBytes(8).toString("hex")],
      ],
    },
    key,
  );
  return `Nostr ${Buffer.from(JSON.stringify(auth), "utf8").toString("base64")}`;
}

async function post(
  route: string,
  body: string,
  key: Uint8Array = ephemeral,
): Promise<{ status: number; text: string }> {
  const url = `${RUN.relay}${route}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: token(key, "POST", url, body),
      "content-type": "application/json",
    },
    body,
    signal: AbortSignal.timeout(20_000),
  });
  return { status: res.status, text: await res.text() };
}

/** A stored event as the server returns it. */
export interface StoredEvent {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

/** Ask the server for events (a Nostr filter over a signed POST), newest first. */
export async function query(
  filter: Record<string, unknown>,
): Promise<StoredEvent[]> {
  const { status, text } = await post("/query", JSON.stringify([filter]));
  if (status !== 200)
    throw new Error(`POST /query answered ${status}: ${text.slice(0, 300)}`);
  const body = JSON.parse(text) as StoredEvent[] | { events: StoredEvent[] };
  const list = Array.isArray(body) ? body : body.events;
  return [...list].sort(
    (a, b) => b.created_at - a.created_at || (a.id < b.id ? 1 : -1),
  );
}

/** The project numbers the server signed for `key`: the newest, as the page reads them. Null when none. */
export async function newestRecord(
  key: string,
): Promise<{ event: StoredEvent; content: NumbersJson } | null> {
  const [event] = await query({ kinds: [39009], "#d": [key], limit: 1 });
  return event
    ? { event, content: JSON.parse(event.content) as NumbersJson }
    : null;
}

/** One task row of the record's `tasks` section (RECORD-V2 section 10): the parts a journey reads. Amounts are decimal strings. */
export interface TaskRowJson {
  serial: number;
  what: string;
  payee: string | null;
  state: string;
  shareBps: number;
  maxDollars: string;
  atMostNow: string | null;
  announcedAt: number;
  noticeEnd: number;
  expiresAt: number;
  takenBy: string | null;
  takenAt: number | null;
  deadline: number | null;
  setAside: string;
  stayerClaim: string;
  noteFace: string;
  pay: string;
  returned: string;
  notesLeft: string;
  resolvedAt: number | null;
  resolvedTx: string | null;
  repeatOf: number | null;
  notes: {
    faceTotal: string;
    holders: { account: string; face: string; claimable: string }[];
  } | null;
}

/** The record's `tasks` section, as far as a journey reads it. */
export interface TasksJson {
  book: string;
  bookBlock: number;
  nextSerial: number;
  openCount: number;
  nextExpiry: number | null;
  cap: { usedBps: number; roomBps: number };
  list: TaskRowJson[];
}

/** The parts of a record (version 2) this journey reads. The whole record is checked by the checker script. */
export interface NumbersJson {
  version: number;
  chainId: number;
  launcher: string;
  key: string;
  founder: string;
  playMoney: boolean;
  contracts: { treasury: string; shares: string; dollar: string };
  asOf: { block: number; time: number };
  builtAt: number;
  refreshEverySecs: number;
  money: {
    pot: string;
    paidIn: string;
    arriving: string;
    feesOwed: string;
    held: string;
    locked: string;
    notesOwed: string;
  };
  shares: { backers: string; teamCounted: string };
  value: { leaveValue: string };
  allowance: { ratePpm: number; box: string; boxCap: string };
  clock: { lastCheckIn: number | null; lastRecordHash: string | null };
  quiet: { state: string };
  totals: {
    joined: string;
    fees: string;
    drawn: string;
    outside: string;
    tookOut: string;
    paidToWorkers: string;
    noteClaims: string;
  };
  tasks?: TasksJson | null;
  holders: { account: string; shares: string }[];
  /** Step 3's keys (RECORD-V2 section 11): an object, or null for "not known here"; absent in a record from an older server. */
  held?: HeldJson | null;
  feed?: FeedJson | null;
  streaks?: {
    updates: { weeks: number; longest: number; lastAt: number | null };
  } | null;
  established?: EstablishedJson | null;
}

/** The record's `held` key: how long money has stayed (the ranking's and the badge's inputs). */
export interface HeldJson {
  windows: { rankSecs: number; badgeSecs: number };
  rank: { shares: string; bps: number; money: string; accounts: number } | null;
  badge: { shares: string; bps: number } | null;
  countedAccounts: number;
}

/** The record's `feed` key: hours of joins and take-outs, rounded, with no names. */
export interface FeedJson {
  roundTo: string;
  bucketSecs: number;
  hours: {
    at: number;
    joins: number;
    tookOut: number;
    net: { dir: "in" | "out" | "even"; amount: string };
  }[];
  items: {
    kind: string;
    at: number;
    serial: number | null;
    date: number | null;
  }[];
  cut: number;
}

/** The record's `established` key: the badge's rule, its three inputs and the server's verdict. */
export interface EstablishedJson {
  rule: { minHeldBps: number; heldSecs: number; minAccounts: number };
  heldBps: number | null;
  accounts: number | null;
  twoSigners: boolean;
  reached: boolean | null;
}

/**
 * Wait until the newest record satisfies `done`, polling the server; returns it. The reader signs a record about two blocks
 * after the event it shows, so this is how a journey waits for "the server has read the block".
 */
export async function waitForRecord(
  key: string,
  what: string,
  done: (numbers: NumbersJson) => boolean,
  seconds = 90,
): Promise<{ event: StoredEvent; content: NumbersJson }> {
  const deadline = Date.now() + seconds * 1000;
  let last = "no record yet";
  while (Date.now() < deadline) {
    const record = await newestRecord(key);
    if (record) {
      if (done(record.content)) return record;
      last = `block ${record.content.asOf.block}, pot ${record.content.money.pot}`;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `the server never signed a record where ${what} (last: ${last})`,
  );
}

/** The account key of the person whose browser is `page`'s: read from the page's storage and unwrapped (the app's own storage form). */
export async function secretKeyOf(page: {
  evaluate: <T>(fn: () => T) => Promise<T>;
}): Promise<Uint8Array> {
  const stored = await page.evaluate(() => ({
    blob: localStorage.getItem("buzz.identity.nsec"),
    wrap: localStorage.getItem("buzz.identity.wrap"),
  }));
  if (!stored.blob) throw new Error("this browser has no account yet");
  if (stored.blob.startsWith("ncryptsec1")) {
    if (!stored.wrap) throw new Error("the account's wrapping key is missing");
    return nip49.decrypt(stored.blob, stored.wrap);
  }
  return hexToBytes(stored.blob);
}

/** Post an event already signed by `key` (a founder's record) as a signed request; throws unless the server took it. */
export async function publishSigned(
  event: ReturnType<typeof finalizeEvent>,
  key: Uint8Array,
): Promise<void> {
  const { status, text } = await post("/events", JSON.stringify(event), key);
  if (status !== 200 || !/"accepted"\s*:\s*true/.test(text))
    throw new Error(
      `a record of kind ${event.kind} was not accepted (${status}): ${text}`,
    );
}

/**
 * Post an event signed by `key` and say what the server answered, without judging it: a journey that wants a refusal reads the
 * server's own words from `text` (the status is 200 for a refusal too; the words say which).
 */
export async function tryPublish(
  event: ReturnType<typeof finalizeEvent>,
  key: Uint8Array,
): Promise<{ accepted: boolean; text: string }> {
  const { text } = await post("/events", JSON.stringify(event), key);
  return { accepted: /"accepted"\s*:\s*true/.test(text), text };
}

/**
 * The founder's own project record again, naming its launch in a `chain-key` tag (every other tag and the content kept), signed
 * by the founder's key and posted to the server as a signed request: what the app's "put it on the network" step writes.
 */
export async function nameTheLaunch(
  founderKey: Uint8Array,
  founderPubkey: string,
  projectId: string,
  chainKey: string,
): Promise<void> {
  const [current] = await query({
    kinds: [37001],
    authors: [founderPubkey],
    "#d": [projectId],
    limit: 1,
  });
  if (!current) throw new Error("the server has no record of the project");
  const next = finalizeEvent(
    {
      kind: 37001,
      content: current.content,
      tags: withChainKey(current.tags, chainKey),
      created_at: Math.max(
        Math.floor(Date.now() / 1000),
        current.created_at + 1,
      ),
    },
    founderKey,
  );
  await publishSigned(next, founderKey);
}

// --- The chain -----------------------------------------------------------------------------------------------------

/** The world the chain-moving helpers of the app's specs expect, for the chain this run's script started and deployed. */
export async function worldOnThisChain(): Promise<LiveWorld> {
  pointAtRpc(need("POT_RPC_URL"));
  const deployments = JSON.parse(
    readFileSync(need("POT_DEPLOYMENTS_FILE"), "utf8"),
  ) as { launcher: string; quote: string; parts: string; unit: number };
  const [admin, founder, backer, second, member, stranger, helper] =
    await accounts();
  const chain: PotChain = {
    dollar: deployments.quote.toLowerCase(),
    parts: deployments.parts.toLowerCase(),
    launcher: deployments.launcher.toLowerCase(),
    unit: deployments.unit,
  };
  return {
    rpcUrl: need("POT_RPC_URL"),
    chain,
    who: { admin, founder, backer, second, member, helper, stranger },
    stop: async () => {},
  };
}

/**
 * The one-line summaries of a failed checker run are the checker's own words; this runs it and returns how many checks it made.
 * With `stop` the checker compares what tasks and money can change (the frame, the money, the totals, the whole task section).
 */
export function checkAgainstContracts(
  record: unknown,
  expected: Record<string, unknown>,
  stop = false,
): number {
  const dir = need("POT_STATE_DIR");
  const recordFile = resolve(dir, "record.json");
  const expectedFile = resolve(dir, "expected.json");
  writeFileSync(recordFile, JSON.stringify(record));
  writeFileSync(expectedFile, JSON.stringify(expected));
  const out = spawnSync(
    "python3",
    [
      "-I",
      resolve(need("POT_REPO_ROOT"), "scripts/chain-loop-pot-check.py"),
      ...(stop ? ["--stop"] : []),
      need("POT_RPC_URL"),
      recordFile,
      expectedFile,
    ],
    { encoding: "utf8" },
  );
  if (out.status !== 0)
    throw new Error(
      `the record and the contracts differ:\n${out.stdout.slice(-600)}\n${out.stderr.slice(-600)}`,
    );
  const match = /^CHECKS (\d+)$/m.exec(out.stdout);
  if (!match) throw new Error("the field-by-field check did not finish");
  return Number(match[1]);
}

/** Dollars as the page words them: whole dollars with thousands marked and cents only when there are some, rounded down; under a dollar, up to six decimals (never fewer than two). */
export function dollarsAsPageSays(raw: bigint): string {
  const DOLLAR = 1_000_000n;
  const group = (n: bigint) =>
    n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  if (raw >= DOLLAR) {
    const cents = (raw % DOLLAR) / 10_000n;
    return cents === 0n
      ? group(raw / DOLLAR)
      : `${group(raw / DOLLAR)}.${cents.toString().padStart(2, "0")}`;
  }
  const decimals = raw.toString().padStart(6, "0").replace(/0+$/, "");
  return `0.${decimals.padEnd(2, "0")}`;
}

/** Whole Shares as the page words them: rounded down, thousands marked. */
export function sharesAsPageSays(raw: bigint): string {
  return (raw / 10n ** 18n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** A fresh random hex word, for names that must not meet an earlier run's. */
export const tag = (): string => bytesToHex(generateSecretKey()).slice(0, 6);

/** The server's helper jobs (its own table), for the one check that it sent only what it may. */
export function helperJobs(): { call: string; state: string }[] {
  const out = spawnSync(
    "psql",
    [
      need("POT_DB_URL"),
      "-Atc",
      "select call || '|' || state from chain_helper_jobs order by id",
    ],
    { encoding: "utf8" },
  );
  if (out.status !== 0)
    throw new Error(`could not read the helper's jobs: ${out.stderr}`);
  return out.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [call, state] = line.split("|");
      return { call, state };
    });
}

/** Dollars as a sentence on the page words them: whole dollars with thousands marked, cents only when there are some (two decimals, rounded down). */
export function dollarsInASentence(raw: bigint): string {
  const DOLLAR = 1_000_000n;
  const whole = (raw / DOLLAR).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const cents = (raw % DOLLAR) / 10_000n;
  return cents === 0n ? whole : `${whole}.${cents.toString().padStart(2, "0")}`;
}

/** A block a second, like a chain that is alive. */
export function startMiner(): () => void {
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void rpc("evm_mine", [])
      .catch(() => undefined)
      .finally(() => {
        busy = false;
      });
  }, 1000);
  return () => clearInterval(timer);
}

// --- Things the step 3 journeys do in the app and with a stand-in push service ---------------------------------------

/** The local stand-in for a push service the loop started (empty when this world has none). */
export const STANDIN_URL = process.env.POT_STANDIN_URL ?? "";

/** Say something to the push stand-in (its own small HTTP interface) and read the answer as JSON. */
export async function standin<T = unknown>(
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${STANDIN_URL}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok)
    throw new Error(`the stand-in answered ${res.status} for ${path}`);
  return (await res.json()) as T;
}

/** A project started in the app and launched on the chain, as its founder's page sees it. */
export interface StartedProject {
  name: string;
  /** The page's path: /p/<id>-<16 hex of the founder>. */
  link: string;
  projectId: string;
  founderPub: string;
  project: LiveProject;
}

/**
 * The founder's page (a phone with the founder's wallet and an account) starts a project from the app's own form and launches it
 * on the chain from the launch card, then reads what the chain made of it. One signature asks the wallet once.
 */
export async function startAndLaunch(
  w: LiveWorld,
  founder: Page,
  name: string,
  goal = "A shared repair shop for night-market stalls.",
  how = "Ten stalls bring their tools and share them.",
  /** Run once the launch sheet is open and before the founder signs: what a journey reads on it. */
  onLaunchSheet?: (page: Page) => Promise<void>,
): Promise<StartedProject> {
  await founder.goto("/start");
  await founder.getByTestId("start-name").fill(name);
  await founder.getByTestId("start-goal").fill(goal);
  await founder.getByTestId("start-how").fill(how);
  await founder.getByTestId("start-submit").click();
  await expect(founder.getByTestId("project-name")).toHaveText(name);
  const link = new URL(founder.url()).pathname;
  const ref = /^\/p\/(.+)-([0-9a-f]{16})$/.exec(link);
  if (!ref) throw new Error(`not a project link: ${link}`);
  const projectId = ref[1];
  const founderPub = getPublicKey(await secretKeyOf(founder));
  await expect(founder.getByTestId("launch-card")).toBeVisible({
    timeout: 20_000,
  });
  await founder.getByTestId("launch-open").click();
  await expect(founder.getByTestId("launch-sheet")).toBeVisible();
  if (onLaunchSheet) await onLaunchSheet(founder);
  await founder.getByTestId("sheet-confirm").click();
  await expect(founder.getByTestId("launch-sheet")).toBeHidden({
    timeout: 30_000,
  });
  // The sheet closes when the launch lands; the founder's own record naming the launch is written a moment later. A page left in
  // that moment (the next step of a journey is a new address) leaves the project launched on the network and not tied to its
  // page: its record names no launch, so no list of the founder's projects offers it, until "Finish linking" is
  // pressed. The app's own sign that the page is tied is that the launch card is gone.
  await expect(founder.getByTestId("launch-card")).toBeHidden({
    timeout: 30_000,
  });
  const project = await launchedProject(w, projectId, founderPub);
  return { name, link, projectId, founderPub, project };
}

/**
 * A person presses Back from the project's page with `dollars` play dollars (the faucet first when they have none): two presses.
 * The box that links the account to the wallet starts unticked (a box that makes something public is never pre-ticked): the
 * helper checks that, then ticks it unless `linkWallet` is false, so a person who does not tick it can be followed into the room.
 */
export async function backInApp(
  page: Page,
  dollars: number,
  options: { linkWallet?: boolean } = {},
): Promise<void> {
  const linkWallet = options.linkWallet ?? true;
  const amount = page.getByTestId("backing-amount");
  await expect(amount).toBeVisible({ timeout: 20_000 });
  await amount.fill(String(dollars));
  await page.getByTestId("backing-review").click();
  await expect(page.getByTestId("back-sheet")).toBeVisible();
  const choice = page.getByTestId("back-link-choice");
  await expect(choice).toBeVisible({ timeout: 20_000 });
  await expect(choice, "the link box starts unticked").not.toBeChecked();
  if (linkWallet) await choice.check();
  await page.getByTestId("sheet-confirm").click();
  await expect(page.getByTestId("back-sheet")).toBeHidden({ timeout: 30_000 });
}

/** Put a page's clock on the chain's when the chain's clock was moved ahead of the computer's (the page then agrees what day it is). */
export async function syncClock(page: Page): Promise<void> {
  const chain = await chainNow();
  if (chain - Math.floor(Date.now() / 1000) > 30)
    await page.clock.install({ time: chain * 1000 });
}

/** A room post signed by `key` for a project (what the app's composer sends), not yet sent: for what a refusal says. */
export function signedRoomPost(
  key: Uint8Array,
  text: string,
  founderPub: string,
  projectId: string,
  chainKey: string,
): ReturnType<typeof finalizeEvent> {
  const template = buildPost({
    text,
    room: { launch: { pubkey: founderPub, id: projectId }, key: chainKey },
  });
  return finalizeEvent(
    { ...template, created_at: Math.floor(Date.now() / 1000) },
    key,
  );
}

/** One number from the server's own database (a count the journey checks directly: what the server kept, never what a page says). */
export function dbCount(sql: string): number {
  const out = spawnSync("psql", [need("POT_DB_URL"), "-Atc", sql], {
    encoding: "utf8",
  });
  if (out.status !== 0)
    throw new Error(`could not read the server's database: ${out.stderr}`);
  return Number(out.stdout.trim());
}

/**
 * The screen as it is now, at the narrowest phone this app holds (360 x 640): nothing sticks out sideways (the page, and an open
 * sheet inside it), and each of `ids` is on the screen. The page goes back to the journey's own size afterwards.
 */
export async function atNarrowPhone(
  page: Page,
  what: string,
  ids: string[],
): Promise<void> {
  const before = page.viewportSize();
  await page.setViewportSize({ width: 360, height: 640 });
  // Let the layout settle (text wraps again at the new width).
  await page.waitForTimeout(300);
  const sideways = await page.evaluate(() => {
    const widest = (el: Element | null) =>
      el ? el.scrollWidth - el.clientWidth : 0;
    return {
      page: document.documentElement.scrollWidth - window.innerWidth,
      sheet: widest(document.querySelector("[role='dialog']")),
    };
  });
  check(
    sideways.page <= 0 && sideways.sheet <= 0,
    `${what}: nothing sticks out sideways at 360 px`,
  );
  for (const id of ids) await expect(page.getByTestId(id)).toBeVisible();
  ok(`${what}: ${ids.join(", ")} are on the screen at 360 px`);
  if (before) await page.setViewportSize(before);
}
