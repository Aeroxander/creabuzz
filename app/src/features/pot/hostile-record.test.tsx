// A record that parses but is extreme must not show NaN, Infinity, Invalid Date or a
// crash on the Money tab.
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { cleanup } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SERVER, wrap } from "../../../tests/helpers/money-harness";
import { installPotChain } from "../../../tests/helpers/pot-chain";
import {
  BACKER_EVM,
  backerAnswers,
  nameTheNetwork,
  numbersFor,
} from "../../../tests/helpers/pot-harness";
import { ProjectMoney } from "./ProjectMoney";

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
}));

const BIG = (2n ** 128n - 1n).toString();
const patches: Record<
  string,
  // biome-ignore lint/suspicious/noExplicitAny: a test patches a parsed record by path
  (c: Record<string, any>) => void
> = {
  hugePot: (c) => {
    c.money.pot = BIG;
    c.value.leaveValue = BIG;
  },
  hugeBox: (c) => {
    c.allowance.box = BIG;
    c.allowance.boxCap = BIG;
  },
  maxTime: (c) => {
    c.clock.lastCheckIn = 2 ** 40;
    c.clock.activeUntil = 2 ** 40;
  },
  rate100: (c) => {
    c.allowance.ratePpm = 1_000_000;
  },
  tinyUnit: (c) => {
    c.unit = 1;
  },
  minJoin0: (c) => {
    c.limits.minJoin = "0";
  },
  fee10000: (c) => {
    c.fee.bps = 10000;
  },
  noBackers: (c) => {
    c.shares.backers = "0";
    c.shares.teamCounted = "0";
  },
};

beforeEach(() => {
  applyServerSettings({ investing: true, self: SERVER });
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  applyServerSettings(null);
});

describe("extreme records", () => {
  for (const [name, patch] of Object.entries(patches)) {
    it(`${name} shows no NaN, Infinity or Invalid Date`, () => {
      let n: ReturnType<typeof numbersFor> | null = null;
      try {
        n = numbersFor(patch as never);
      } catch {
        n = null;
      }
      if (!n) return; // refused as unreadable: fine
      nameTheNetwork(n);
      installPotChain({
        account: BACKER_EVM,
        answers: backerAnswers(n) as never,
      });
      wrap(
        <ProjectMoney
          chainKey={n.key}
          error={undefined}
          loading={false}
          now={n.builtAt + 100}
          numbers={n}
          onRetry={() => undefined}
          profiles={undefined}
          projectName="Lantern"
          team={[]}
        />,
      );
      const text = document.body.textContent ?? "";
      expect(text).not.toMatch(/NaN|Infinity|Invalid Date|undefined|\[object/);
    });
  }
});
