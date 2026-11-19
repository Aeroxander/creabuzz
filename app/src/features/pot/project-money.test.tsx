// The Money tab in each state a person can meet it in: fresh, older than three refresh periods, stale, with the door shut,
// quiet, dormant, open to wind down, wound down, with a record that cannot be read or does not exist yet, and for a person
// who holds nothing. Taking out is reachable in every one of them; the play-money line and the legal line are on all.
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SERVER, wrap } from "../../../tests/helpers/money-harness";
import {
  installPotChain,
  type PotChain,
} from "../../../tests/helpers/pot-chain";
import {
  BACKER_EVM,
  backerAnswers,
  nameTheNetwork,
  numbersFor,
  S,
} from "../../../tests/helpers/pot-harness";
import type { ProjectNumbers } from "../money/numbers";
import { ProjectMoney } from "./ProjectMoney";

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

const numbers = numbersFor();
const LEGAL =
  "Buyers acquire ownership only: governance and exit. No dividends or revenue share, ever, unless they contribute and earn one.";
let chain: PotChain;

function setup(
  held: { shares?: bigint } = {},
  extra: Record<string, unknown> = {},
) {
  chain = installPotChain({
    account: BACKER_EVM,
    answers: { ...backerAnswers(numbers, held), ...extra } as never,
  });
}

/** The same project's numbers, as the server built them 100 seconds before `now` (so they are fresh at `now`). */
function builtAt(now: number): ProjectNumbers {
  return {
    ...numbers,
    builtAt: now - 100,
    asOf: { ...numbers.asOf, time: now - 100 },
  };
}

function show(
  n: ProjectNumbers | null | undefined,
  options: {
    now?: number;
    error?: unknown;
    chainKey?: string | null;
    loading?: boolean;
  } = {},
) {
  return wrap(
    <ProjectMoney
      chainKey={options.chainKey ?? numbers.key}
      error={options.error}
      loading={options.loading ?? false}
      members={[]}
      nameOf={(a) => a}
      now={options.now ?? numbers.builtAt + 100}
      numbers={n}
      onRetry={() => undefined}
      projectName="Lantern"
    />,
  );
}

beforeEach(() => {
  applyServerSettings({ investing: true, self: SERVER });
  nameTheNetwork(numbers);
  setup({ shares: 1_000n * S });
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  localStorage.clear();
  applyServerSettings(null);
});

describe("the project's money", () => {
  it("says what the project holds, what one Share gives, the allowance, the Team's part and where it stands, in plain words", async () => {
    show(numbers);
    expect((await screen.findByTestId("money-pot")).textContent).toBe(
      "7,322.81",
    );
    expect(screen.getByTestId("money-share-value").textContent).toBe(
      "0.010058",
    );
    expect(screen.getByTestId("play-money").textContent).toMatch(
      /play money, not real money/,
    );
    expect(screen.getByTestId("money-allowance").textContent).toMatch(
      /up to 0\.10% of the project's money a day/,
    );
    expect(screen.getByTestId("money-team-part").textContent).toMatch(
      /team's side gets \d+% of anything above/,
    );
    expect(screen.getByTestId("money-state").textContent).toBe("Open");
    expect(screen.getByTestId("ownership").textContent).toBe(LEGAL);
    expect(
      screen.getAllByText(/This can go up or down. It is not a return./).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByTestId("money-as-of")).toBeNull();
  });

  it("says 'Numbers as of' when the record is older than three refresh periods", async () => {
    show(numbers, { now: numbers.builtAt + 4 * 3600 });
    expect((await screen.findByTestId("money-as-of")).textContent).toMatch(
      /^Numbers as of /,
    );
    expect(screen.getByTestId("money-pot")).not.toBeNull();
  });

  it("a stale record shows no figures, pauses backing, and leaves taking out open", async () => {
    show(numbers, { now: numbers.builtAt + 2 * 86_400 });
    const stale = await screen.findByTestId("money-stale");
    expect(stale.textContent).toMatch(/you can take it out any time/);
    expect(screen.queryByTestId("money-pot")).toBeNull();
    expect(screen.getByTestId("back-paused").textContent).toMatch(
      /Taking your money out does not wait/,
    );
    expect(screen.queryByTestId("backing-box")).toBeNull();
    expect(await screen.findByTestId("holding-take-out")).not.toBeNull();
  });

  it("a person with zero Shares sees none, no Take out, and the Back box", async () => {
    setup({ shares: 0n });
    show(numbers);
    expect((await screen.findByTestId("holding-none")).textContent).toMatch(
      /hold no Shares/,
    );
    expect(screen.queryByTestId("holding-take-out")).toBeNull();
    expect(screen.getByTestId("backing-box")).not.toBeNull();
  });
});

describe("where the project stands, and Take out in each", () => {
  it("quiet: says what stopped, shuts the Back box with the reason, and Take out is there", async () => {
    const now = (numbers.quiet.quietFrom ?? 0) + 60;
    show(builtAt(now), { now });
    expect((await screen.findByTestId("money-state")).textContent).toBe(
      "Quiet",
    );
    expect(screen.getByTestId("money-state-words").textContent).toMatch(
      /New backing and the allowance are stopped/,
    );
    expect(screen.getByTestId("back-door-shut").textContent).toMatch(
      /has not checked in since/,
    );
    expect(await screen.findByTestId("holding-take-out")).not.toBeNull();
  });

  it("dormant and open to wind down are named, and Take out is there", async () => {
    const dormant = (numbers.quiet.dormantFrom ?? 0) + 60;
    show(builtAt(dormant), { now: dormant });
    expect((await screen.findByTestId("money-state")).textContent).toBe(
      "Dormant",
    );
    cleanup();
    const windable = (numbers.quiet.windableFrom ?? 0) + 60;
    show(builtAt(windable), { now: windable });
    expect((await screen.findByTestId("money-state")).textContent).toBe(
      "Can be wound down",
    );
    expect(screen.getByTestId("money-state-words").textContent).toMatch(
      /anyone can now wind the project down/,
    );
    expect(await screen.findByTestId("holding-take-out")).not.toBeNull();
  });

  it("wound down: says it is for good, no backing, Take out stays", async () => {
    const wound: ProjectNumbers = {
      ...numbers,
      windDown: { kind: 1, at: numbers.builtAt - 10 },
      door: { switchOn: true, openNow: false, shutsAt: null },
    };
    show(wound);
    expect((await screen.findByTestId("money-state")).textContent).toBe(
      "Wound down",
    );
    expect(screen.getByTestId("money-state-words").textContent).toMatch(
      /take yours out/,
    );
    expect(screen.getByTestId("back-door-shut").textContent).toMatch(
      /wound down/,
    );
    expect(await screen.findByTestId("holding-take-out")).not.toBeNull();
  });

  it("the founder closed the door: Back says so, Take out stays", async () => {
    const shut: ProjectNumbers = {
      ...numbers,
      door: { ...numbers.door, switchOn: false, openNow: false },
    };
    show(shut);
    expect((await screen.findByTestId("back-door-shut")).textContent).toMatch(
      /closed the door/,
    );
    expect(await screen.findByTestId("holding-take-out")).not.toBeNull();
  });
});

describe("when the record cannot be used", () => {
  it("a record that cannot be read says so with a way to try again, and Shares are still reached through the Launcher", async () => {
    setup(
      { shares: 1_000n * S },
      {
        projectByKey: [
          [
            numbers.founder,
            numbers.contracts.shares,
            numbers.contracts.team,
            numbers.contracts.treasury,
            numbers.contracts.vester,
            1_700_000_000n,
          ],
        ],
      },
    );
    show(null, { error: new Error("The server did not answer.") });
    expect(
      await screen.findByText("The numbers could not be read"),
    ).not.toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).not.toBeNull();
    fireEvent.click(await screen.findByTestId("holding-take-out"));
    expect((await screen.findByTestId("takeout-cash")).textContent).toBe(
      "9.80 dollars",
    );
    // The legal line is on the page and on the sheet, word for word.
    for (const line of screen.getAllByTestId("ownership"))
      expect(line.textContent).toBe(LEGAL);
  });

  it("no record yet: says so, and still finds the person's Shares", async () => {
    setup(
      { shares: 1_000n * S },
      {
        projectByKey: [
          [
            numbers.founder,
            numbers.contracts.shares,
            numbers.contracts.team,
            numbers.contracts.treasury,
            numbers.contracts.vester,
            1n,
          ],
        ],
      },
    );
    show(null);
    expect((await screen.findByTestId("money-none")).textContent).toMatch(
      /has not read this project's money yet/,
    );
    expect(await screen.findByTestId("holding-take-out")).not.toBeNull();
  });

  it("a launch that left the network shows no money and no way to send any", async () => {
    show({ removed: true, key: numbers.key } as never);
    expect((await screen.findByTestId("money-none")).textContent).toMatch(
      /left the network/,
    );
    expect(screen.queryByTestId("chain-only-shares")).toBeNull();
  });

  it("a launcher that does not know the project says the Shares cannot be shown, and sends nothing", async () => {
    setup(
      { shares: 1_000n * S },
      {
        projectByKey: [
          [
            `0x${"0".repeat(40)}`,
            `0x${"0".repeat(40)}`,
            `0x${"0".repeat(40)}`,
            `0x${"0".repeat(40)}`,
            `0x${"0".repeat(40)}`,
            0n,
          ],
        ],
      },
    );
    show(null);
    expect(
      (await screen.findByTestId("chain-only-failed")).textContent,
    ).toMatch(/Your money is not affected/);
    expect(chain.sent).toEqual([]);
  });
});

describe("the loading state", () => {
  it("shows a placeholder, not a number", () => {
    show(undefined, { loading: true });
    expect(screen.queryByTestId("money-pot")).toBeNull();
  });
});
