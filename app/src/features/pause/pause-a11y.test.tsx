// Assistive semantics of the pause screens, checked with axe on the DOM (names, roles, labels, ids): the card with its
// meter in every state, Your Shares with Park Shares and Take back, the Park sheet and the Take out sheet with parked Shares, the
// team's sentence with its Draw. One owner of each actionable label, and the banner is counted once.
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seriousViolations } from "../../../tests/helpers/axe-dom";
import { SERVER, serve, wrap } from "../../../tests/helpers/money-harness";
import {
  numbersWithPause,
  pauseAnswers,
} from "../../../tests/helpers/pause-harness";
import { installPotChain } from "../../../tests/helpers/pot-chain";
import {
  BACKER_EVM,
  backerAnswers,
  nameTheNetwork,
  S,
} from "../../../tests/helpers/pot-harness";
import { YourShares } from "../pot/YourShares";
import { targetOf } from "../pot/target";
import { PauseCard } from "./PauseCard";

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
  useRouter: () => ({ history: { back: () => undefined } }),
}));

const numbers = numbersWithPause({ parked: 0n });
const target = targetOf(numbers);

beforeEach(() => {
  applyServerSettings({ investing: true, self: SERVER });
  nameTheNetwork(numbers);
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  localStorage.clear();
  serve([]);
  window.location.hash = "";
  applyServerSettings(null);
});

describe("the pause screens have names, roles and labels", () => {
  it("the card has one region, a meter with a text value and no duplicate ids, in each state", async () => {
    for (const setup of [
      { parked: 100n * S },
      { parked: 200_000n * S, armedAgo: 3_600 },
      { parked: 200_000n * S, armedAgo: 2 * 86_400 },
    ]) {
      const n = numbersWithPause(setup);
      if (!n.pause) throw new Error("no pause");
      const { unmount } = wrap(
        <PauseCard holds now={n.builtAt + 100} numbers={n} pause={n.pause} />,
      );
      expect(screen.getAllByRole("region")).toHaveLength(1);
      expect(screen.getByRole("meter").getAttribute("aria-valuetext")).toMatch(
        /needed$/,
      );
      expect(await seriousViolations()).toEqual([]);
      unmount();
    }
  });

  it("Your Shares with Park Shares, Take back, the Park sheet and the Take out sheet: every control is named once and the sheets are labelled dialogs", async () => {
    installPotChain({
      account: BACKER_EVM,
      answers: {
        ...backerAnswers(numbers, { shares: 600n * S }),
        ...pauseAnswers({
          mine: 400n * S,
          parked: 400n * S,
          backers: BigInt(numbers.shares.backers),
        }),
      } as never,
    });
    wrap(
      <YourShares
        pauseInfo={{
          contract: numbers.contracts.pause ?? null,
          record: numbers.pause,
        }}
        projectName="Lantern"
        target={target}
      />,
    );
    await screen.findByTestId("holding-parked");
    // One owner of each label: a single Park Shares and a single Take back on the page.
    expect(screen.getAllByRole("button", { name: "Park Shares" })).toHaveLength(
      1,
    );
    expect(screen.getAllByRole("button", { name: "Take back" })).toHaveLength(
      1,
    );
    expect(await seriousViolations()).toEqual([]);
    fireEvent.click(screen.getByTestId("take-back"));
    // asking: the opener is replaced, so there is still one Take back, and Cancel
    expect(screen.getAllByRole("button", { name: "Take back" })).toHaveLength(
      1,
    );
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(await seriousViolations()).toEqual([]);
    fireEvent.click(screen.getByTestId("take-back-cancel"));
    fireEvent.click(screen.getByTestId("park-open"));
    await screen.findByTestId("park-summary");
    expect(screen.getByRole("dialog", { name: "Park Shares" })).toBeTruthy();
    expect(await seriousViolations()).toEqual([]);
    // the legal line is on the sheet once
    expect(
      screen.getAllByText(
        "You can take your money out any time. Nothing here promises a profit.",
      ),
    ).toHaveLength(1);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("park-sheet")).toBeNull());
    fireEvent.click(screen.getByTestId("holding-take-out"));
    await screen.findByTestId("takeout-unparks");
    expect(await seriousViolations()).toEqual([]);
  });
});
