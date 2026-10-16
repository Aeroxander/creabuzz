/**
 * What the pages of one test have published to the mocked server, handed back to every page that asks.
 *
 * The launchpad specs mock the server one page at a time, so a claim's evidence update (which the contributor's page
 * publishes and a reviewer's page must read before it offers Approve) would never reach the reviewer. Each page's mock
 * calls `remember` on an EVENT and `serve` on a REQ, and the pages of one test share one store.
 */

import type { WebSocketRoute } from "@playwright/test";

interface Published {
  id: string;
  kind: number;
}

/** Only the events a launch is built from are kept: nothing else in these specs is read back. */
const KEPT_KINDS = new Set([47003]);

export function publishedEvents() {
  let events: Published[] = [];
  let withheld = false;
  return {
    /** A new test starts with nothing published. */
    clear() {
      events = [];
      withheld = false;
    },
    /** While on, pages are told nothing was published: a reviewer who cannot read the evidence. */
    withhold(on: boolean) {
      withheld = on;
    },
    /** Keep what a page published, once. */
    remember(event: Published) {
      if (!KEPT_KINDS.has(event.kind)) return;
      if (events.some((known) => known.id === event.id)) return;
      events.push(event);
    },
    /** Send a page every kept event its REQ asks for. */
    serve(ws: WebSocketRoute, subId: string, kinds: number[] | undefined) {
      if (withheld) return;
      for (const event of events) {
        if (kinds?.includes(event.kind)) {
          ws.send(JSON.stringify(["EVENT", subId, event]));
        }
      }
    },
  };
}
