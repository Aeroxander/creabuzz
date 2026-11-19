// The wind-down sheet is only offered before a market, when the project has no floor at all (`Treasury.handBack` reverts
// `NotSettled` until a sale's money is split, and a wound-down project can never open an auction): it must not promise
// holders a floor.
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installChainStub } from "../../../tests/helpers/chain-stub";
import {
  COORDINATE,
  NOW,
  numbersOf,
  SERVER,
  serve,
  wrap,
} from "../../../tests/helpers/money-harness";
import {
  FOUNDER_EVM,
  numbersContent,
} from "../../../tests/helpers/numbers-fixture";
import { TeamMoney } from "./TeamMoney";

vi.mock(
  "../../lib/relay",
  async () => (await import("../../../tests/helpers/money-harness")).relayMock,
);

const FOUNDER = COORDINATE.split(":")[1];

beforeEach(() => {
  applyServerSettings({ investing: true, self: SERVER });
  serve([]);
});
afterEach(() => {
  cleanup();
  applyServerSettings(null);
});

describe("wind-down copy before any market", () => {
  it("does not promise holders a floor that does not exist yet", async () => {
    installChainStub({ account: FOUNDER_EVM });
    const content = numbersContent({
      coordinate: COORDINATE,
      now: NOW,
      stage: "backed",
      runner: FOUNDER_EVM,
    });
    expect((content.stage as { name: string }).name).toBe("backed");
    wrap(
      <TeamMoney numbers={numbersOf(content)} profiles={{}} team={[FOUNDER]} />,
    );
    fireEvent.click(await screen.findByTestId("wind-down"));
    const text =
      (await screen.findByTestId("wind-down-sheet")).textContent ?? "";
    expect(text).not.toMatch(/floor stays for holders to hand back/i);
  });
});
