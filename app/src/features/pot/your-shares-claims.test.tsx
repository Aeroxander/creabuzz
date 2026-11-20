// "Money you can claim" on You: each project where this account may be owed money from a task, behind the gate, with the
// first ten and "Show more". A project appears when the account holds Shares there, took out from this browser, or the
// server's rows list it; a project with no queue, and a stranger, have none.
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { cleanup, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COORDINATE,
  NOW,
  projectEvent,
  recordV2,
  SERVER,
  serve,
  wrap,
} from "../../../tests/helpers/money-harness";
import { FOUNDER_EVM } from "../../../tests/helpers/numbers-v2-fixture";
import { CLAIMANT, STAYER } from "../../../tests/helpers/notes-scene";
import {
  chainIdentityV2,
  numbersV2Content,
  withTasks,
} from "../../../tests/helpers/numbers-v2-fixture";
import { installPotChain } from "../../../tests/helpers/pot-chain";
import {
  backerAnswers,
  nameTheNetwork,
  S,
  STRANGER_EVM,
} from "../../../tests/helpers/pot-harness";
import { sceneAnswers, sceneNumbers } from "../../../tests/helpers/plan-scene";
import { rememberStep } from "./own-history";
import YourSharesList from "./YourSharesList";

vi.mock(
  "../../lib/relay",
  async () => (await import("../../../tests/helpers/money-harness")).relayMock,
);
vi.mock("../../lib/account", () => ({
  useAccount: () => ({ pubkey: "b".repeat(64), locked: false }),
}));
vi.mock("@tanstack/react-router", async (actual) => ({
  ...(await actual<object>()),
  Link: ({ children }: { children: ReactNode }) => <a href="/p">{children}</a>,
}));

const [, FOUNDER, ID] = COORDINATE.split(":");
const numbers = sceneNumbers();

function setup(account: string, queue = true) {
  serve([
    projectEvent({
      author: FOUNDER,
      id: ID,
      name: "Lantern",
      chainKey: chainIdentityV2(COORDINATE).key,
    }),
    recordV2(
      numbersV2Content({
        coordinate: COORDINATE,
        now: NOW,
        patch: queue ? withTasks() : undefined,
      }),
      COORDINATE,
      NOW,
    ),
  ]);
  installPotChain({
    account,
    answers: {
      ...sceneAnswers(numbers),
      ...backerAnswers(numbers, { shares: 1_000n * S }),
    } as never,
  });
}

beforeEach(() => {
  applyServerSettings({ investing: true, self: SERVER });
  nameTheNetwork(numbers);
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  localStorage.clear();
  applyServerSettings(null);
});

describe("Money you can claim, on You", () => {
  it("shows a project where the account holds Shares and is owed money, under the project's name, with the press", async () => {
    setup(CLAIMANT);
    wrap(<YourSharesList />);
    const group = await screen.findByTestId("your-claims");
    expect(
      within(group).getByRole("heading", { name: "Money you can claim" }),
    ).toBeTruthy();
    const section = await within(group).findByTestId("notes-section");
    expect(
      within(section).getByRole("heading", { name: "Lantern" }),
    ).toBeTruthy();
    expect(await within(section).findByTestId("notes-claim")).toBeTruthy();
    // The group is a section of its own, named by its heading.
    expect(group.getAttribute("aria-labelledby")).toBe("your-claims-title");
  });

  it("shows a project where the account holds Shares, whatever the rows say, and tells it nothing is waiting when the network says so", async () => {
    setup(STAYER);
    wrap(<YourSharesList />);
    const section = await screen.findByTestId("notes-section");
    // The example's running task holds a claim for this account: it is still running, so there is no press yet.
    expect(
      (await within(section).findByTestId("notes-row")).textContent,
    ).toMatch(/still running/);
    expect(within(section).queryByTestId("notes-claim")).toBeNull();
  });

  it("shows the project to an account the record lists as a holder, though no row names it", async () => {
    setup(FOUNDER_EVM);
    wrap(<YourSharesList />);
    const group = await screen.findByTestId("your-claims");
    expect(await within(group).findByTestId("notes-none")).toBeTruthy();
  });

  it("shows nothing for an account that holds no Shares and has no step of its own here", async () => {
    setup(STRANGER_EVM);
    wrap(<YourSharesList />);
    await screen.findByTestId("your-shares-none");
    expect(screen.queryByTestId("your-claims")).toBeNull();
  });

  it("shows the project to an account that took out of it from this browser, though it holds no Shares now", async () => {
    setup(STRANGER_EVM);
    rememberStep(STRANGER_EVM, {
      kind: "take-out",
      project: numbers.key,
      at: NOW - 3_600,
      dollars: "1000000",
      shares: "1",
      txHash: `0x${"5".repeat(64)}`,
    });
    wrap(<YourSharesList />);
    const group = await screen.findByTestId("your-claims");
    expect(await within(group).findByTestId("notes-none")).toBeTruthy();
  });

  it("shows nothing about claims for a project whose record carries no queue", async () => {
    setup(CLAIMANT, false);
    wrap(<YourSharesList />);
    await screen.findByTestId("your-shares-held");
    expect(screen.queryByTestId("your-claims")).toBeNull();
  });
});
