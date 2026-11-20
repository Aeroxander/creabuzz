// One project whose holding can never be read (its record is of another Launcher than this build's, with a cut holder list) does
// not hold back the news of the other projects: it counts as one that could not be refreshed.
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { act, cleanup, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  coordinateOf,
  NOW,
  projectEvent,
  recordV2,
  SERVER,
  serve,
  wrap,
} from "../../../tests/helpers/money-harness";
import {
  BACKER_EVM,
  chainIdentityV2,
  numbersV2Content,
  withTasks,
} from "../../../tests/helpers/numbers-v2-fixture";
import { installPotChain } from "../../../tests/helpers/pot-chain";
import {
  backerAnswers,
  nameTheNetwork,
} from "../../../tests/helpers/pot-harness";
import { sceneNumbers } from "../../../tests/helpers/plan-scene";
import NewsSection from "./NewsSection";
import { BALANCE_READ_MS } from "./pipeline";

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
  useNavigate: () => () => Promise.resolve(),
}));

const numbers = sceneNumbers();

beforeEach(() => {
  applyServerSettings({ investing: true, self: SERVER });
  nameTheNetwork(numbers);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  localStorage.clear();
  applyServerSettings(null);
});

describe("one unreadable-holding project and the news of the others", () => {
  for (const odd of [false, true])
    it(`draws the news of a project the record lists (second project odd: ${odd})`, async () => {
      const events = [];
      for (let i = 0; i < 2; i += 1) {
        const coordinate = coordinateOf(i);
        const [, founder, id] = coordinate.split(":");
        events.push(
          projectEvent({
            author: founder as string,
            id: id as string,
            name: `Lantern ${i}`,
            chainKey: chainIdentityV2(coordinate).key,
          }),
          {
            ...recordV2(
              numbersV2Content({
                coordinate,
                now: NOW,
                patch: (content) => {
                  withTasks()(content);
                  if (i === 1 && odd) {
                    // A record of another Launcher than this build's, with a cut holder list.
                    content.launcher = `0x${"d".repeat(40)}`;
                    content.holders = [];
                    content.truncated = true;
                  }
                },
              }),
              coordinate,
              NOW,
            ),
            pubkey: SERVER,
          },
        );
      }
      serve(events);
      installPotChain({
        account: BACKER_EVM,
        answers: backerAnswers(numbers, { shares: 0n }) as never,
      });
      wrap(<NewsSection />);
      // The first project lists the account: its news must appear.
      await screen.findByTestId("news-list", undefined, { timeout: 3000 });
      expect(screen.queryByTestId("news-loading")).toBeNull();
    });
});

describe("a balance read that never answers", () => {
  it("is given up after a while: the news is drawn, with the line that something could not be refreshed", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout"],
      shouldAdvanceTime: true,
    });
    try {
      const coordinate = coordinateOf(0);
      const [, founder, id] = coordinate.split(":");
      serve([
        projectEvent({
          author: founder as string,
          id: id as string,
          name: "Lantern 0",
          chainKey: chainIdentityV2(coordinate).key,
        }),
        {
          ...recordV2(
            numbersV2Content({
              coordinate,
              now: NOW,
              patch: (content) => {
                withTasks()(content);
                // The holder list was cut and does not name the person: their holding is found only by a read.
                content.holders = [];
                content.truncated = true;
              },
            }),
            coordinate,
            NOW,
          ),
          pubkey: SERVER,
        },
      ]);
      installPotChain({
        account: BACKER_EVM,
        answers: backerAnswers(numbers) as never,
      });
      const eth = (
        window as unknown as {
          ethereum: { request: (a: { method: string }) => Promise<unknown> };
        }
      ).ethereum;
      const answer = eth.request.bind(eth);
      // The network takes the question and never answers it.
      eth.request = (args) =>
        args.method === "eth_call" ? new Promise(() => {}) : answer(args);
      wrap(<NewsSection />);
      await screen.findByTestId("news-loading");
      // The clock is moved on until the read is given up (it starts only once the records are in).
      await vi.waitFor(
        async () => {
          await act(async () => {
            await vi.advanceTimersByTimeAsync(BALANCE_READ_MS + 1_000);
          });
          expect(screen.queryByTestId("news-stale")).not.toBeNull();
        },
        { timeout: 5_000 },
      );
      expect(screen.queryByTestId("news-loading")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
