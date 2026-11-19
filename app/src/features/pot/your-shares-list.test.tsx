// Your Shares on You: the projects whose record lists this account, what it holds and what taking out gives now (read from the
// chain), the account's own history, and an honest "none" only when the lists are whole.
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { cleanup, screen } from "@testing-library/react";
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
import {
  chainIdentityV2,
  numbersV2Content,
} from "../../../tests/helpers/numbers-v2-fixture";
import { installPotChain } from "../../../tests/helpers/pot-chain";
import {
  BACKER_EVM,
  backerAnswers,
  nameTheNetwork,
  numbersFor,
  S,
  STRANGER_EVM,
} from "../../../tests/helpers/pot-harness";
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
const numbers = numbersFor();

function setup(
  account: string,
  patch?: (content: Record<string, unknown>) => void,
) {
  serve([
    projectEvent({
      author: FOUNDER,
      id: ID,
      name: "Lantern",
      chainKey: chainIdentityV2(COORDINATE).key,
    }),
    recordV2(
      numbersV2Content({ coordinate: COORDINATE, now: NOW, patch }),
      COORDINATE,
      NOW,
    ),
  ]);
  installPotChain({
    account,
    answers: backerAnswers(numbers, { shares: 1_000n * S }) as never,
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

describe("Your Shares across projects", () => {
  it("lists a project whose record names the account, with what it holds and what taking out gives, from the chain", async () => {
    setup(BACKER_EVM);
    wrap(<YourSharesList />);
    expect((await screen.findByTestId("your-shares-held")).textContent).toBe(
      "1,000 Shares",
    );
    expect(screen.getByTestId("your-shares-cash").textContent).toBe(
      "9.80 dollars",
    );
    expect(screen.getByText("Lantern")).not.toBeNull();
    expect(screen.getByText(/play money, not real money/)).not.toBeNull();
    expect(
      screen.getByText(/This can go up or down. It is not a return./),
    ).not.toBeNull();
  });

  it("an account the record does not list, with whole lists, is told it holds none", async () => {
    setup(STRANGER_EVM);
    wrap(<YourSharesList />);
    expect((await screen.findByTestId("your-shares-none")).textContent).toMatch(
      /hold no Shares in the projects this server lists/,
    );
  });

  it("a record whose holders list was cut never says none", async () => {
    setup(STRANGER_EVM, (c) => {
      c.truncated = true;
    });
    wrap(<YourSharesList />);
    expect((await screen.findByTestId("your-shares-none")).textContent).toMatch(
      /Open a project's Money tab/,
    );
  });

  it("shows this account's own steps from this browser, naming the project", async () => {
    setup(BACKER_EVM);
    rememberStep(BACKER_EVM, {
      kind: "back",
      project: numbers.key,
      at: NOW - 3600,
      dollars: "10000000",
      shares: String(1_000n * S),
      txHash: `0x${"1".repeat(64)}`,
    });
    wrap(<YourSharesList />);
    const history = await screen.findByTestId("your-history");
    expect(history.textContent).toMatch(
      /backed Lantern with 10 dollars and got about 1,000 Shares/,
    );
    expect(history.textContent).toMatch(/Kept in this browser/);
  });

  it("with no account shown by the wallet it shows nothing", () => {
    (window as unknown as { ethereum?: unknown }).ethereum = undefined;
    setup(BACKER_EVM);
    (window as unknown as { ethereum?: unknown }).ethereum = undefined;
    wrap(<YourSharesList />);
    expect(screen.queryByTestId("your-shares-list")).toBeNull();
  });
});
