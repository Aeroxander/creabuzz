import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type Browser,
  type BrowserContext,
  test as base,
  type Page,
  type WebSocket,
} from "@playwright/test";

import {
  COUNTED,
  isRequestLimitRefusal,
  peakInWindow,
  sentFrame,
  WINDOW_MS,
} from "./frame-count.mjs";

/**
 * The frame meter: how close the web app comes to the server's general request limit. With SOCIAL_FRAME_REPORT=1 it
 * watches every page a test opens (the `page` fixture's and any `browser.newContext()` the test makes), counts the
 * REQ, COUNT and EVENT frames each signed-in account sends after signing in (what the limit counts, see
 * `frame-count.mjs`), and prints, per test, the busiest rolling 5 seconds of each account and how many requests the
 * server refused for going over. Each test's numbers are also appended as one JSON line to SOCIAL_FRAME_REPORT_FILE,
 * which `frame-report.mjs` sums up for the whole run (`scripts/web-social-e2e.sh` does this).
 *
 * Without SOCIAL_FRAME_REPORT=1 it does nothing. A spec opts in by importing `test` (and `expect`) from here instead of
 * from `@playwright/test`:
 *
 *   import { expect, test } from "./frame-meter";
 *
 * Requests the spec itself makes from Node (`post`, `readAs` in `social-helpers.mjs`) are not counted: they are the
 * test's own, not the app's.
 */

export { expect } from "@playwright/test";

const ENABLED = process.env.SOCIAL_FRAME_REPORT === "1";
/** The per-second limit the run's server has, when the script says (for the "over the limit" mark). */
const PER_SEC = Number(process.env.SOCIAL_WS_EVENTS_PER_SEC ?? "") || null;
const BUDGET = PER_SEC === null ? null : PER_SEC * (WINDOW_MS / 1000);

interface AccountFrames {
  /** When each counted frame was sent (ms). */
  times: number[];
  /** Every sent frame by type, counted or not. */
  byType: Record<string, number>;
  /** Requests the server refused for the request limit. */
  refused: number;
}

/** Names for the seeded people, so the report says "alice" rather than a key. */
function knownNames(): Map<string, string> {
  const names = new Map<string, string>();
  const here = dirname(fileURLToPath(import.meta.url));
  for (const file of [".social-fixture.json", ".fixture.json"]) {
    const path = join(here, file);
    if (!existsSync(path)) continue;
    try {
      const fixture = JSON.parse(readFileSync(path, "utf8")) as {
        people?: Record<string, string>;
        mentionPubkey?: string;
      };
      for (const [name, pubkey] of Object.entries(fixture.people ?? {}))
        names.set(pubkey, name);
      if (fixture.mentionPubkey) names.set(fixture.mentionPubkey, "mention");
    } catch {
      // A half-written fixture only costs the names; the counts are unaffected.
    }
  }
  return names;
}

class FrameMeter {
  readonly accounts = new Map<string, AccountFrames>();
  private readonly watched = new WeakSet<object>();
  private readonly names = knownNames();

  private account(key: string): AccountFrames {
    let frames = this.accounts.get(key);
    if (!frames) {
      frames = { times: [], byType: {}, refused: 0 };
      this.accounts.set(key, frames);
    }
    return frames;
  }

  /** The server limits each account per community, so an account on two communities is two lines. */
  private keyOf(pubkey: string, url: string): string {
    let host = url;
    try {
      host = new URL(url).host;
    } catch {
      // Not a URL: keep it as it is.
    }
    return `${this.names.get(pubkey) ?? pubkey.slice(0, 8)}@${host}`;
  }

  private socket(ws: WebSocket) {
    if (this.watched.has(ws)) return;
    this.watched.add(ws);
    // Until this socket signs in, the server counts nothing it sends.
    let key: string | null = null;
    const pending: string[] = [];
    ws.on("framesent", ({ payload }) => {
      const frame = sentFrame(payload);
      if (!frame) return;
      if (frame.type === "AUTH" && frame.pubkey) {
        key = this.keyOf(frame.pubkey, ws.url());
        const frames = this.account(key);
        for (const type of pending.splice(0))
          frames.byType[type] = (frames.byType[type] ?? 0) + 1;
      }
      if (!key) {
        pending.push(`${frame.type} (before sign-in)`);
        return;
      }
      const frames = this.account(key);
      frames.byType[frame.type] = (frames.byType[frame.type] ?? 0) + 1;
      if (COUNTED.has(frame.type)) frames.times.push(Date.now());
    });
    ws.on("framereceived", ({ payload }) => {
      if (key && isRequestLimitRefusal(payload)) this.account(key).refused += 1;
    });
  }

  context(context: BrowserContext) {
    if (this.watched.has(context)) return;
    this.watched.add(context);
    const page = (p: Page) => p.on("websocket", (ws) => this.socket(ws));
    for (const p of context.pages()) page(p);
    context.on("page", page);
  }

  /** One line per account, busiest first, and the test's peak. */
  report(title: string, file: string) {
    const rows = [...this.accounts.entries()]
      .map(([account, frames]) => ({
        account,
        peak: peakInWindow(frames.times),
        counted: frames.times.length,
        refused: frames.refused,
        byType: frames.byType,
      }))
      .sort((a, b) => b.peak - a.peak);
    const top = rows[0];
    const limit = BUDGET === null ? "" : ` (limit ${BUDGET})`;
    console.log(
      `[frames] ${title}: peak ${top?.peak ?? 0} in ${WINDOW_MS / 1000} s${limit}${top ? ` by ${top.account}` : ""}`,
    );
    for (const row of rows) {
      const over =
        BUDGET !== null && row.peak > BUDGET ? "  OVER THE LIMIT" : "";
      const types = Object.entries(row.byType)
        .map(([type, n]) => `${type} ${n}`)
        .join(", ");
      console.log(
        `[frames]   ${row.account}: peak ${row.peak}, ${row.counted} counted, ${row.refused} refused (${types})${over}`,
      );
    }
    const out = process.env.SOCIAL_FRAME_REPORT_FILE;
    if (out) {
      mkdirSync(dirname(out), { recursive: true });
      appendFileSync(
        out,
        `${JSON.stringify({ title, file, peak: top?.peak ?? 0, accounts: rows })}\n`,
      );
    }
  }
}

export const test = base.extend<{ frameMeter: undefined }>({
  frameMeter: [
    async (
      { browser, context }: { browser: Browser; context: BrowserContext },
      use,
      testInfo,
    ) => {
      if (!ENABLED) {
        await use(undefined);
        return;
      }
      const meter = new FrameMeter();
      meter.context(context);
      // Contexts the test opens itself (a second person in a browser of their own) are watched too, for this test only.
      const newContext = browser.newContext;
      browser.newContext = async (
        ...args: Parameters<Browser["newContext"]>
      ) => {
        const made = await newContext.apply(browser, args);
        meter.context(made);
        return made;
      };
      try {
        await use(undefined);
      } finally {
        browser.newContext = newContext;
      }
      // A test skipped from its body opened nothing: a line of zeros would only pull the run's numbers down. A test that
      // failed still reports what it sent (a refusal for the limit may be why it failed).
      if (testInfo.status !== "skipped") {
        const name =
          testInfo.retry > 0
            ? `${testInfo.title} (retry ${testInfo.retry})`
            : testInfo.title;
        meter.report(name, testInfo.file.split("/").pop() ?? testInfo.file);
      }
    },
    { auto: true },
  ],
});
