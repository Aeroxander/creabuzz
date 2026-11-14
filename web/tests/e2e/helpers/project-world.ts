import type { Page } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";

import { COMMUNITY_HOST, type createMockRelay, matches } from "../mock-relay";

/**
 * What the specs about projects share: people with keys of their own, records as the app publishes them, and a page
 * wired to one mock server. A person is swapped by changing whose key the page has and loading again (`openAs`), so
 * what each sees is read back from the server, never from another's page memory.
 */

export type Relay = ReturnType<typeof createMockRelay>;

export const pubkeyOf = (key: string) =>
  getPublicKey(Uint8Array.from(Buffer.from(key, "hex")));

export const DAY = 86_400;
export const now = () => Math.floor(Date.now() / 1000);

let sequence = 0;
/** A stored record. Seeded records are not signature-checked, as stored ones are not. */
export function event(
  kind: number,
  pubkey: string,
  content: unknown,
  tags: string[][],
  at: number,
) {
  sequence += 1;
  return {
    id: `e${sequence.toString(16).padStart(63, "0")}`,
    kind,
    pubkey,
    content: typeof content === "string" ? content : JSON.stringify(content),
    tags,
    created_at: at,
    sig: "0".repeat(128),
  };
}

/** A project with no Shares and no sale, as the short Start form makes it. */
export function projectRecord(
  founder: string,
  id: string,
  name: string,
  at: number,
  extra: { content?: Record<string, unknown>; tags?: string[][] } = {},
) {
  return event(
    37001,
    founder,
    { pitch: `${name}, in one sentence.`, stage: "draft", ...extra.content },
    [
      ["d", id],
      ["name", name],
      ["t", "dao-launchpad"],
      ["admission", "curated"],
      ...(extra.tags ?? []),
    ],
    at,
  );
}

export const coordOf = (founder: string, id: string) =>
  `37001:${founder}:${id}`;
export const projectPath = (founder: string, id: string) =>
  `/launchpad/${id}?author=${founder}`;

/** Wire the page to the mock server, signed in with `key` (or nobody) until `openAs` changes who it is. */
export async function install(page: Page, relay: Relay, key: string | null) {
  await relay.install(page);
  await page.addInitScript((first) => {
    const chosen = localStorage.getItem("e2e.key") ?? first;
    if (chosen === null || chosen === "none") {
      localStorage.removeItem("buzz.identity.nsec");
      return;
    }
    localStorage.setItem("buzz.identity.nsec", chosen);
    localStorage.setItem("buzz.identity.backedUp", "1");
  }, key);
  await page.route("**/communities", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        communities: [
          {
            host: COMMUNITY_HOST,
            name: "Alpha",
            description: "Build together",
            icon: null,
            member_count: 3,
            archived: false,
          },
        ],
      }),
    }),
  );
  await page.route("**/query", (route) => {
    const filters = JSON.parse(route.request().postData() ?? "[]");
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        relay.events.filter((e) =>
          filters.some((f: Parameters<typeof matches>[0]) => matches(f, e)),
        ),
      ),
    });
  });
}

/** Become another person (or nobody) and open `path` as them. */
export async function openAs(page: Page, key: string | null, path: string) {
  await page.evaluate(
    (next) => localStorage.setItem("e2e.key", next ?? "none"),
    key,
  );
  await page.goto(path);
}

/** The newest stored record of `kind` by `pubkey`, parsed content included. */
export function newest(relay: Relay, kind: number, pubkey: string) {
  const found = relay.events
    .filter((e) => e.kind === kind && e.pubkey === pubkey)
    .sort((a, b) => b.created_at - a.created_at)[0];
  return found
    ? {
        ...found,
        body: JSON.parse(found.content || "{}") as Record<string, unknown>,
      }
    : null;
}
