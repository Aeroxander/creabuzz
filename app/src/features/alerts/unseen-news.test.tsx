// The dot on You counts the news the person has not read, in addition to the notifications, from a bounded set only: the
// projects this device knows they took part in, the newest record of each, never the three-page scan of holders and never on
// a timer. Zero with no wallet, and a record the server did not sign counts nothing.
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DAY,
  NOW,
  projectEvent,
  recordV2,
  relayMock,
  SERVER,
  serve,
  COORDINATE,
} from "../../../tests/helpers/money-harness";
import {
  BACKER_EVM,
  chainIdentityV2,
  numbersV2Content,
  withTasks,
} from "../../../tests/helpers/numbers-v2-fixture";
import { installPotChain } from "../../../tests/helpers/pot-chain";
import {
  backerAnswers,
  nameTheNetwork,
  STRANGER_EVM,
} from "../../../tests/helpers/pot-harness";
import { sceneNumbers } from "../../../tests/helpers/plan-scene";
import { rememberStep } from "../pot/own-history";
import { useUnseenCount } from "../notifications/use-notifications";
import { alertsOf } from "./alerts";
import { markSeen, rememberHeld } from "./seen";

const PUBKEY = "b".repeat(64);
const [, FOUNDER, ID] = COORDINATE.split(":");
const numbers = sceneNumbers();

vi.mock(
  "../../lib/relay",
  async () => (await import("../../../tests/helpers/money-harness")).relayMock,
);
vi.mock("../../lib/account", () => ({
  useAccount: () => ({ pubkey: "b".repeat(64), locked: false }),
}));

function Dot() {
  return <span data-testid="dot">{useUnseenCount()}</span>;
}

function show() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <Dot />
    </QueryClientProvider>,
  );
}

function setup(account: string, signer = SERVER) {
  serve([
    projectEvent({
      author: FOUNDER as string,
      id: ID as string,
      name: "Lantern",
      chainKey: chainIdentityV2(COORDINATE).key,
    }),
    {
      ...recordV2(
        numbersV2Content({
          coordinate: COORDINATE,
          now: NOW,
          patch: withTasks(),
        }),
        COORDINATE,
        NOW,
      ),
      pubkey: signer,
    },
  ]);
  return installPotChain({ account, answers: backerAnswers(numbers) as never });
}

/** The news the example gives an account the record lists (what the dot should count while none of it is read). */
const NEWS = alertsOf({
  numbers: [numbers],
  names: new Map(),
  me: [BACKER_EVM],
  held: () => true,
  tasksOf: () => undefined,
  now: numbers.asOf.time,
});

/** That this device knows the person took part in the project: a Back of their own. */
function tookPart(account: string) {
  rememberStep(account, {
    kind: "back",
    project: numbers.key,
    at: NOW - DAY,
    dollars: "1000000",
    shares: "1",
    txHash: `0x${"7".repeat(64)}`,
  });
}

beforeEach(() => {
  applyServerSettings({ investing: true, self: SERVER });
  nameTheNetwork(numbers);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  localStorage.clear();
  applyServerSettings(null);
});

const count = () => Number(screen.getByTestId("dot").textContent);

describe("the dot on You counts unread news from a bounded set", () => {
  it("counts the news about a project this device knows the person took part in, until it is read", async () => {
    setup(BACKER_EVM);
    tookPart(BACKER_EVM);
    expect(NEWS.length).toBeGreaterThan(2);
    show();
    await waitFor(() => expect(count()).toBe(NEWS.length));
  });

  it("falls when the news is marked read", async () => {
    setup(BACKER_EVM);
    tookPart(BACKER_EVM);
    show();
    await waitFor(() => expect(count()).toBe(NEWS.length));
    const [, ...rest] = NEWS;
    markSeen(
      PUBKEY,
      rest.map((a) => a.id),
      new Set(),
      Math.floor(Date.now() / 1000),
    );
    await waitFor(() => expect(count()).toBe(1));
  });

  it("knows a project from what was last found held, without any history of the person's own steps", async () => {
    setup(BACKER_EVM);
    rememberHeld(
      PUBKEY,
      BACKER_EVM,
      numbers.key,
      true,
      Math.floor(Date.now() / 1000),
    );
    show();
    await waitFor(() => expect(count()).toBe(NEWS.length));
  });

  it("reads only the records of the projects it knows, by key: no scan of the server's recent records, and no timer", async () => {
    setup(BACKER_EVM);
    tookPart(BACKER_EVM);
    const reads = vi.spyOn(relayMock, "read");
    show();
    await waitFor(() => expect(count()).toBe(NEWS.length));
    const recordReads = reads.mock.calls
      .map(
        ([filter]) =>
          filter as { kinds?: number[]; "#d"?: string[]; limit?: number },
      )
      .filter((f) => f.kinds?.includes(39009));
    expect(recordReads.length).toBeGreaterThan(0);
    for (const filter of recordReads) {
      expect(filter["#d"]).toEqual([numbers.key]);
      expect(filter.limit).toBeLessThan(100);
    }
  });

  it("knows no project, so reads no record and counts nothing, for a person this device has no history of", async () => {
    setup(BACKER_EVM);
    const reads = vi.spyOn(relayMock, "read");
    show();
    await new Promise((r) => setTimeout(r, 150));
    expect(count()).toBe(0);
    expect(
      reads.mock.calls.some(([f]) =>
        (f as { kinds?: number[] }).kinds?.includes(39009),
      ),
    ).toBe(false);
  });

  it("counts nothing for an account the record does not list and whose holders list is whole", async () => {
    setup(STRANGER_EVM);
    tookPart(STRANGER_EVM);
    show();
    await new Promise((r) => setTimeout(r, 150));
    expect(count()).toBe(0);
  });

  it("counts nothing for a record the server did not sign", async () => {
    setup(BACKER_EVM, "9".repeat(64));
    tookPart(BACKER_EVM);
    show();
    await new Promise((r) => setTimeout(r, 150));
    expect(count()).toBe(0);
  });

  it("counts nothing with no wallet shown", async () => {
    setup(BACKER_EVM);
    tookPart(BACKER_EVM);
    (window as unknown as { ethereum?: unknown }).ethereum = undefined;
    show();
    await new Promise((r) => setTimeout(r, 150));
    expect(count()).toBe(0);
  });

  it("with storage that cannot be used shows everything as unread, never hidden", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    setup(BACKER_EVM);
    tookPart(BACKER_EVM);
    show();
    await waitFor(() => expect(count()).toBe(NEWS.length));
  });
});
