// After a Take out lands that left money owed for a task, the app reads that transaction's own logs for the tasks, best effort:
// the serials are kept in this browser's history (so "Money you can claim" finds them with no look back), and a read that
// fails, a log of another transaction or of another account's changes nothing and never fails the Take out.
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SERVER, wrap } from "../../../tests/helpers/money-harness";
import { mintedLog, serveLogs } from "../../../tests/helpers/notes-scene";
import {
  installPotChain,
  type PotChain,
} from "../../../tests/helpers/pot-chain";
import {
  BACKER_EVM,
  backerAnswers,
  nameTheNetwork,
  S,
  STRANGER_EVM,
} from "../../../tests/helpers/pot-harness";
import {
  queueOf,
  sceneAnswers,
  sceneNumbers,
} from "../../../tests/helpers/plan-scene";
import { ownNoteSerials, ownSteps } from "./own-history";
import { targetOf } from "./target";
import { HoldingTop } from "./HoldingTop";

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

const numbers = sceneNumbers();
/** The hash the wallet in the page gives the first call it is asked to send. */
const FIRST_TX = `0x${"1".padStart(64, "0")}`;
let chain: PotChain;

function setup(note: bigint) {
  chain = installPotChain({
    account: BACKER_EVM,
    answers: {
      ...sceneAnswers(numbers),
      ...backerAnswers(numbers, { shares: 1_000n * S }),
      quoteTakeOut: (args: readonly unknown[]) => [
        ((args[1] as bigint) * 9_800n) / S,
        note,
        0n,
      ],
    } as never,
  });
}

async function takeOut() {
  wrap(
    <HoldingTop
      onOpenMoney={() => {}}
      projectName="Orbit"
      target={targetOf(numbers)}
      tasks={null}
    />,
  );
  fireEvent.click(await screen.findByTestId("holding-take-out"));
  await screen.findByTestId("takeout-cash");
  fireEvent.click(screen.getByTestId("sheet-confirm"));
  await waitFor(() => expect(chain.sent).toHaveLength(1));
  await waitFor(() => expect(screen.queryByTestId("takeout-sheet")).toBeNull());
}

const book = () => queueOf(numbers).book;

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

describe("the tasks a Take out left money owed on", () => {
  it("are read from that transaction's own logs and kept with the step", async () => {
    setup(5_000_000n);
    serveLogs(
      [
        mintedLog({
          book: book(),
          serial: 6n,
          holder: BACKER_EVM,
          block: 990,
          tx: FIRST_TX,
        }),
        mintedLog({
          book: book(),
          serial: 7n,
          holder: BACKER_EVM,
          block: 990,
          tx: FIRST_TX,
        }),
        // Another book's (same transaction): not this project's.
        mintedLog({
          book: "0x00000000000000000000000000000000000000ba",
          serial: 10n,
          holder: BACKER_EVM,
          block: 990,
          tx: FIRST_TX,
        }),
        // Another transaction's, another account's: not this step's.
        mintedLog({
          book: book(),
          serial: 8n,
          holder: BACKER_EVM,
          block: 991,
          tx: `0x${"2".padStart(64, "0")}`,
        }),
        mintedLog({
          book: book(),
          serial: 9n,
          holder: STRANGER_EVM,
          block: 990,
          tx: FIRST_TX,
        }),
      ],
      { head: 1_000 },
    );
    await takeOut();
    await waitFor(() =>
      expect(ownNoteSerials(BACKER_EVM, numbers.key).sort()).toEqual([6n, 7n]),
    );
    expect(ownSteps(BACKER_EVM, numbers.key)[0]?.txHash).toBe(FIRST_TX);
  });

  it("are not looked for when the take out left nothing owed", async () => {
    setup(0n);
    const asked = serveLogs([], { head: 1_000 });
    await takeOut();
    expect(ownSteps(BACKER_EVM, numbers.key)).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 50));
    expect(asked).toEqual([]);
    expect(ownNoteSerials(BACKER_EVM, numbers.key)).toEqual([]);
  });

  it("a read that fails loses nothing and does not fail the take out: the step is kept without them", async () => {
    setup(5_000_000n);
    serveLogs([], { head: 1_000, refuseAll: true });
    await takeOut();
    expect(
      await screen.findByText("Taken out. The money is in your wallet."),
    ).toBeTruthy();
    expect(ownSteps(BACKER_EVM, numbers.key)).toHaveLength(1);
    expect(ownNoteSerials(BACKER_EVM, numbers.key)).toEqual([]);
  });

  it("a project with no task book changes nothing", async () => {
    setup(5_000_000n);
    chain.answers.tasks = ["0x0000000000000000000000000000000000000000"];
    const asked = serveLogs([], { head: 1_000 });
    await takeOut();
    await new Promise((r) => setTimeout(r, 50));
    expect(asked).toEqual([]);
  });
});
