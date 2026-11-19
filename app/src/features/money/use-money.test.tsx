import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COORDINATE,
  NOW,
  projectEvent,
  recordV2,
  SERVER,
  serve,
  wrap,
} from "../../../tests/helpers/money-harness";
import {
  chainIdentityV2,
  numbersV2Content,
} from "../../../tests/helpers/numbers-v2-fixture";
import { parseProject, type RecordEvent } from "../project/project-record";
import { matchNumbers, useRecentNumbers } from "./use-money";

vi.mock(
  "../../lib/relay",
  async () => (await import("../../../tests/helpers/money-harness")).relayMock,
);

const [, FOUNDER, ID] = COORDINATE.split(":");
const OTHER = `37001:${"c".repeat(64)}:other`;

function project(coordinate: string) {
  const [, author, id] = coordinate.split(":");
  const parsed = parseProject(
    projectEvent({
      author: author as string,
      id: id as string,
      name: "Lantern",
      chainKey: chainIdentityV2(coordinate).key,
    }) as RecordEvent,
  );
  if (!parsed) throw new Error("not a project");
  return parsed;
}

beforeEach(() => applyServerSettings({ investing: true, self: SERVER }));
afterEach(() => {
  cleanup();
  applyServerSettings(null);
});

describe("recent numbers", () => {
  it("each project gets the record that is its own, and only that", () => {
    const mine = recordV2(
      numbersV2Content({ coordinate: COORDINATE, now: NOW }),
    );
    // A record for another project, and a version 1 record: neither is anyone's numbers here.
    const theirs = recordV2(
      numbersV2Content({ coordinate: OTHER, now: NOW }),
      OTHER,
    );
    const old = {
      ...recordV2({ version: 1 }, `37001:${"d".repeat(64)}:old`),
    };
    const matched = matchNumbers(
      [project(COORDINATE), project(OTHER)],
      [mine, theirs, old],
    );
    expect(matched.map((m) => m.project.coordinate)).toEqual([
      COORDINATE,
      OTHER,
    ]);
    expect(matched[0]?.numbers.version).toBe(2);
    expect(matchNumbers([project(COORDINATE)], [theirs])).toEqual([]);
    expect(FOUNDER && ID).toBeTruthy();
  });

  it("reads the server's newest records, one per project, and says when it read them all", async () => {
    serve([
      recordV2(
        numbersV2Content({ coordinate: COORDINATE, now: NOW }),
        COORDINATE,
        NOW - 50,
      ),
      recordV2(
        numbersV2Content({ coordinate: COORDINATE, now: NOW }),
        COORDINATE,
        NOW,
      ),
    ]);
    function Probe() {
      const recent = useRecentNumbers();
      return (
        <p data-testid="probe">
          {recent.data
            ? `${recent.data.events.length} ${recent.data.complete}`
            : "reading"}
        </p>
      );
    }
    wrap(<Probe />);
    await waitFor(() =>
      expect(screen.getByTestId("probe").textContent).toBe("1 true"),
    );
  });
});
