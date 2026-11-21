// What the people who run a project see while holders have the team's spending paused (or are about to): the sentence, a
// disabled Draw with that sentence as its description, the chain's own answer over an older record, one line for the helpers,
// and nothing at all for a project with no pause.
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SERVER, wrap } from "../../../tests/helpers/money-harness";
import {
  installPotChain,
  type PotChain,
} from "../../../tests/helpers/pot-chain";
import {
  numbersWithPause,
  PAUSE,
  pauseAnswers,
} from "../../../tests/helpers/pause-harness";
import {
  D,
  FOUNDER_EVM,
  nameTheNetwork,
  numbersFor,
  S,
} from "../../../tests/helpers/pot-harness";
import type { ProjectNumbers } from "../money/numbers";
import { potProblem } from "../money/pot-copy";
import { AllowanceSection } from "../pot/AllowanceSection";
import { AllowanceSheets } from "../pot/AllowanceSheets";
import { injectedWallet } from "../money/wallet";
import { AgentCaps } from "../tasks/AgentCaps";

vi.mock(
  "../../lib/relay",
  async () => (await import("../../../tests/helpers/money-harness")).relayMock,
);
vi.mock("../../lib/account", () => ({
  useAccount: () => ({ pubkey: "b".repeat(64), locked: false }),
}));
vi.mock("@tanstack/react-router", async (actual) => ({
  ...(await actual<object>()),
  Link: ({ children }: { children: ReactNode }) => (
    <a href="/week">{children}</a>
  ),
}));

const base = numbersFor();
const NOW = base.builtAt + 100;
let chain: PotChain;

function setup(
  numbers: ProjectNumbers,
  chainPause: { parked: bigint; paused: boolean; armedAt?: number },
) {
  const backers = numbers.shares.backers;
  chain = installPotChain({
    account: FOUNDER_EVM,
    answers: {
      box: [700n * D],
      boxCap: [7_000n * D],
      ratePpm: [1_000n],
      pendingRatePpm: [0n],
      pendingAt: [0n],
      lastCheckIn: [BigInt(NOW - 3 * 86_400)],
      activeEnd: [BigInt(NOW + 11 * 86_400)],
      MAX_RATE_PPM: [2_000n],
      unit: [BigInt(numbers.unit)],
      ...pauseAnswers({
        mine: 0n,
        parked: chainPause.parked,
        backers,
        armedAt: chainPause.armedAt ?? 0,
        paused: chainPause.paused,
      }),
    } as never,
  });
}
const show = (numbers: ProjectNumbers) =>
  wrap(<AllowanceSection address={FOUNDER_EVM} now={NOW} numbers={numbers} />);

beforeEach(() => {
  applyServerSettings({ investing: true, self: SERVER });
  nameTheNetwork(base);
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  localStorage.clear();
  applyServerSettings(null);
});

const paused = () =>
  numbersWithPause({ parked: 200_000n * S, armedAgo: 2 * 86_400 });
const armed = () => numbersWithPause({ parked: 200_000n * S, armedAgo: 3_600 });

describe("the allowance card while the pause is on", () => {
  it("a paused project: the team's sentence, and Draw is off with that sentence as its description", async () => {
    const numbers = paused();
    setup(numbers, {
      parked: 200_000n * S,
      paused: true,
      armedAt: numbers.pause?.armedAt ?? 0,
    });
    show(numbers);
    const line = await screen.findByTestId("team-pause-paused");
    expect(line.textContent).toMatch(
      /^Paused by holders since .*\. You cannot draw the allowance or plan a new task until fewer than a third of Shares are parked\. You can still check in, finish tasks already planned, grant Team Shares and hand over\.$/,
    );
    const draw = screen.getByTestId("allowance-draw") as HTMLButtonElement;
    expect(draw.disabled).toBe(true);
    expect(draw.getAttribute("aria-describedby")).toBe(line.id);
    // the other presses are still there: check in (a link), the rate and the door
    expect(
      (screen.getByTestId("allowance-rate-open") as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(
      (screen.getByTestId("allowance-door") as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("an armed line: the warning sentence, and Draw still works until then", async () => {
    const numbers = armed();
    setup(numbers, {
      parked: 200_000n * S,
      paused: false,
      armedAt: numbers.pause?.armedAt ?? 0,
    });
    show(numbers);
    expect((await screen.findByTestId("team-pause-armed")).textContent).toMatch(
      /^Holders have parked a third of all Shares\. Your allowance and new task plans pause on .* if it stays there\. Until then you can draw what the box holds\.$/,
    );
    expect(
      (screen.getByTestId("allowance-draw") as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("the chain's own answer wins over an older record: a pause that has ended no longer holds Draw", async () => {
    const numbers = paused();
    setup(numbers, { parked: 100n * S, paused: false });
    show(numbers);
    await screen.findByTestId("allowance-box");
    await waitFor(() =>
      expect(
        (screen.getByTestId("allowance-draw") as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    expect(screen.queryByTestId("team-pause-paused")).toBeNull();
  });

  it("a pause that began since the record: Draw's sheet is refused by the chain's answer, in the sheet's words", async () => {
    const numbers = armed();
    setup(numbers, {
      parked: 200_000n * S,
      paused: true,
      armedAt: numbers.pause?.armedAt ?? 0,
    });
    show(numbers);
    // the record says armed; the chain says paused once it has been read
    await screen.findByTestId("allowance-draw");
    await waitFor(() =>
      expect(
        (screen.getByTestId("allowance-draw") as HTMLButtonElement).disabled,
      ).toBe(true),
    );
  });

  it("a project with no pause shows nothing about it and reads nothing about it", async () => {
    setup(base, { parked: 0n, paused: false });
    show(base);
    await screen.findByTestId("allowance-box");
    expect(screen.queryByTestId("team-pause-paused")).toBeNull();
    expect(screen.queryByTestId("team-pause-armed")).toBeNull();
    expect(chain.reads.some((r) => r.name === "pauseGate")).toBe(false);
    expect(
      (screen.getByTestId("allowance-draw") as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});

describe("Draw's own sheet", () => {
  it("is blocked, with the team's sentence in it, when the chain says paused although the page was drawn before the pause began", async () => {
    const numbers = armed();
    setup(numbers, {
      parked: 200_000n * S,
      paused: true,
      armedAt: numbers.pause?.armedAt ?? 0,
    });
    const wallet = injectedWallet();
    wrap(
      <AllowanceSheets
        now={NOW}
        numbers={numbers}
        onClose={() => undefined}
        ready={{
          address: FOUNDER_EVM,
          read: (to, data) => wallet.readCall(to, data),
          wallet,
        }}
        sheet="draw"
      />,
    );
    fireEvent.change(await screen.findByTestId("draw-to"), {
      target: { value: `0x${"cd".repeat(20)}` },
    });
    fireEvent.change(screen.getByTestId("draw-amount"), {
      target: { value: "0.1" },
    });
    // the terms line appears: the press would be sendable, were it not for the pause
    expect(await screen.findByTestId("draw-terms")).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByTestId("team-pause-paused")).toBeTruthy(),
    );
    expect(
      (screen.getByTestId("sheet-confirm") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(chain.sent.length).toBe(0);
  });
});

describe("the helpers' line and the chain's refusal", () => {
  it("while paused, the helpers' card says they cannot draw; otherwise it says nothing of it", () => {
    wrap(<AgentCaps numbers={paused()} />);
    expect(screen.getByTestId("agent-paused").textContent).toBe(
      "Helpers cannot draw while the team's spending is paused.",
    );
    cleanup();
    wrap(<AgentCaps numbers={armed()} />);
    expect(screen.queryByTestId("agent-paused")).toBeNull();
    cleanup();
    wrap(<AgentCaps numbers={base} />);
    expect(screen.queryByTestId("agent-paused")).toBeNull();
  });

  it("a Draw or a plan the chain refuses anyway (a stale read) reads in the plan's words", () => {
    const refusal = { message: "execution reverted: Paused()" };
    const words =
      "The team's spending is paused by holders. Try again when parked Shares fall below a third.";
    expect(potProblem(refusal, "draw")).toBe(words);
    expect(potProblem(refusal, "plan-task")).toBe(words);
    expect(potProblem(refusal, "pay-task")).toBe(words);
  });

  it("the pause's address is the Treasury's own answer, never typed here", () => {
    expect(PAUSE).toMatch(/^0x[0-9a-f]{40}$/);
  });
});
