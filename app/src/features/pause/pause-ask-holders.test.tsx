// The pause card's one extra line and press (COUNCIL-PLAN.md section 6.3): shown only when the parked Shares meet the
// vote's floor, no ballot is open, the cooldown is over and this person has Shares parked — then it opens the stand sheet
// in its opening mode, so there is no second sheet.
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  councilRaw,
  NOW,
  SERVER,
  VOTE,
} from "../../../tests/helpers/council-v2-parse";
import { event } from "../../../tests/helpers/numbers-v2-parse";
import { parseNumbers } from "../money/numbers";
import { withStepKeys } from "../money/numbers-step9";
import { installPotChain } from "../../../tests/helpers/pot-chain";
import { withPause } from "../../../tests/helpers/pause-harness";
import { nameTheNetwork } from "../../../tests/helpers/pot-harness";
import { wrap } from "../../../tests/helpers/money-harness";
import type { ProjectNumbers } from "../money/numbers";
import { PauseCard } from "./PauseCard";

vi.mock(
  "../../lib/relay",
  async () => (await import("../../../tests/helpers/money-harness")).relayMock,
);

const ME = "0x1111111111111111111111111111111111111111";
const PAUSE = `0x${"61".repeat(20)}`;

/** The ballot record with the pause block the opener reads, and whether an address has Shares parked in it. */
function recordWith(input: {
  parked: bigint;
  mine?: bigint;
  floorMet?: boolean;
  open?: boolean;
}): ProjectNumbers {
  const raw = councilRaw("voting", (r) => {
    withPause(r, {
      parked: input.floorMet === false ? 0n : 60_000n * 10n ** 18n,
    });
    // The project's pause is its vote contract (the ballot is counted in the pause's own custody).
    r.contracts.pause = VOTE;
    r.pause.contract = VOTE;
    if (input.open !== true) r.vote.open = null;
    if (input.open === false) r.vote = null;
  });
  const key = String(raw.key).toLowerCase();
  const parsed = parseNumbers(event(raw, { tags: [["d", key]] }), SERVER);
  if (!parsed || parsed.removed) throw new Error("the record did not parse");
  const record = withStepKeys(parsed);
  nameTheNetwork(record);
  installPotChain({
    account: ME,
    answers: {
      pauseGate: [PAUSE],
      parkedOf: [input.mine ?? input.parked],
    },
  });
  return record;
}

function show(record: ProjectNumbers) {
  if (!record.pause) throw new Error("no pause");
  return wrap(
    <PauseCard
      holds
      nameOf={(address: string) =>
        `${address.slice(0, 6)}…${address.slice(-4)}`
      }
      now={NOW}
      numbers={record}
      pause={record.pause}
      projectCoordinate="37001:x"
    />,
  );
}

beforeEach(() => {
  applyServerSettings({ investing: true, self: "f".repeat(64) });
});
afterEach(() => {
  cleanup();
  applyServerSettings(null);
  vi.unstubAllEnvs();
});

describe("the opener", () => {
  it("shows the plan's line and one press to a person with Shares parked, and opens the stand sheet in its opening mode", async () => {
    show(recordWith({ parked: 1_000n }));
    expect((await screen.findByTestId("pause-ask-line")).textContent).toBe(
      "Enough Shares are parked to ask holders who should run this project.",
    );
    fireEvent.click(screen.getByTestId("pause-ask-press"));
    const sheet = await screen.findByTestId("stand-sheet");
    expect(sheet.textContent).toContain("Open the vote");
    expect((await screen.findByTestId("stand-opening")).textContent).toContain(
      "This opens a vote.",
    );
  });

  it("shows nothing when a ballot is open", async () => {
    show(recordWith({ parked: 1_000n, open: true }));
    await screen.findByTestId("vote-card").catch(() => null);
    // The card's own query settles first; the opener was never offered.
    await new Promise((r) => setTimeout(r, 40));
    expect(screen.queryByTestId("pause-ask-line")).toBeNull();
    expect(screen.queryByTestId("pause-ask-press")).toBeNull();
  });

  it("shows nothing when the parked Shares are under the vote's floor", async () => {
    show(recordWith({ parked: 1_000n, floorMet: false }));
    await new Promise((r) => setTimeout(r, 40));
    expect(screen.queryByTestId("pause-ask-line")).toBeNull();
  });

  it("shows nothing to a person with no Shares parked", async () => {
    show(recordWith({ parked: 0n, mine: 0n }));
    await new Promise((r) => setTimeout(r, 40));
    expect(screen.queryByTestId("pause-ask-line")).toBeNull();
  });

  it("shows nothing on a record with no vote contract", async () => {
    const plain = recordWith({ parked: 1_000n, open: false });
    show(plain);
    await new Promise((r) => setTimeout(r, 40));
    expect(screen.queryByTestId("pause-ask-line")).toBeNull();
  });
});
