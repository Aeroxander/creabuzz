// A project whose page names a launch the server never signs a record for is asked about at first every few seconds, then
// less often, and then not at all: a poll must end (the reload asks again), never run for as long as a page is open.
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { act, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COORDINATE,
  projectEvent,
  SERVER,
  wrap,
} from "../../../tests/helpers/money-harness";
import { chainIdentityV2 } from "../../../tests/helpers/numbers-v2-fixture";
import { parseProject } from "../project/project-record";
import { lookAgainEvery, useProjectNumbers } from "./use-money";

const reads: number[] = [];
vi.mock("../../lib/relay", () => ({
  read: async () => {
    reads.push(Date.now());
    return [];
  },
}));

function Probe({
  project,
}: {
  project: NonNullable<ReturnType<typeof parseProject>>;
}) {
  useProjectNumbers(project);
  return null;
}

describe("looking again for a record that is not there", () => {
  beforeEach(() => {
    reads.length = 0;
    vi.useFakeTimers();
    applyServerSettings({ investing: true, self: SERVER });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    applyServerSettings(null);
  });

  it("asks soon, then less often, then stops", () => {
    expect(lookAgainEvery(0)).toBe(5_000);
    expect(lookAgainEvery(29_999)).toBe(5_000);
    expect(lookAgainEvery(30_000)).toBe(15_000);
    expect(lookAgainEvery(119_999)).toBe(15_000);
    expect(lookAgainEvery(120_000)).toBe(false);
  });

  it("is a bounded number of reads in an hour, not one every 5 seconds", async () => {
    const [, author, id] = COORDINATE.split(":");
    const event = projectEvent({
      author,
      id,
      name: "Lantern",
      chainKey: chainIdentityV2(COORDINATE).key,
    });
    const project = parseProject(event as never);
    if (!project) throw new Error("the project record did not parse");
    wrap(<Probe project={project} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    });
    // 720 reads at one every 5 seconds; here the first ~2 minutes only.
    expect(reads.length).toBeGreaterThan(5);
    expect(reads.length).toBeLessThan(30);
    expect(Math.max(...reads) - Math.min(...reads)).toBeLessThan(130_000);
  });
});
