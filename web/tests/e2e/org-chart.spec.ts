/**
 * Org chart (NIP-ORG `37010`) — chart mode vs roster fallback.
 *
 * The Org view is read-only and two-moded: when `37010` org-node events exist
 * for the community (org nodes are community-level NIP-ORG events, never
 * channel-scoped) it renders a tree of role cards with occupant chips; when
 * none exist it falls back to the flat team-grouped agent roster exactly as
 * before. These tests prove both modes over a mocked relay
 * WebSocket, in the same style as the fleet/work-board smoke tests.
 */
import { expect, test } from "@playwright/test";

const CHANNEL_ID = "0f0f0f0f-1111-2222-3333-444444444444";
const FOUNDER = "a".repeat(64);
const CTO_AGENT = "c".repeat(64);
const ANIMATOR = "d".repeat(64);

function channelEvent() {
  return {
    id: "chan-event-1",
    pubkey: "b".repeat(64),
    created_at: 100,
    kind: 39000,
    tags: [
      ["d", CHANNEL_ID],
      ["name", "general"],
    ],
    content: "",
    sig: "sig",
  };
}

function orgNodeEvent(
  id: string,
  createdAt: number,
  body: Record<string, unknown>,
  tags: string[][] = [],
) {
  // No `h` tag: NIP-ORG nodes are community-level (like a project `30621` or
  // a launch record `37001`), addressed by (pubkey, kind, `d`). A stray `h`
  // is tolerated by the relay but never routes.
  return {
    id: `org-${id}`,
    pubkey: FOUNDER,
    created_at: createdAt,
    kind: 37010,
    tags: [["d", id], ...tags],
    content: JSON.stringify(body),
    sig: "sig",
  };
}

const CTO_ROOT = orgNodeEvent(
  "cto",
  100,
  {
    v: 1,
    name: "CTO",
    kind: "role",
    holders: [FOUNDER],
    agentSeats: [CTO_AGENT],
    scope: { readBelow: true, assignBelow: true },
  },
  [["name", "CTO"]],
);

const ENG_CHILD = orgNodeEvent("eng", 101, {
  v: 1,
  name: "Eng",
  kind: "team",
  parent: "cto",
  holders: [ANIMATOR],
  agentSeats: [],
});

async function mockDirectory(page: import("@playwright/test").Page) {
  await page.route("**/communities", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        communities: [
          {
            host: "alpha.example.com",
            name: "Alpha",
            description: "A test community.",
            icon: null,
            member_count: 3,
            archived: false,
          },
        ],
      }),
    });
  });
}

/**
 * Mock relay that serves one channel plus (optionally) org nodes, and
 * answers every other filter with an empty EOSE. No profile (kind 0) rows
 * are served, so occupant chips fall back to truncated pubkeys — which is
 * what the test asserts on.
 */
async function mockRelayWithOrg(
  page: import("@playwright/test").Page,
  orgNodes: ReturnType<typeof orgNodeEvent>[],
) {
  await mockDirectory(page);
  await page.routeWebSocket(/127\.0\.0\.1:4173/, (ws) => {
    ws.onMessage((message) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(message));
      } catch {
        return;
      }
      if (!Array.isArray(parsed) || parsed[0] !== "REQ") return;
      const [, subId, filter] = parsed as [
        string,
        string,
        { kinds?: number[] },
      ];
      const kinds = filter.kinds ?? [];
      if (kinds.includes(39000)) {
        ws.send(JSON.stringify(["EVENT", subId, channelEvent()]));
      } else if (kinds.includes(37010)) {
        for (const node of orgNodes) {
          ws.send(JSON.stringify(["EVENT", subId, node]));
        }
      }
      ws.send(JSON.stringify(["EOSE", subId]));
    });
  });
}

test("org chart renders role tree with occupant chips when nodes exist", async ({
  page,
}) => {
  await mockRelayWithOrg(page, [CTO_ROOT, ENG_CHILD]);
  await page.goto("/c/alpha.example.com");
  await page.getByTestId("content-pane").waitFor();
  await page.getByTestId("org-toggle").click();

  // Both roles render by name.
  await expect(page.getByText("CTO", { exact: true })).toBeVisible();
  await expect(page.getByText("Eng", { exact: true })).toBeVisible();

  // The occupant chips render (truncated pubkeys, no kind-0 profiles served).
  await expect(page.getByTitle(FOUNDER)).toBeVisible();
  await expect(page.getByTitle(CTO_AGENT)).toBeVisible();
  await expect(page.getByTitle(ANIMATOR)).toBeVisible();

  // Header counts the chart: two teams, three seats.
  await expect(page.getByText("2 teams · 3 seats")).toBeVisible();
});

test("org view falls back to the roster when no nodes exist", async ({
  page,
}) => {
  await mockRelayWithOrg(page, []);
  await page.goto("/c/alpha.example.com");
  await page.getByTestId("content-pane").waitFor();
  await page.getByTestId("org-toggle").click();

  // The pre-org fallback renders: no `37010` data means the old flat roster,
  // which with no agents reports an empty fleet rather than a chart.
  await expect(page.getByText(/0 agents · 0 online · 0 teams/)).toBeVisible();
  await expect(page.getByText("Loading org chart…")).toBeHidden();
  await expect(page.getByText("CTO", { exact: true })).toBeHidden();
});
