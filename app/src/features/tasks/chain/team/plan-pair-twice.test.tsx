// The same plan is never asked of the other signer twice: what already waits in the Pair is read before the ask (plan section
// 8.1, attack 7), because confirming both would put two plans of one task on the network.
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
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
import { decodeCall } from "@creaton/core/pot/abi-codec.ts";
import { PAIR_ABI } from "@creaton/core/pot/abis.generated.ts";
import { encodeParameters } from "@creaton/core/launchpad/evmAbi.ts";
import { addressTopic, topicOf } from "@creaton/core/launchpad/work.ts";
import { forgetPending, sendKey } from "../../../money/pending-sends";
import type { Project } from "../../../project/project-record";
import { chainRowOf, nowOf } from "../state";
import { TeamActions } from "./TeamActions";

vi.mock(
  "../../../../lib/relay",
  async () =>
    (await import("../../../../../tests/helpers/money-harness")).relayMock,
);
const PAIR = "0x00000000000000000000000000000000000000ff";
const SECOND = "0x00000000000000000000000000000000000000dd";
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

const PROPOSED = topicOf("Proposed(bytes32,address,address,bytes,uint256)");

describe("the same plan asked of the other signer twice", () => {
  it("asks once, however many times the plan sheet is opened", async () => {
    const numbers = sceneNumbers((content) => {
      content.runner = {
        address: PAIR,
        isPair: true,
        signers: [FOUNDER_EVM, SECOND],
      };
    });
    nameTheNetwork(numbers);
    const now = Math.floor(Date.now() / 1000);
    const chain = installPotChain({
      account: FOUNDER_EVM,
      answers: {
        ...sceneAnswers(numbers),
        PROPOSAL_TTL: [86_400n],
        proposer: (_args: readonly unknown[]) => [SECOND],
        proposedAt: [BigInt(now)],
      } as never,
    });
    const task = planTask();
    const queue = queueOf(numbers);
    const draw = () =>
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
    for (let i = 0; i < 2; i++) {
      draw();
      fireEvent.click(await screen.findByTestId("door-plan"));
      await screen.findByTestId("plan-notice");
      fireEvent.click(screen.getByTestId("sheet-confirm"));
      if (i === 0) {
        await waitFor(() => expect(chain.sent.length).toBe(1));
        // What the first ask put in the Pair, as the chain's own log of it.
        const ask = decodeCall(PAIR_ABI, chain.sent[0]?.data ?? "");
        expect(ask?.name).toBe("propose");
        chain.logs = [
          {
            address: PAIR,
            topics: [PROPOSED, `0x${"01".repeat(32)}`, addressTopic(SECOND)],
            data: encodeParameters(
              ["address", "bytes", "uint256"],
              [String(ask?.args[0]), String(ask?.args[1]), 1n],
            ),
            blockNumber: "0x10",
            transactionHash: `0x${"ee".repeat(32)}`,
          },
        ];
      } else {
        expect(
          (await screen.findByTestId("sheet-problem")).textContent,
        ).toMatch(/already waiting for the other signer/);
      }
      cleanup();
      // A reload, or the other signer's own page: nothing of this page's memory of the first ask is left.
      forgetPending(
        sendKey(
          `plan-task:${numbers.chainId}:${numbers.contracts.treasury}:0x${task.id}`,
          FOUNDER_EVM,
        ),
      );
    }
    expect(chain.sent).toHaveLength(1);
  });
});
