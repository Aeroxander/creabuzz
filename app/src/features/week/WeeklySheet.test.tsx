// The weekly sheet's own guard against a quick double press (A1 in PLANV2-M6-REPORT.md's "Review fixes" covered Back;
// this holds the weekly post and its check-in).
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COORDINATE,
  installWallet,
  NOW,
  numbersOf,
  projectEvent,
  published,
  SERVER,
  sent,
  wrap,
} from "../../../tests/helpers/money-harness";
import {
  CONTRACTS,
  chainIdentity,
  FOUNDER_EVM,
  numbersContent,
} from "../../../tests/helpers/numbers-fixture";
import { parseProject, type RecordEvent } from "../project/project-record";
import { WeeklySheet } from "./WeeklySheet";

vi.mock(
  "../../lib/relay",
  async () => (await import("../../../tests/helpers/money-harness")).relayMock,
);

const [, FOUNDER, ID] = COORDINATE.split(":");

function lantern() {
  const project = parseProject(
    projectEvent({
      author: FOUNDER,
      id: ID,
      name: "Lantern",
      chainKey: chainIdentity(COORDINATE).key,
    }) as RecordEvent,
  );
  if (!project) throw new Error("not a project");
  return project;
}

/** Write the week's line and press the sheet's button twice before React shows it is busy. */
async function doublePress(checkIn: boolean) {
  wrap(
    <WeeklySheet
      checkIn={
        checkIn
          ? {
              numbers: numbersOf(
                numbersContent({ coordinate: COORDINATE, now: NOW }),
              ),
              to: CONTRACTS.treasury,
            }
          : null
      }
      onOpenChange={() => undefined}
      open
      project={lantern()}
    />,
  );
  fireEvent.change(await screen.findByTestId("weekly-text"), {
    target: { value: "Shipped the sign-up page." },
  });
  const post = screen.getByTestId("weekly-post");
  act(() => {
    post.click();
    post.click();
  });
  await screen.findByText(/^Posted/);
  await new Promise((r) => setTimeout(r, 100));
}

beforeEach(() => {
  applyServerSettings({ investing: true, self: SERVER });
  installWallet({ account: FOUNDER_EVM });
  published.length = 0;
});
afterEach(() => {
  cleanup();
  applyServerSettings(null);
});

describe("the weekly sheet sends once for a quick double press", () => {
  it("posts the update once", async () => {
    await doublePress(false);
    expect(published).toHaveLength(1);
  });

  it("posts once and checks in once", async () => {
    await doublePress(true);
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(published).toHaveLength(1);
    expect(sent[0].to).toBe(CONTRACTS.treasury);
  });
});
