import type { RelayEvent } from "@/shared/api/types";
import { KIND_DELETION } from "@/shared/constants/kinds";

export type OrgDeletionEventTemplate = {
  kind: number;
  content: string;
  createdAt: number;
  tags: string[][];
};

type OrgDeletionFetchEvents = (filter: {
  kinds: number[];
  "#d": string[];
  limit: number;
}) => Promise<RelayEvent[]>;

export type OrgDeletionDeps = {
  fetchEvents: OrgDeletionFetchEvents;
  nowSeconds: () => number;
  publishEvent: (
    event: RelayEvent,
    timeoutMessage: string,
    failureMessage: string,
  ) => Promise<unknown>;
  signEvent: (input: OrgDeletionEventTemplate) => Promise<RelayEvent>;
};

export type OrgDeletionTarget = {
  /** Addressable event kind being deleted (e.g. 37010 node, 37012 budget). */
  kind: number;
  /** The live coordinate's `d` tag. */
  dtag: string;
  /** Human label used in tombstone content and errors, e.g. "org node". */
  label: string;
  timeoutMessage: string;
  failureMessage: string;
};

/**
 * Delete every live coordinate `(kind, author, d)` behind one `d` tag,
 * modeled on the project-deletion flow: fetch the live heads first, tombstone
 * each head's exact coordinate with an `a` tag and a `created_at` bumped past
 * that head, then re-check that the coordinate is really gone so a concurrent
 * replacement surfaces as a visible error instead of silent zombie data.
 */
export async function deleteAddressableEvents(
  target: OrgDeletionTarget,
  deps: OrgDeletionDeps,
): Promise<void> {
  const { fetchEvents, nowSeconds, publishEvent, signEvent } = deps;

  const filter = {
    kinds: [target.kind],
    "#d": [target.dtag],
    limit: 500,
  };
  const heads = await fetchEvents(filter);
  if (heads.length === 0) {
    throw new Error(
      `Could not find this ${target.label} on the relay. Refresh and try again.`,
    );
  }

  // One author can hold at most one live event per NIP-33 coordinate; take
  // the newest head per author and tombstone each author's coordinate.
  const headByAuthor = new Map<string, RelayEvent>();
  for (const head of heads) {
    const existing = headByAuthor.get(head.pubkey);
    if (!existing || existing.created_at < head.created_at) {
      headByAuthor.set(head.pubkey, head);
    }
  }

  for (const [author, head] of headByAuthor) {
    const template: OrgDeletionEventTemplate = {
      kind: KIND_DELETION,
      content: `Delete ${target.label} ${target.dtag}`,
      createdAt: Math.max(nowSeconds(), head.created_at + 1),
      tags: [["a", `${target.kind}:${author}:${target.dtag}`]],
    };
    const event = await signEvent(template);
    await publishEvent(event, target.timeoutMessage, target.failureMessage);
  }

  const remaining = await fetchEvents(filter);
  const survivingAuthors = new Set(remaining.map((e) => e.pubkey));
  for (const author of headByAuthor.keys()) {
    if (survivingAuthors.has(author)) {
      throw new Error(
        `This ${target.label} was updated while it was being deleted. Refresh and try again.`,
      );
    }
  }
}
