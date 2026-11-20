// The You list never cuts the most urgent news: every plan a holder can still leave before is listed, whatever else is on the list,
// and the list says how many more there are on the projects' own pages.
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { cleanup, screen } from "@testing-library/react";
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
const PROJECTS = 11;

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

/** `count` projects, each with the example's queue: two plans in their notice and one taken task. */
async function drawProjects(count: number) {
  {
    const events = [];
    for (let i = 0; i < count; i += 1) {
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
                const contracts = content.contracts as Record<string, string>;
                contracts.shares = `0x${(0x1000 + i).toString(16).padStart(40, "0")}`;
                contracts.team = `0x${(0x2000 + i).toString(16).padStart(40, "0")}`;
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
      answers: backerAnswers(numbers) as never,
    });
    wrap(<NewsSection />);
    await screen.findByTestId("news-list");
    return screen.getAllByTestId("news-row");
  }
}

const plannedIn = (rows: HTMLElement[]) =>
  rows.filter((r) => r.getAttribute("data-kind") === "planned");

describe("the You list and its cut", () => {
  it("lists every plan a holder can still leave before, whatever else is on the list", async () => {
    const rows = await drawProjects(PROJECTS);
    // Two plans in their notice for each project: all 22 are urgent news, and the plain news is what is cut (more than 30 in all, 30 listed).
    expect(plannedIn(rows).length).toBe(PROJECTS * 2);
    expect(rows.length).toBe(30);
    expect((await screen.findByTestId("news-more")).textContent).toMatch(
      /^And [1-9]\d* more on the projects' own pages\.$/,
    );
  });

  it("does not cut a plan in its notice even when there are more of them than rows", async () => {
    const rows = await drawProjects(16);
    // 32 plans in their notice are more than the 30 rows: all 32 are listed, and none of the rest.
    expect(plannedIn(rows).length).toBe(32);
    expect(rows.length).toBe(32);
  });
});
