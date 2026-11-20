// The Money tab with a task queue: "Planned and running tasks" and "Money you can claim" sit with the rest, the Take out
// sheet's line goes to the claims, a record whose queue could not be read says so and leaves money alone, and a record with
// no queue shows neither section.
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SERVER, wrap } from "../../../tests/helpers/money-harness";
import { CLAIMANT } from "../../../tests/helpers/notes-scene";
import {
  installPotChain,
  type PotChain,
} from "../../../tests/helpers/pot-chain";
import {
  backerAnswers,
  nameTheNetwork,
  numbersFor,
  S,
} from "../../../tests/helpers/pot-harness";
import { sceneAnswers, sceneNumbers } from "../../../tests/helpers/plan-scene";
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

let chain: PotChain;

function show(numbers: ProjectNumbers) {
  nameTheNetwork(numbers);
  chain = installPotChain({
    account: CLAIMANT,
    answers: {
      ...(typeof numbers.tasks === "object" && numbers.tasks
        ? sceneAnswers(numbers)
        : {}),
      ...backerAnswers(numbers, { shares: 1_000n * S }),
      quoteTakeOut: (args: readonly unknown[]) => [
        ((args[1] as bigint) * 9_800n) / S,
        5_000_000n,
        0n,
      ],
    } as never,
  });
  return wrap(
    <ProjectMoney
      chainKey={numbers.key}
      error={undefined}
      loading={false}
      now={numbers.asOf.time + 100}
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
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  localStorage.clear();
  applyServerSettings(null);
});

describe("the Money tab with a task queue", () => {
  it("shows the planned and running tasks and the money you can claim, with the money's own sections around them", async () => {
    show(sceneNumbers());
    expect(await screen.findByTestId("planned-section")).toBeTruthy();
    expect(await screen.findByTestId("notes-section")).toBeTruthy();
    const order = ["your-shares", "planned-section", "notes-section"].map(
      (id) =>
        Array.from(document.querySelectorAll("[data-testid]")).findIndex(
          (n) => n.getAttribute("data-testid") === id,
        ),
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((n) => n >= 0)).toBe(true);
  });

  it("the Take out sheet's line goes to where the money is claimed: the sheet closes and the section's heading takes focus", async () => {
    show(sceneNumbers());
    fireEvent.click(await screen.findByTestId("holding-take-out"));
    const link = await screen.findByTestId("takeout-where-to-claim");
    expect(link.textContent).toBe("Where you claim it");
    fireEvent.click(link);
    await waitFor(() =>
      expect(screen.queryByTestId("takeout-sheet")).toBeNull(),
    );
    const heading = await screen.findByRole("heading", {
      name: "Money you can claim",
    });
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });

  it("says the list could not be read, and that money is not affected, and Take out still works with the queue unreadable", async () => {
    show({ ...sceneNumbers(), tasks: "unreadable" } as ProjectNumbers);
    expect((await screen.findByTestId("tasks-unreadable")).textContent).toBe(
      "The task list could not be read. Your money is not affected: you can take it out any time.",
    );
    expect(screen.queryByTestId("notes-section")).toBeNull();
    fireEvent.click(await screen.findByTestId("holding-take-out"));
    await screen.findByTestId("takeout-cash");
    fireEvent.click(screen.getByTestId("sheet-confirm"));
    await waitFor(() => expect(chain.sent).toHaveLength(1));
    // The sentence still reads, with no limit from the page.
    expect(screen.queryByTestId("takeout-where-to-claim")).toBeNull();
  });

  it("shows neither section for a record that has no queue", async () => {
    show(numbersFor());
    await screen.findByTestId("project-money");
    expect(screen.queryByTestId("planned-section")).toBeNull();
    expect(screen.queryByTestId("notes-section")).toBeNull();
    expect(screen.queryByTestId("tasks-unreadable")).toBeNull();
  });
});
