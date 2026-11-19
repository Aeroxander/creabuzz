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
import { decodeCall } from "@creaton/core/pot/abi-codec.ts";
import { TREASURY_ABI } from "@creaton/core/pot/abis.generated.ts";
import {
  COORDINATE,
  installWallet,
  NOW,
  numbersV2Of,
  projectEvent,
  published,
  SERVER,
  sent,
  wrap,
} from "../../../tests/helpers/money-harness";
import {
  chainIdentityV2,
  FOUNDER_EVM,
  numbersV2Content,
} from "../../../tests/helpers/numbers-v2-fixture";
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
      chainKey: chainIdentityV2(COORDINATE).key,
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
              numbers: numbersV2Of(
                numbersV2Content({ coordinate: COORDINATE, now: NOW }),
              ),
              address: FOUNDER_EVM,
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
    const numbers = numbersV2Of(
      numbersV2Content({ coordinate: COORDINATE, now: NOW }),
    );
    expect(sent[0].to).toBe(numbers.contracts.treasury);
    // The check-in carries the id of the record that was just signed and posted: signed first, then checked in.
    const checkIn = decodeCall(TREASURY_ABI, sent[0].data);
    expect(checkIn?.name).toBe("checkIn");
    expect(checkIn?.args).toEqual([`0x${(published[0] as { id: string }).id}`]);
  });
});
