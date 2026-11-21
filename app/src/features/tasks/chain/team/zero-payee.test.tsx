// A pay-to of the zero address means "open to anyone" on the network: a plan naming it would let the first stranger take the
// task (and hold part of the project's money). The app never plans to it (plan choice C4: only with a named payee).
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
} from "../../../../../tests/helpers/plan-scene";
import type { Project } from "../../../project/project-record";
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

beforeEach(() => applyServerSettings({ investing: true, self: SERVER }));
afterEach(() => {
  cleanup();
  localStorage.clear();
  applyServerSettings(null);
});

describe("a pay-to that the network reads as 'anyone'", () => {
  it("does not send a plan to the zero address", async () => {
    const numbers = sceneNumbers();
    nameTheNetwork(numbers);
    const chain = installPotChain({
      account: FOUNDER_EVM,
      answers: sceneAnswers(numbers) as never,
    });
    const task = planTask({ payTo: `0x${"0".repeat(40)}` });
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
    // The card says the wallet is missing and offers no plan press at all.
    expect((await screen.findByTestId("door-waiting")).textContent).toMatch(
      /account/,
    );
    expect(screen.queryByTestId("door-plan")).toBeNull();
    expect(chain.sent).toEqual([]);
  });
});
