import { createMockRelay, type MockRelayOptions } from "./mock-relay";

/**
 * A mock server that also keeps the membership record (kind 39002) the real server writes for a board: whoever makes a
 * board runs it. The mock only derives a board's metadata from its creation, so without this a board made during a test
 * would have no owner, and a project could not be shown to own it.
 */

const SERVER = "b".repeat(64);
let counter = 0;

/** The membership record of a board, listing `owner` as the person who runs it. */
export function ownerRecord(boardId: string, owner: string, at = 100) {
  return {
    id: `0w${(++counter).toString(16)}`.padEnd(64, "0"),
    pubkey: SERVER,
    created_at: at,
    kind: 39002,
    tags: [
      ["d", boardId],
      ["p", owner, "", "owner"],
    ],
    content: "",
    sig: "sig",
  };
}

type Relay = ReturnType<typeof createMockRelay>;

export function createOwningRelay(options: MockRelayOptions = {}): Relay {
  const { refuse, ...rest } = options;
  let relay: Relay | null = null;
  relay = createMockRelay({
    ...rest,
    deriveChannels: true,
    refuse: (event) => {
      const reason = refuse?.(event) ?? null;
      if (!reason && event.kind === 9007) {
        const board = event.tags.find((tag) => tag[0] === "h")?.[1];
        if (board)
          relay?.seed(ownerRecord(board, event.pubkey, event.created_at));
      }
      return reason;
    },
  });
  return relay;
}
