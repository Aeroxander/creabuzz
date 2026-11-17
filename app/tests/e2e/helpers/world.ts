import type { Page } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";
import type { createMockRelay } from "../mock-relay";

/**
 * What the specs share: people with keys of their own, records as the apps publish them, and a page wired to one
 * mock server (after web/tests/e2e/helpers/project-world.ts). A person is swapped by changing whose key the page has
 * and loading again (`openAs`), so what each sees is read back from the server.
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

/** A project with no Shares and no sale, as Start makes it. */
export function projectRecord(
  founder: string,
  id: string,
  name: string,
  pitch: string,
  at: number,
  tags: string[][] = [],
) {
  return event(
    37001,
    founder,
    { pitch, stage: "draft", started: at },
    [
      ["d", id],
      ["name", name],
      ["t", "dao-launchpad"],
      ["admission", "curated"],
      ...tags,
    ],
    at,
  );
}

export const coordOf = (founder: string, id: string) =>
  `37001:${founder}:${id}`;
export const projectLink = (founder: string, id: string) =>
  `/p/${id}-${founder.slice(0, 16)}`;

export const profile = (pubkey: string, name: string, about = "") =>
  event(0, pubkey, { name, display_name: name, about }, [], now() - 40 * DAY);

/** The hosted server's sign-up: terms of use, a privacy note and the age box. */
export const HOSTED_POLICY = {
  policy: {
    version: "v1",
    terms_markdown: "# Terms\n\nBe kind.",
    privacy_markdown: "# Privacy",
    age_attestation_required: true,
  },
};

/** Wire the page to the mock server, signed in with `key` (or nobody) until `openAs` changes who it is. */
export async function install(
  page: Page,
  relay: Relay,
  key: string | null,
  options: {
    keepSignUp?: boolean;
    policy?: unknown;
    investing?: boolean;
  } = {},
) {
  await relay.install(page);
  await page.route("**/api/join-policy", (route) =>
    route.fulfill({
      status: 200,
      json: options.policy ?? {},
    }),
  );
  if (options.investing)
    await page.route("**/info", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/nostr+json",
        body: JSON.stringify({ name: "Mock server", investing: true }),
      }),
    );
  await page.addInitScript(
    ([first, keepSignUp]) => {
      const chosen = localStorage.getItem("e2e.key") ?? first;
      if (chosen === null || chosen === "none") {
        if (!keepSignUp) localStorage.removeItem("buzz.identity.nsec");
        return;
      }
      localStorage.setItem("buzz.identity.nsec", chosen);
      localStorage.setItem("buzz.identity.backedUp", "1");
    },
    [key, options.keepSignUp === true] as const,
  );
}

/** Become another person (or nobody) and open `path` as them. */
export async function openAs(page: Page, key: string | null, path: string) {
  await page.evaluate(
    (next) => localStorage.setItem("e2e.key", next ?? "none"),
    key,
  );
  await page.goto(path);
}
