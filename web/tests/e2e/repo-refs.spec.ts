import { expect, type Page, test } from "@playwright/test";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure";

/**
 * A repository's branches, tags and HEAD come only from the record the community's own server signed (its `self` key in
 * the server's public information). The mock server here is careless on purpose: it answers every query with every
 * record for the repository, whoever wrote it, so what is checked is that the page itself refuses the others, also
 * after this browser moves to another community, and that a server which does not name its key gets a plain failure.
 * The pure rules are in `src/features/repos/lib/repo-refs.test.mjs`.
 */

const PORT = process.env.E2E_PORT ?? "4173";
const REPO = "creaton-app";
const serverA = generateSecretKey();
const serverB = generateSecretKey();
const forger = generateSecretKey();
const OWNER = "a1".repeat(32);

function stateRecord(
  secret: Uint8Array,
  at: number,
  head: string,
  refs: Record<string, string>,
) {
  return finalizeEvent(
    {
      kind: 30618,
      created_at: at,
      content: "",
      tags: [
        ["d", REPO],
        ...Object.entries(refs),
        ["HEAD", `ref: refs/heads/${head}`],
      ],
    },
    secret,
  );
}

const announcement = {
  id: "e".repeat(64),
  pubkey: OWNER,
  created_at: 50,
  kind: 30617,
  tags: [
    ["d", REPO],
    ["name", REPO],
  ],
  content: "",
  sig: "s".repeat(128),
};

const genuineA = stateRecord(serverA, 100, "main", {
  "refs/heads/main": "1".repeat(40),
  "refs/tags/v1": "1".repeat(40),
});
const forged = stateRecord(forger, 900, "evil", {
  "refs/heads/evil": "e".repeat(40),
  "refs/heads/evil2": "e".repeat(40),
  "refs/tags/v666": "e".repeat(40),
});
const genuineB = stateRecord(serverB, 100, "trunk", {
  "refs/heads/trunk": "2".repeat(40),
});
// Server A's key means nothing on server B.
const staleA = stateRecord(serverA, 950, "evil", {
  "refs/heads/evil": "e".repeat(40),
});

interface Server {
  self?: string;
  events: object[];
}

/** Answer every query on the preview's sockets (both host names) from `servers`, ignoring authors. */
async function careless(page: Page, servers: Record<string, Server>) {
  await page.route("**/info", (route) => {
    const host = new URL(route.request().url()).host;
    const server = servers[host];
    return route.fulfill({
      status: 200,
      headers: {
        "content-type": "application/nostr+json",
        "access-control-allow-origin": "*",
      },
      body: JSON.stringify(server?.self ? { self: server.self } : {}),
    });
  });
  await page.routeWebSocket(
    new RegExp(`(127\\.0\\.0\\.1|localhost):${PORT}`),
    (ws) => {
      const host = new URL(ws.url()).host;
      ws.onMessage((raw) => {
        const message = JSON.parse(String(raw));
        if (message[0] !== "REQ") return;
        const [, subId, ...filters] = message;
        const kinds = new Set(
          filters.flatMap((f: { kinds?: number[] }) => f.kinds ?? []),
        );
        for (const event of servers[host]?.events ?? []) {
          if (kinds.has((event as { kind: number }).kind)) {
            ws.send(JSON.stringify(["EVENT", subId, event]));
          }
        }
        ws.send(JSON.stringify(["EOSE", subId]));
      });
    },
  );
}

const A_HOST = `127.0.0.1:${PORT}`;
const B_HOST = `localhost:${PORT}`;

test("a newer record by someone else cannot change HEAD, branches or tags", async ({
  page,
}) => {
  await careless(page, {
    [A_HOST]: {
      self: getPublicKey(serverA),
      events: [announcement, forged, genuineA],
    },
  });
  await page.goto(`/repos/${REPO}`);
  await expect(page.getByText("1 branch", { exact: true })).toBeVisible();
  await expect(page.getByText("1 tag", { exact: true })).toBeVisible();
  await expect(page.getByText("main", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("evil")).toHaveCount(0);
});

test("after moving to another community, that server's key decides", async ({
  page,
}) => {
  await careless(page, {
    [A_HOST]: {
      self: getPublicKey(serverA),
      events: [announcement, forged, genuineA],
    },
    [B_HOST]: {
      self: getPublicKey(serverB),
      events: [announcement, staleA, forged, genuineB],
    },
  });
  await page.goto(`/repos/${REPO}`);
  await expect(page.getByText("main", { exact: true }).first()).toBeVisible();

  await page.evaluate(
    (url) => window.localStorage.setItem("buzz.relayUrl", url),
    `ws://${B_HOST}`,
  );
  await page.reload();
  await expect(page.getByText("trunk", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("1 branch", { exact: true })).toBeVisible();
  await expect(page.getByText("evil")).toHaveCount(0);
});

test("a server that does not name its key gets a plain failure, not anyone's refs", async ({
  page,
}) => {
  await careless(page, {
    [A_HOST]: { events: [announcement, forged, genuineA] },
  });
  await page.goto(`/repos/${REPO}`);
  const alert = page.getByTestId("repo-refs-error");
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("Couldn't show branches and tags");
  await expect(alert.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(page.getByText("evil")).toHaveCount(0);
  await expect(page.getByText("No commits yet")).toHaveCount(0);
});
