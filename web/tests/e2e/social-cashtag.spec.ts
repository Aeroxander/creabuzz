import { expect, test } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";

/**
 * A `$TICKER` in a post links to the launch that owns it, and a ticker nobody has claimed stays plain text.
 * The relay is an in-memory stub that answers a post by id and the launch directory; nothing else is real.
 */

const NSEC = "22".repeat(32);
const ME = getPublicKey(
  Uint8Array.from(NSEC.match(/.{2}/g) ?? [], (b) => Number.parseInt(b, 16)),
);
const POST_ID = "ab".repeat(32);

interface StoredEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

const post: StoredEvent = {
  id: POST_ID,
  pubkey: ME,
  created_at: 200,
  kind: 1,
  tags: [],
  content: "Backing $neb today, not $ZZZ. It costs $5.",
  sig: "sig",
};

function launch(id: string, symbol: string, createdAt: number): StoredEvent {
  return {
    id: `record-${id}`,
    pubkey: ME,
    created_at: createdAt,
    kind: 37001,
    tags: [
      ["d", id],
      ["name", `Project ${id}`],
      ["t", "dao-launchpad"],
    ],
    content: JSON.stringify({
      pitch: "To the stars.",
      stage: "live",
      tokenPlan: {
        mode: "mint",
        name: `${symbol} Token`,
        symbol,
        supply: "1000",
      },
    }),
    sig: "sig",
  };
}

test("a ticker in a post links to the launch that claimed it first", async ({
  page,
}) => {
  const events = [
    post,
    // Two launches want NEB; the earlier record owns it.
    launch("nebula", "NEB", 100),
    launch("copycat", "neb", 150),
  ];
  await page.routeWebSocket(/127\.0\.0\.1:4173/, (ws) => {
    ws.onMessage((message) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(message));
      } catch {
        return;
      }
      if (!Array.isArray(parsed)) return;
      if (parsed[0] === "EVENT") {
        ws.send(
          JSON.stringify(["OK", (parsed[1] as StoredEvent).id, true, ""]),
        );
        return;
      }
      if (parsed[0] !== "REQ") return;
      const [, subId, filter] = parsed as [
        string,
        string,
        { kinds?: number[]; ids?: string[]; "#e"?: string[] },
      ];
      for (const event of events) {
        if (filter.kinds && !filter.kinds.includes(event.kind)) continue;
        if (filter.ids && !filter.ids.includes(event.id)) continue;
        if (filter["#e"]) continue;
        ws.send(JSON.stringify(["EVENT", subId, event]));
      }
      ws.send(JSON.stringify(["EOSE", subId]));
    });
  });
  await page.addInitScript(
    ([nsec]) => window.localStorage.setItem("buzz.identity.nsec", nsec),
    [NSEC],
  );
  await page.goto(`/social/post/${POST_ID}`);

  const chip = page.getByTestId("social-cashtag");
  await expect(chip).toHaveCount(1, { timeout: 15_000 });
  await expect(chip).toHaveText("$NEB");
  await expect(chip).toHaveAttribute(
    "aria-label",
    "$NEB: Project nebula, open for backers",
  );
  await expect(chip).toHaveAttribute("href", /\/launchpad\/nebula/);

  // A ticker nobody claimed and a price are plain words, not links.
  const body = page.getByTestId("social-thread-focus");
  await expect(body).toContainText("not $ZZZ. It costs $5.");
  await expect(body.getByRole("link", { name: /ZZZ/ })).toHaveCount(0);
});
