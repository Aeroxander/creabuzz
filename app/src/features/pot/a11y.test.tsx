// Assistive semantics of every new money screen, checked with axe on the DOM: every control has a name, every field a label,
// no id is used twice, and the open sheets are labelled dialogs. (Colour and layout are judged in a real browser.)
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seriousViolations } from "../../../tests/helpers/axe-dom";
import { SERVER, wrap } from "../../../tests/helpers/money-harness";
import { installPotChain } from "../../../tests/helpers/pot-chain";
import {
  BACKER_EVM,
  backerAnswers,
  FOUNDER_EVM,
  nameTheNetwork,
  numbersFor,
  S,
} from "../../../tests/helpers/pot-harness";
import { PageMoney } from "../../../tests/helpers/page-money";

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
const allowance = {
  box: [700_000_000n],
  boxCap: [7_000_000_000n],
  pendingRatePpm: [1_500n],
  pendingAt: [BigInt(numbers.builtAt - 60 - numbers.unit)],
  unit: [BigInt(numbers.unit)],
  lastCheckIn: [BigInt(numbers.builtAt - 86_400)],
  activeEnd: [BigInt(numbers.builtAt + 86_400)],
  MAX_RATE_PPM: [2_000n],
  idsOf: [[]],
};

function show(account: string) {
  installPotChain({
    account,
    answers: {
      ...backerAnswers(numbers, { shares: 1_000n * S, team: 5n * S }),
      ...allowance,
    } as never,
  });
  return wrap(
    <PageMoney
      chainKey={numbers.key}
      error={null}
      loading={false}
      now={numbers.builtAt + 100}
      numbers={numbers}
      onRetry={() => undefined}
      profiles={undefined}
      projectName="Lantern"
      team={[]}
    />,
  );
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

describe("no serious accessibility violation on the money screens", () => {
  it("the Money tab for a backer, with and without a sheet open", async () => {
    show(BACKER_EVM);
    await screen.findByTestId("holding-take-out");
    expect(await seriousViolations()).toEqual([]);
    fireEvent.change(screen.getByLabelText("How many dollars?"), {
      target: { value: "10" },
    });
    fireEvent.click(screen.getByTestId("backing-review"));
    await screen.findByTestId("back-pay");
    expect(screen.getByRole("dialog", { name: /Back Lantern/ })).not.toBeNull();
    expect(await seriousViolations()).toEqual([]);
    fireEvent.keyDown(screen.getByTestId("back-sheet"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("back-sheet")).toBeNull());
    fireEvent.click(screen.getByTestId("holding-take-out"));
    await screen.findByTestId("takeout-cash");
    expect(
      screen.getByRole("dialog", { name: /Take out of Lantern/ }),
    ).not.toBeNull();
    expect(await seriousViolations()).toEqual([]);
  });

  it("the runner's allowance, Team Shares and every sheet", async () => {
    show(FOUNDER_EVM);
    await screen.findByTestId("allowance-box");
    expect(await seriousViolations()).toEqual([]);
    for (const [open, ready, name] of [
      ["allowance-draw", "draw-box", /Draw from the allowance box/],
      ["allowance-rate-open", "rate-now", /Change the daily allowance/],
      ["allowance-apply", "apply-ready", /Apply the announced allowance/],
      ["allowance-door", "door-words", /door to new backing/],
      ["grant-open", "grant-pool", /Grant Team Shares/],
    ] as const) {
      fireEvent.click(await screen.findByTestId(open));
      await screen.findByTestId(ready);
      expect(screen.getByRole("dialog", { name })).not.toBeNull();
      expect(await seriousViolations(), open).toEqual([]);
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    }
  });
});

describe("the check itself", () => {
  it("can fail: a button with no name is reported", async () => {
    const { container } = wrap(<button type="button" />);
    const found = await seriousViolations(container);
    expect(found.join("\n")).toMatch(/button-name/);
  });
});
