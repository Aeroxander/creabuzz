import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { currentStage, StageLine } from "./StageLine";

afterEach(cleanup);

function state(name: string) {
  return screen.getByTestId(`stage-${name}`).getAttribute("data-reached");
}

describe("StageLine", () => {
  it("never shows a money stage as done for a team that never raised money", () => {
    render(<StageLine investing stage={currentStage(1)} />);
    expect(state("solo")).toBe("done");
    expect(state("backed")).toBe("no");
    expect(state("team")).toBe("now");
    expect(state("council")).toBe("no");
    expect(screen.getByTestId("stage-backed").textContent).toContain(
      "not reached",
    );
  });

  it("marks Backed done only when money came in, from the server's numbers", () => {
    const money = { stage: "team" as const, raised: 2_500_000_000n };
    render(
      <StageLine investing money={money} stage={currentStage(0, money)} />,
    );
    expect(state("solo")).toBe("done");
    expect(state("backed")).toBe("done");
    expect(state("team")).toBe("now");
    expect(state("council")).toBe("no");
  });

  it("a backed project is Backed now; a later record stage wins over an earlier chain one", () => {
    expect(currentStage(0, { stage: "backed", raised: 1n })).toBe("Backed");
    expect(currentStage(1, { stage: "backed", raised: 1n })).toBe("Team");
    expect(currentStage(0, { stage: "solo", raised: 0n })).toBe("Solo");
  });

  it("without investing shows only Solo and Team", () => {
    render(<StageLine investing={false} stage={currentStage(0)} />);
    expect(state("solo")).toBe("now");
    expect(state("team")).toBe("no");
    expect(screen.queryByTestId("stage-backed")).toBeNull();
  });
});
