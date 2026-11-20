// The pay sheet's last look also reads the team's record past the cache, as step 1's presses do: money is never paid for work
// the record no longer shows (another piece handed in, the team asked for changes on another device).
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { published, SERVER } from "../../../../../tests/helpers/money-harness";
import { handedInTask, TASK_ID } from "../../../../../tests/helpers/plan-scene";
import {
  chain,
  confirm,
  numbers,
  openSheet,
  setup,
  show,
} from "../../../../../tests/helpers/pay-scene";
import { forgetPaid } from "../../paid-journal";
import type { ProjectTask } from "../../task-record";

vi.mock(
  "../../../../lib/relay",
  async () =>
    (await import("../../../../../tests/helpers/money-harness")).relayMock,
);
let moved: ProjectTask | null = null;
vi.mock("../../use-tasks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../use-tasks")>()),
  freshTask: async () => moved,
}));

beforeEach(() => {
  applyServerSettings({ investing: true, self: SERVER });
  published.length = 0;
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  forgetPaid(TASK_ID);
  applyServerSettings(null);
});

describe("the pay sheet's last look at the team's record", () => {
  it("does not pay when the server now holds another piece of work than the one the card showed", async () => {
    setup();
    const shown = handedInTask(numbers);
    // The worker handed in again (or the team asked for changes elsewhere): the server's record has moved on.
    moved = {
      ...shown,
      handIn: { id: "cd".repeat(32), at: shown.at + 5, note: "A new piece" },
    };
    show({ task: shown });
    await openSheet();
    fireEvent.click(confirm());
    await new Promise((r) => setTimeout(r, 500));
    expect(chain.sent).toEqual([]);
    expect(screen.queryByTestId("sheet-problem")).not.toBeNull();
  });
});
