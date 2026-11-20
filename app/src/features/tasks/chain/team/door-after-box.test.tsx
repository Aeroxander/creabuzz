// A task the box already paid (the payment is in the paid journal because its record failed to save) is not planned: the card
// does not offer "Plan it instead", and a Plan sheet that is open is blocked, so the task cannot be paid a second time on the network.
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SERVER, wrap } from "../../../../../tests/helpers/money-harness";
import { installPotChain } from "../../../../../tests/helpers/pot-chain";
import {
  FOUNDER_EVM,
  nameTheNetwork,
} from "../../../../../tests/helpers/pot-harness";
import {
  FOUNDER_KEY,
  planTask,
  queueOf,
  sceneAnswers,
  sceneNumbers,
  TASK_ID,
} from "../../../../../tests/helpers/plan-scene";
import type { Project } from "../../../project/project-record";
import { forgetPaid, rememberPaid } from "../../paid-journal";
import { chainRowOf, nowOf } from "../state";
import { TeamActions } from "./TeamActions";

vi.mock(
  "../../../../lib/relay",
  async () =>
    (await import("../../../../../tests/helpers/money-harness")).relayMock,
);

const project = {
  coordinate: `37001:${FOUNDER_KEY}:orbit`,
  author: FOUNDER_KEY,
  team: [],
} as unknown as Project;

beforeEach(() => {
  forgetPaid(TASK_ID);
  applyServerSettings({ investing: true, self: SERVER });
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  applyServerSettings(null);
});

function draw(journal: boolean) {
  const numbers = sceneNumbers();
  nameTheNetwork(numbers);
  const chain = installPotChain({
    account: FOUNDER_EVM,
    answers: sceneAnswers(numbers) as never,
  });
  const task = planTask({
    usd: 1,
    state: "accepted",
    acceptedBy: FOUNDER_KEY,
    acceptedAt: 1,
    handIn: { id: "1".repeat(64), at: 1, note: "done" },
  });
  // The box paid it; the record that says so did not save.
  if (journal)
    rememberPaid({
      task: task.id,
      handIn: "1".repeat(64),
      txHash: `0x${"ab".repeat(32)}`,
      at: 1,
    });
  const queue = queueOf(numbers);
  wrap(
    <TeamActions
      address={FOUNDER_EVM}
      agents={new Set()}
      chain={chainRowOf(queue, task.id)}
      me={FOUNDER_KEY}
      now={nowOf(numbers.asOf.time)}
      numbers={numbers}
      operators={new Map()}
      profiles={undefined}
      project={project}
      task={task}
      tasks={queue}
      team={new Set([FOUNDER_KEY])}
    />,
  );
  return chain;
}

describe("a task the box already paid is not planned", () => {
  it("offers the other door on an accepted task nobody has paid (the control)", async () => {
    draw(false);
    expect(await screen.findByTestId("door-plan-also")).toBeTruthy();
  });

  it("does not offer the plan door for a task whose box payment is only waiting for its record", async () => {
    const chain = draw(true);
    // Give the card time to draw whatever it would offer.
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.queryByTestId("door-choice")).toBeNull();
    expect(screen.queryByTestId("door-plan-also")).toBeNull();
    expect(screen.queryByTestId("door-plan")).toBeNull();
    expect(chain.sent).toEqual([]);
  });
});
