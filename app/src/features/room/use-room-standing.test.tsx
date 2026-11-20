// The room's reading of the person (plan 4.2 and 4.7) against stand-ins for the network: what their wallets hold of the
// project's Shares (the most any one of them holds), their link, a take-out on this device, and the team's stop that follows a
// wallet. The rule itself is `room-standing.test.ts`; this is what is given to it.
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parsedExample } from "../../../tests/helpers/numbers-v2-parse";
import type { ProjectNumbers } from "../money/numbers";
import type { MoneyWallet } from "../money/wallet";
import { rememberStep } from "../pot/own-history";
import { parseProject } from "../project/project-record";
import type { TeamWallet } from "../team/use-wallets";
import {
  ANA,
  FOUNDER,
  KEY,
  MATE,
  NOW,
  reset,
  stored,
  world,
} from "./room-harness";
import { ROOM_MIN_SHARES } from "./room-standing";

vi.mock(
  "../../lib/relay",
  async () => (await import("./room-harness")).relayMock,
);
vi.mock(
  "../../lib/account",
  async () => (await import("./room-harness")).accountMock,
);

const numbers: ProjectNumbers = parsedExample();
const MINE = `0x${"11".repeat(20)}`;
const OTHER = `0x${"22".repeat(20)}`;
const pot = {
  wallet: { kind: "wallet", isAvailable: () => true } as unknown as MoneyWallet,
  address: MINE as string | null,
  onChain: true as boolean | undefined,
  read: async () => "0x",
};
const balances = new Map<string, bigint>();
let links: Record<string, TeamWallet> | undefined;

vi.mock("../pot/use-pot", () => ({
  usePotWallet: () => ({
    ...pot,
    read: async (to: string, data: string) => {
      // balanceOf(address): the holder is the last word of the call.
      const holder = `0x${data.slice(-40)}`.toLowerCase();
      const value = balances.get(`${to.toLowerCase()}:${holder}`) ?? 0n;
      return `0x${value.toString(16).padStart(64, "0")}`;
    },
  }),
}));
vi.mock("../team/use-wallets", () => ({
  useTeamWallets: () => ({ data: links, isError: false }),
}));

import { useRoomStanding } from "./use-room-standing";

const parsed = parseProject({
  id: "9".repeat(64),
  pubkey: FOUNDER,
  kind: 37001,
  created_at: NOW - 1000,
  content: "{}",
  tags: [
    ["d", "lantern"],
    ["name", "Lantern"],
    ["chain-key", KEY],
  ],
});
if (!parsed) throw new Error("no project");
const project = parsed;
const give = (token: string, holder: string, amount: bigint) =>
  balances.set(`${token.toLowerCase()}:${holder.toLowerCase()}`, amount);

function standing(team = [FOUNDER]) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(() => useRoomStanding(project, numbers, team), { wrapper });
}
const kind = (r: ReturnType<typeof standing>) => r.result.current.standing.kind;

beforeEach(() => {
  reset();
  balances.clear();
  localStorage.clear();
  pot.address = MINE;
  pot.onChain = true;
  links = {
    [world.me]: { state: "linked", address: MINE, expires: NOW + 300 * 86_400 },
  };
  applyServerSettings({ investing: true, self: "http://s.invalid" } as never);
});
afterEach(() => {
  cleanup();
  applyServerSettings(null);
});

describe("what the room reads about a person", () => {
  it("a wallet that holds the floor in Shares writes, and one wei less does not", async () => {
    give(numbers.contracts.shares, MINE, ROOM_MIN_SHARES);
    const yes = standing();
    await waitFor(() => expect(kind(yes)).toBe("write"));
    cleanup();
    give(numbers.contracts.shares, MINE, ROOM_MIN_SHARES - 1n);
    const no = standing();
    await waitFor(() => expect(kind(no)).toBe("not-holding"));
  });

  it("Team Shares count too", async () => {
    give(numbers.contracts.team, MINE, ROOM_MIN_SHARES);
    const r = standing();
    await waitFor(() => expect(kind(r)).toBe("write"));
  });

  it("reads the linked wallet even when the connected one holds nothing, and the most either holds", async () => {
    pot.address = OTHER;
    links = {
      [world.me]: {
        state: "linked",
        address: MINE,
        expires: NOW + 300 * 86_400,
      },
    };
    give(numbers.contracts.shares, MINE, ROOM_MIN_SHARES);
    const r = standing();
    await waitFor(() => expect(kind(r)).toBe("write"));
  });

  it("cannot say when the wallet is on another network, and says so as not holding", async () => {
    give(numbers.contracts.shares, MINE, ROOM_MIN_SHARES);
    pot.onChain = false;
    const r = standing();
    await waitFor(() => expect(kind(r)).toBe("not-holding"));
  });

  it("a person who took out within the unit writes for the rest of it, and not after", async () => {
    const step = (at: number) =>
      rememberStep(MINE, {
        kind: "take-out",
        project: numbers.key,
        at,
        dollars: "5",
        shares: "5",
        txHash: `0x${at}`,
      });
    const now = Math.floor(Date.now() / 1000);
    step(now - numbers.unit + 3600);
    const inside = standing();
    await waitFor(() => expect(kind(inside)).toBe("write"));
    expect(
      (inside.result.current.standing as { graceEndsAt: number }).graceEndsAt,
    ).toBeGreaterThan(now);
    cleanup();
    localStorage.clear();
    step(now - numbers.unit - 3600);
    const outside = standing();
    await waitFor(() => expect(kind(outside)).toBe("not-holding"));
  });

  it("waits for the link before saying anything, and asks to confirm the account when it is missing", async () => {
    give(numbers.contracts.shares, MINE, ROOM_MIN_SHARES);
    links = undefined;
    const waiting = standing();
    expect(kind(waiting)).toBe("checking");
    cleanup();
    links = { [world.me]: { state: "none" } };
    const none = standing();
    await waitFor(() => expect(kind(none)).toBe("needs-link"));
  });

  it("is stopped by the team's record for the account, or for a wallet it uses, and not by anyone else's record", async () => {
    give(numbers.contracts.shares, MINE, ROOM_MIN_SHARES);
    const until = NOW + 10 * 86_400;
    const stop = (by: string, person: string, wallets: string[]) =>
      stored(
        by,
        47003,
        [
          ["a", project.coordinate],
          ["room-mute", person],
          ...wallets.map((w) => ["room-mute-wallet", w]),
          ["expiration", String(until)],
        ],
        "{}",
        NOW - 10,
      );
    stop(ANA, world.me, []);
    const stranger = standing();
    await waitFor(() => expect(kind(stranger)).toBe("write"));
    cleanup();
    stop(FOUNDER, ANA, [MINE]);
    const byWallet = standing();
    await waitFor(() => expect(kind(byWallet)).toBe("muted"));
    expect(byWallet.result.current.standing).toMatchObject({ until });
    cleanup();
    reset();
    stop(MATE, world.me, []);
    const byAccount = standing([FOUNDER, MATE]);
    await waitFor(() => expect(kind(byAccount)).toBe("muted"));
  });

  it("says rooms are off for a phone account on a server that cannot check its link", async () => {
    give(numbers.contracts.shares, MINE, ROOM_MIN_SHARES);
    (pot.wallet as unknown as { kind: string }).kind = "passkey";
    applyServerSettings({
      investing: true,
      self: "http://s.invalid",
      smartAccountLinks: false,
    } as never);
    const r = standing();
    await waitFor(() => expect(kind(r)).toBe("phone-unsupported"));
    (pot.wallet as unknown as { kind: string }).kind = "wallet";
  });
});
