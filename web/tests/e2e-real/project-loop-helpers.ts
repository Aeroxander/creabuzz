import { execFile } from "node:child_process";

import { test, type Browser, type Page } from "@playwright/test";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure";

/**
 * What `project-loop.spec.ts` needs besides the browser: people with throwaway keys, a socket of their own to the real
 * server (to write what the app would never offer, and to read what the server really stored), and the `buzz` command
 * line run as one of them. Every key is made when the run starts and is never written anywhere.
 */

export interface StoredEvent {
  id: string;
  kind: number;
  pubkey: string;
  content: string;
  tags: string[][];
  created_at: number;
  sig: string;
}

export interface EventTemplate {
  kind: number;
  content: string;
  tags: string[][];
  created_at?: number;
}

export interface Account {
  key: Uint8Array;
  hexKey: string;
  pubkey: string;
  name: string;
}

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export function accountFromKey(key: Uint8Array, name: string): Account {
  return { key, hexKey: toHex(key), pubkey: getPublicKey(key), name };
}

export const newAccount = (name: string) =>
  accountFromKey(generateSecretKey(), name);

/** The server's address, from the same setting the Playwright config reads. */
export const HTTP_URL = (
  process.env.BUZZ_REAL_RELAY_URL ?? "http://localhost:3199"
).replace(/\/$/, "");
export const WS_URL = HTTP_URL.replace(/^http/, "ws");

const now = () => Math.floor(Date.now() / 1000);

/**
 * A signed-in socket for `who`: resolves once the server accepted the sign-in. `run` gets `send` and a way to wait for
 * the next frame that `pick` accepts; the socket is closed however `run` ends, and nothing waits longer than 20 s.
 */
async function withSocket<T>(
  who: Account,
  run: (
    send: (frame: unknown[]) => void,
    next: <R>(pick: (frame: unknown[]) => R | undefined) => Promise<R>,
  ) => Promise<T>,
): Promise<T> {
  const ws = new WebSocket(WS_URL);
  const frames: unknown[][] = [];
  let wake: (() => void) | null = null;
  let failure: Error | null = null;
  ws.addEventListener("message", (message) => {
    frames.push(JSON.parse(String(message.data)) as unknown[]);
    wake?.();
  });
  ws.addEventListener("close", () => {
    failure ??= new Error("the server closed the socket");
    wake?.();
  });
  ws.addEventListener("error", () => {
    failure ??= new Error(`could not reach the server at ${WS_URL}`);
    wake?.();
  });
  const send = (frame: unknown[]) => ws.send(JSON.stringify(frame));
  const next = async <R>(
    pick: (frame: unknown[]) => R | undefined,
  ): Promise<R> => {
    const deadline = Date.now() + 20_000;
    for (;;) {
      while (frames.length > 0) {
        const picked = pick(frames.shift() as unknown[]);
        if (picked !== undefined) return picked;
      }
      if (failure) throw failure;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error("the server did not answer in 20 s");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  };
  try {
    const challenge = await next((f) =>
      f[0] === "AUTH" ? String(f[1]) : undefined,
    );
    send([
      "AUTH",
      finalizeEvent(
        {
          kind: 22242,
          created_at: now(),
          tags: [
            ["relay", WS_URL],
            ["challenge", challenge],
          ],
          content: "",
        },
        who.key,
      ),
    ]);
    const signedIn = await next((f) =>
      f[0] === "OK"
        ? { ok: Boolean(f[2]), reason: String(f[3] ?? "") }
        : undefined,
    );
    if (!signedIn.ok)
      throw new Error(`the server refused the sign-in: ${signedIn.reason}`);
    return await run(send, next);
  } finally {
    ws.close();
  }
}

export interface Answer {
  event: StoredEvent;
  accepted: boolean;
  reason: string;
}

/** Sign `template` as `who` and send it. Resolves with the server's own answer, accepted or refused. */
export function publishAs(
  who: Account,
  template: EventTemplate,
): Promise<Answer> {
  const event = finalizeEvent(
    { ...template, created_at: template.created_at ?? now() },
    who.key,
  ) as StoredEvent;
  return withSocket(who, async (send, next) => {
    send(["EVENT", event]);
    return next((f) =>
      f[0] === "OK" && f[1] === event.id
        ? { event, accepted: Boolean(f[2]), reason: String(f[3] ?? "") }
        : undefined,
    );
  });
}

/** Send many records on one socket (a seed): resolves with how many the server accepted, and the first refusal. */
export function publishManyAs(
  who: Account,
  templates: EventTemplate[],
): Promise<{ accepted: number; firstRefusal: string | null }> {
  return withSocket(who, async (send, next) => {
    let accepted = 0;
    let firstRefusal: string | null = null;
    for (const template of templates) {
      const event = finalizeEvent(
        { ...template, created_at: template.created_at ?? now() },
        who.key,
      );
      send(["EVENT", event]);
      const answer = await next((f) =>
        f[0] === "OK" && f[1] === event.id
          ? { ok: Boolean(f[2]), reason: String(f[3] ?? "") }
          : undefined,
      );
      if (answer.ok) accepted += 1;
      else firstRefusal ??= answer.reason;
    }
    return { accepted, firstRefusal };
  });
}

/** Read with one filter, as `who`, until the server says that is all it has. */
export function readAs(
  who: Account,
  filter: Record<string, unknown>,
): Promise<StoredEvent[]> {
  return withSocket(who, async (send, next) => {
    const sub = `read-${Math.random().toString(36).slice(2)}`;
    const found: StoredEvent[] = [];
    send(["REQ", sub, filter]);
    await next((f) => {
      if (f[0] === "EVENT" && f[1] === sub) {
        found.push(f[2] as StoredEvent);
        return undefined;
      }
      if (f[0] === "EOSE" && f[1] === sub) return true;
      if (f[0] === "CLOSED" && f[1] === sub)
        throw new Error(`the server closed the read: ${String(f[2] ?? "")}`);
      return undefined;
    });
    return found;
  });
}

export const tagOf = (event: StoredEvent, name: string) =>
  event.tags.find((tag) => tag[0] === name)?.[1];

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  /** stdout as JSON when it is JSON. */
  json: unknown;
}

/** Run the real `buzz` command line as `who` against the server under test. Never throws on a non-zero exit. */
export function buzz(who: Account, args: string[]): Promise<CliResult> {
  const bin = process.env.BUZZ_BIN;
  if (!bin)
    throw new Error("BUZZ_BIN is not set (scripts/real-loop-e2e.sh sets it)");
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      {
        timeout: 60_000,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          BUZZ_RELAY_URL: WS_URL,
          BUZZ_PRIVATE_KEY: who.hexKey,
        },
      },
      (error, stdout, stderr) => {
        let json: unknown = null;
        try {
          json = JSON.parse(stdout);
        } catch {
          json = null;
        }
        const code =
          error === null
            ? 0
            : typeof error.code === "number"
              ? error.code
              : 124;
        resolve({ code, stdout, stderr, json });
      },
    );
  });
}

/**
 * A browser of its own for one person: this host's Chromium runs `--single-process`, where a second context kills the
 * whole browser (see `tests/e2e/helpers/own-browser.ts`). Kept for the whole file, closed by `closeBrowsers`.
 */
const launched: Browser[] = [];
export async function ownBrowserPage(browser: Browser): Promise<Page> {
  const own = await browser
    .browserType()
    .launch(test.info().project.use.launchOptions);
  launched.push(own);
  const context = await own.newContext({
    viewport: { width: 1280, height: 900 },
  });
  context.setDefaultTimeout(30_000);
  return context.newPage();
}

export async function closeBrowsers(): Promise<void> {
  await Promise.all(launched.splice(0).map((own) => own.close()));
}

/** With `E2E_SHOTS=<dir>`, save the page as it looks now. */
export async function shot(page: Page, name: string) {
  const dir = process.env.E2E_SHOTS;
  if (!dir) return;
  await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });
}
