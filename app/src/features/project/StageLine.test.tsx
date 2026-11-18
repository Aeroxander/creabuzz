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

  it("without investing shows only Solo and Team", () => {
    render(<StageLine investing={false} stage={currentStage(0)} />);
    expect(state("solo")).toBe("now");
    expect(state("team")).toBe("no");
    expect(screen.queryByTestId("stage-backed")).toBeNull();
  });
});
