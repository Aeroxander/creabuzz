// The last step of a Back that lands: the account is linked to the wallet that made it (so the project's room opens), once, and
// never for a Back that did not land.
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
  BACKER_EVM,
  backerAnswers,
  nameTheNetwork,
  numbersFor,
} from "../../../tests/helpers/pot-harness";
import { forgetPending, sendKey } from "../money/pending-sends";
import { BackCard } from "./BackCard";

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
const linked = vi.fn(async () => "linked");
vi.mock("../room/use-link-after-back", () => ({
  useLinkAfterBack: () => linked,
}));

const numbers = numbersFor();
const NOW = numbers.builtAt + 100;
let chain: PotChain;

beforeEach(() => {
  linked.mockClear();
  applyServerSettings({ investing: true, self: SERVER });
  nameTheNetwork(numbers);
  chain = installPotChain({
    account: BACKER_EVM,
    answers: backerAnswers(numbers) as never,
  });
});
afterEach(() => {
  forgetPending(
    sendKey(
      `back:${numbers.chainId}:${numbers.contracts.treasury}`,
      BACKER_EVM,
    ),
  );
  cleanup();
  localStorage.clear();
  applyServerSettings(null);
});

async function back() {
  wrap(<BackCard now={NOW} numbers={numbers} projectName="Lantern" />);
  fireEvent.change(await screen.findByLabelText("How many dollars?"), {
    target: { value: "10" },
  });
  fireEvent.click(screen.getByTestId("backing-review"));
  await screen.findByTestId("back-pay");
}

describe("a Back that lands links the account", () => {
  it("asks for the link once, after the Back landed", async () => {
    await back();
    expect(linked).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("sheet-confirm"));
    await waitFor(() => expect(chain.sent.length).toBe(1));
    await waitFor(() => expect(linked).toHaveBeenCalledTimes(1));
  });

  it("does not ask when the Back did not go out", async () => {
    await back();
    // The person closes the sheet instead of pressing Back.
    fireEvent.keyDown(screen.getByTestId("back-sheet"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("back-sheet")).toBeNull());
    expect(chain.sent).toEqual([]);
    expect(linked).not.toHaveBeenCalled();
  });
});
