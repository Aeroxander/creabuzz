// A published agreement file whose "version" is missing or not a whole number reads as "does not match" (the page says
// so); it never throws while rendering.
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { fingerprintOf } from "@creaton/core/launchpad/earlier-claim.ts";
import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SERVER, serve, wrap } from "../../../tests/helpers/money-harness";
import { type ClaimList, useAgreementText } from "./use-earlier";

vi.mock(
  "../../lib/relay",
  async () => (await import("../../../tests/helpers/money-harness")).relayMock,
);

const TEXT = "Made-up agreement text for tests.";
const SUMMARY = "Made-up one-line summary for tests.";
const LIST: ClaimList = {
  textHash: fingerprintOf(TEXT),
  summaryHash: fingerprintOf(SUMMARY),
  textVersion: 1n,
  key: `0x${"ab".repeat(32)}`,
  closed: false,
  closeAt: 0n,
  funded: true,
  entryCount: 21n,
};

function Probe() {
  return <p data-testid="state">{useAgreementText(LIST).kind}</p>;
}

beforeEach(() => {
  applyServerSettings({ investing: true, self: SERVER });
  serve([]);
});
afterEach(() => {
  cleanup();
  applyServerSettings(null);
  vi.unstubAllGlobals();
});

describe("the agreement file is malformed", () => {
  it("control: a well-formed file is shown", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ version: 1, text: TEXT, summary: SUMMARY }),
      })),
    );
    wrap(<Probe />);
    await waitFor(() =>
      expect(screen.getByTestId("state").textContent).toBe("ok"),
    );
  });

  for (const [name, body] of [
    ["no version", { text: TEXT, summary: SUMMARY }],
    ["a fractional version", { version: 1.5, text: TEXT, summary: SUMMARY }],
  ] as const) {
    it(`says it does not match (never crashes) when the file has ${name}`, async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({ ok: true, json: async () => body })),
      );
      wrap(<Probe />);
      await waitFor(() =>
        expect(screen.getByTestId("state").textContent).not.toBe("checking"),
      );
      expect(screen.getByTestId("state").textContent).toBe("moved");
    });
  }
});
