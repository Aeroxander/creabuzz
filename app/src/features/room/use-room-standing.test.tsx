// The room's reading of the person (plan 4.2 and 4.7) against stand-ins for the network: what their wallets hold of the
// project's Shares (the most any one of them holds), their link, a take-out on this device, and the team's stop that follows a
// wallet. The rule itself is `room-standing.test.ts`; this is what is given to it.
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parsedExample } from "../../../tests/helpers/numbers-v2-parse";
import { encodeCall } from "@creaton/core/pot/abi-codec.ts";
import { TREASURY_ABI } from "@creaton/core/pot/abis.generated.ts";
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
/** The same project, with a pause the record names (Shares parked there are still their owner's). */
const PAUSE_AT = `0x${"61".repeat(20)}`;
const withPause: ProjectNumbers = {
  ...numbers,
  contracts: { ...numbers.contracts, pause: PAUSE_AT },
};
const PAUSE_GATE = encodeCall(TREASURY_ABI, "pauseGate", []);
const MINE = `0x${"11".repeat(20)}`;
const OTHER = `0x${"22".repeat(20)}`;
const pot = {
  wallet: { kind: "wallet", isAvailable: () => true } as unknown as MoneyWallet,
  address: MINE as string | null,
  onChain: true as boolean | undefined,
  read: async () => "0x",
};
const balances = new Map<string, bigint>();
const refuse = { read: false };
let links: Record<string, TeamWallet> | undefined;

vi.mock("../pot/use-pot", () => ({
  usePotWallet: () => ({
    ...pot,
    read: async (to: string, data: string) => {
      if (refuse.read) throw new Error("the node refused the read");
      if (data === PAUSE_GATE)
        return `0x${PAUSE_AT.slice(2).padStart(64, "0")}`;
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

function standing(team = [FOUNDER], record: ProjectNumbers = numbers) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(() => useRoomStanding(project, record, team), { wrapper });
}
const kind = (r: ReturnType<typeof standing>) => r.result.current.standing.kind;

beforeEach(() => {
  reset();
  balances.clear();
  refuse.read = false;
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

describe("Shares parked in the project's pause", () => {
  it("are still held: a person who parked all of theirs still writes in the room", async () => {
    give(numbers.contracts.shares, MINE, 0n);
    give(PAUSE_AT, MINE, ROOM_MIN_SHARES);
    const parked = standing([FOUNDER], withPause);
    await waitFor(() => expect(kind(parked)).toBe("write"));
    cleanup();
    // the wallet's part and the parked part are added, and one wei short of the floor in all is not enough
    give(numbers.contracts.shares, MINE, ROOM_MIN_SHARES / 2n);
    give(PAUSE_AT, MINE, ROOM_MIN_SHARES / 2n - 1n);
    const short = standing([FOUNDER], withPause);
    await waitFor(() => expect(kind(short)).toBe("not-holding"));
  });

  it("a record that says the project has no pause asks nothing about one", async () => {
    give(numbers.contracts.shares, MINE, 0n);
    give(PAUSE_AT, MINE, ROOM_MIN_SHARES);
    const none = standing();
    await waitFor(() => expect(kind(none)).toBe("not-holding"));
  });

  it("a pause that cannot be read is 'could not check', never 'does not hold'", async () => {
    give(numbers.contracts.shares, MINE, 0n);
    refuse.read = true;
    const failed = standing([FOUNDER], withPause);
    await waitFor(() => expect(kind(failed)).not.toBe("not-holding"));
  });
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

  it("reads the linked wallet even when the connected one holds nothing", async () => {
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

  it("cannot say when the wallet is on another network, and says so (never as not holding)", async () => {
    give(numbers.contracts.shares, MINE, ROOM_MIN_SHARES);
    pot.onChain = false;
    const r = standing();
    await waitFor(() => expect(kind(r)).toBe("could-not-check"));
  });

  it("a balance read that fails says it could not check, never 'not holding', and the retry reads again", async () => {
    give(numbers.contracts.shares, MINE, ROOM_MIN_SHARES * 5n);
    refuse.read = true;
    const r = standing();
    await waitFor(() => expect(kind(r)).toBe("could-not-check"));
    refuse.read = false;
    r.result.current.retry();
    await waitFor(() => expect(kind(r)).toBe("write"));
  });

  it("does not count a wallet the account is not linked to: Shares in the connected wallet only offer the confirm press", async () => {
    pot.address = OTHER;
    links = {
      [world.me]: {
        state: "linked",
        address: MINE,
        expires: NOW + 300 * 86_400,
      },
    };
    give(numbers.contracts.shares, OTHER, ROOM_MIN_SHARES);
    const r = standing();
    await waitFor(() => expect(kind(r)).toBe("needs-link"));
  });

  it("the most either wallet holds no longer counts: the linked wallet alone decides when it holds", async () => {
    pot.address = OTHER;
    give(numbers.contracts.shares, MINE, ROOM_MIN_SHARES - 1n);
    give(numbers.contracts.shares, OTHER, 0n);
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
