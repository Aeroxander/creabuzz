import type { Page } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";
import { PREVIEW_ORIGIN } from "../e2e/mock-relay";

/**
 * The funding-status world, shared by the regression spec
 * (`tests/e2e/funding-status.spec.ts`) and the simulation
 * (`tests/simulate/story.spec.ts`) so the two can never describe different
 * projects.
 *
 * Four projects that between them cover the rule the plan states
 * (docs/archive/funding-and-governance-plan.md §2): a declared stance stands, and the
 * records behind it only correct the card where the two contradict.
 *
 * | project | says            | records show  | card must say    |
 * | ------- | --------------- | ------------- | ---------------- |
 * | Aurora  | Planning a raise| nothing       | Planning a raise |
 * | Beacon  | Not raising     | nothing       | Not raising      |
 * | Cygnus  | Not raising     | a live sale   | Raising now      |
 * | Draco   | Rolling round   | raise closed  | Rolling round    |
 */

export const FOUNDER_NSEC = "22".repeat(32);
export const FOUNDER = getPublicKey(
  Uint8Array.from(FOUNDER_NSEC.match(/.{2}/g) ?? [], (byte) =>
    Number.parseInt(byte, 16),
  ),
);

export interface Fixture {
  id: string;
  name: string;
  stage: string;
  createdAt: number;
  funding: Record<string, unknown> | undefined;
}

export const FIXTURES: Fixture[] = [
  {
    id: "aurora",
    name: "Aurora",
    stage: "review",
    createdAt: 300,
    funding: {
      stance: "planning",
      seeking: ["backers"],
      path: "auction",
      opensAt: "2026-11-01",
      note: "Aiming for late autumn.",
    },
  },
  {
    id: "beacon",
    name: "Beacon",
    stage: "review",
    createdAt: 200,
    funding: { stance: "not-raising", seeking: ["contributors"] },
  },
  {
    id: "cygnus",
    name: "Cygnus",
    stage: "funding",
    createdAt: 150,
    funding: { stance: "not-raising" },
  },
  {
    id: "draco",
    name: "Draco",
    stage: "graduated",
    createdAt: 100,
    funding: { stance: "rolling" },
  },
];

export function launchEvent(fixture: Fixture) {
  return {
    id: `event-${fixture.id}`,
    pubkey: FOUNDER,
    created_at: fixture.createdAt,
    kind: 37001,
    tags: [
      ["d", fixture.id],
      ["name", fixture.name],
      ["t", "dao-launchpad"],
      ["admission", "curated"],
    ],
    content: JSON.stringify({
      pitch: `${fixture.name} is going to the stars.`,
      stage: fixture.stage,
      ...(fixture.funding ? { funding: fixture.funding } : {}),
    }),
    sig: "sig",
  };
}

/** Serve these launches to the app over its relay WebSocket. */
export async function mockLaunchRelay(page: Page) {
  await page.routeWebSocket(PREVIEW_ORIGIN, (ws) => {
    ws.onMessage((message) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(message));
      } catch {
        return;
      }
      if (!Array.isArray(parsed)) return;
      if (parsed[0] === "EVENT") {
        const event = parsed[1] as { id: string };
        ws.send(JSON.stringify(["OK", event.id, true, ""]));
        return;
      }
      if (parsed[0] !== "REQ") return;
      const [, subId, filter] = parsed as [
        string,
        string,
        { kinds?: number[] },
      ];
      const kinds: number[] = filter.kinds ?? [];
      if (kinds.includes(37001)) {
        for (const fixture of FIXTURES) {
          ws.send(JSON.stringify(["EVENT", subId, launchEvent(fixture)]));
        }
      }
      ws.send(JSON.stringify(["EOSE", subId]));
    });
  });
}
