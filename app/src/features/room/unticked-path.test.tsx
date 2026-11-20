// A holder who left the Back box unticked (so the account was never linked to the wallet) meets, where the writing box would be,
// the sentence that says what the link makes public and one press that makes it; the press works for a wallet that already
// holds Shares, and the writing box opens as soon as it has. The room's reading of the person is the real one (`useRoomStanding`);
// only the network's balances and the link's signature are stand-ins.
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import { useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parsedExample } from "../../../tests/helpers/numbers-v2-parse";
import type { MoneyWallet } from "../money/wallet";
import { parseProject } from "../project/project-record";
import type { TeamWallet } from "../team/use-wallets";
import { draw, FOUNDER, KEY, NOW, reset, world } from "./room-harness";
import { ROOM_MIN_SHARES } from "./room-standing";

vi.mock(
  "../../lib/relay",
  async () => (await import("./room-harness")).relayMock,
);
vi.mock(
  "../../lib/account",
  async () => (await import("./room-harness")).accountMock,
);
vi.mock("../tasks/use-tasks", () => ({
  useProjectTasks: () => ({ data: { tasks: [] } }),
}));
vi.mock("../../lib/mutes", () => ({
  useMutes: () => ({
    muted: new Set<string>(),
    ready: true,
    readable: true,
    pending: false,
    hide: async () => undefined,
    showAgain: async () => undefined,
  }),
}));
vi.mock("@tanstack/react-router", async (actual) => ({
  ...(await actual<object>()),
  Link: ({ children }: { children: ReactNode }) => <a href="/u">{children}</a>,
  useNavigate: () => () => undefined,
  useRouterState: () => "/p",
}));

const MINE = `0x${"11".repeat(20)}`;
const numbers = parsedExample();
const wallet = {
  kind: "wallet",
  isAvailable: () => true,
} as unknown as MoneyWallet;

/** What the server says about the account's link, shared by the room's reading and the press. */
let link: TeamWallet = { state: "none" };
const listeners = new Set<() => void>();
const setLink = (next: TeamWallet) => {
  link = next;
  for (const listener of listeners) listener();
};
const useLinkState = () =>
  useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => link,
  );
/** How many times the press asked the wallet to link. */
let pressed = 0;

vi.mock("../pot/use-pot", () => ({
  usePotWallet: () => ({
    wallet,
    address: MINE,
    onChain: true,
    // balanceOf(holder): the wallet holds exactly the floor of Shares already (it Backed), whatever the link says.
    read: async () => `0x${ROOM_MIN_SHARES.toString(16).padStart(64, "0")}`,
  }),
}));
vi.mock("../team/use-wallets", () => ({
  useTeamWallets: () => {
    const state = useLinkState();
    return { data: { [world.me]: state }, isError: false };
  },
  useLinkWallet: () => ({
    isPending: false,
    mutate: (_: undefined, options?: { onSuccess?: () => void }) => {
      pressed += 1;
      // The wallet signs the link, the server accepts it, and the account is linked to the wallet that holds the Shares.
      act(() =>
        setLink({
          state: "linked",
          address: MINE,
          expires: NOW + 300 * 86_400,
        } as TeamWallet),
      );
      options?.onSuccess?.();
    },
  }),
}));

import { RoomTab } from "./RoomTab";

const parsed = parseProject({
  id: "9".repeat(64),
  pubkey: FOUNDER,
  kind: 37001,
  created_at: NOW - 1000,
  content: '{"pitch":"Lamps"}',
  tags: [
    ["d", "lantern"],
    ["name", "Lantern"],
    ["chain-key", KEY],
  ],
});
if (!parsed) throw new Error("no project");

beforeEach(() => {
  reset();
  sessionStorage.clear();
  localStorage.clear();
  link = { state: "none" };
  pressed = 0;
  applyServerSettings({ investing: true, self: "http://s.invalid" } as never);
});
afterEach(() => {
  cleanup();
  applyServerSettings(null);
});

describe("a holder who did not tick the box when they Backed", () => {
  it("is offered the link as one press where the writing box would be, with the sentence that says it is public, and the press opens the box", async () => {
    draw(
      <RoomTab
        numbers={numbers}
        profiles={{}}
        project={parsed}
        team={[FOUNDER]}
      />,
    );
    const needs = await screen.findByTestId("room-needs-link");
    // The room is the real one: no writing box, and the link's own sentence beside the press.
    expect(screen.queryByTestId("room-composer")).toBeNull();
    expect(needs.textContent).toContain(
      "This links your wallet to your account. Anyone on this server can see the link, and so can see how many Shares that wallet holds.",
    );
    const press = screen.getByRole("button", {
      name: "Confirm this account backs the project",
    });
    expect(press.getAttribute("aria-describedby")).toMatch(/-public/);
    fireEvent.click(press);
    await waitFor(() => expect(pressed).toBe(1));
    expect(
      await screen.findByLabelText("Write to the people who back this"),
    ).toBeTruthy();
    expect(screen.queryByTestId("room-needs-link")).toBeNull();
  });
});
