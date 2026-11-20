// The dot keeps a remembered holding of a project whose holder list was cut while it has no news (and while the balance read is
// pending or failed): only a whole list or a balance read that came back can say "does not hold it" (plan 6.3, last-seen holdings).
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COORDINATE,
  NOW,
  projectEvent,
  recordV2,
  SERVER,
  serve,
} from "../../../tests/helpers/money-harness";
import {
  BACKER_EVM,
  chainIdentityV2,
  numbersV2Content,
  taskRow,
  withTasks,
} from "../../../tests/helpers/numbers-v2-fixture";
import { installPotChain } from "../../../tests/helpers/pot-chain";
import {
  backerAnswers,
  nameTheNetwork,
} from "../../../tests/helpers/pot-harness";
import { sceneNumbers } from "../../../tests/helpers/plan-scene";
import { useUnseenCount } from "../notifications/use-notifications";
import { heldKeys, rememberHeld } from "./seen";

const PUBKEY = "b".repeat(64);
const [, FOUNDER, ID] = COORDINATE.split(":");
const numbers = sceneNumbers();

vi.mock(
  "../../lib/relay",
  async () => (await import("../../../tests/helpers/money-harness")).relayMock,
);
vi.mock("../../lib/account", () => ({
  useAccount: () => ({ pubkey: "b".repeat(64), locked: false }),
}));

function Dot() {
  return <span data-testid="dot">{useUnseenCount()}</span>;
}

beforeEach(() => {
  applyServerSettings({ investing: true, self: SERVER });
  nameTheNetwork(numbers);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  applyServerSettings(null);
});

describe("a cut-list holding the dot has no news for", () => {
  it("keeps a remembered holding of a project whose holder list was cut, while it has no news", async () => {
    serve([
      projectEvent({
        author: FOUNDER as string,
        id: ID as string,
        name: "Lantern",
        chainKey: chainIdentityV2(COORDINATE).key,
      }),
      {
        ...recordV2(
          numbersV2Content({
            coordinate: COORDINATE,
            now: NOW,
            patch: withTasks((tasks, content) => {
              // No news: only a withdrawn and a lapsed plan; the holder list is cut and does not name the person.
              (tasks as { list: unknown[] }).list = (
                tasks as { list: { serial: number }[] }
              ).list.filter((r) => r.serial === 9 || r.serial === 5);
              tasks.openCount = 0;
              tasks.nextExpiry = 0;
              content.holders = [];
              content.truncated = true;
              void taskRow;
            }),
          }),
          COORDINATE,
          NOW,
        ),
        pubkey: SERVER,
      },
    ]);
    installPotChain({
      account: BACKER_EVM,
      answers: backerAnswers(numbers) as never,
    });
    rememberHeld(PUBKEY, BACKER_EVM, numbers.key, true, NOW);
    expect(heldKeys(PUBKEY, BACKER_EVM)).toContain(numbers.key);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <Dot />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("dot").textContent).toBe("0"),
    );
    // Give the effect time to run.
    await new Promise((r) => setTimeout(r, 300));
    // The holding is remembered: the dot reads this project the next time it has news.
    expect(heldKeys(PUBKEY, BACKER_EVM)).toContain(numbers.key);
  });
});
