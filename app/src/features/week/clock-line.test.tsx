// The weekly page's clock line reads the project's state at this device's own clock, not the state word the record was
// built with: a record built while the project was open still says "quiet" once its quiet time has passed.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { numbersFor } from "../../../tests/helpers/pot-harness";
import { ClockLine } from "./WeekPage";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the clock line of the weekly page", () => {
  it("says the project is quiet once its quiet time has passed, whatever state the record was built with", () => {
    const numbers = numbersFor();
    expect(numbers.quiet.quietFrom).not.toBeNull();
    vi.useFakeTimers();
    // The record said "active" when it was built; now is past the time it goes quiet.
    vi.setSystemTime(((numbers.quiet.quietFrom ?? 0) + 60) * 1000);
    const asBuilt = {
      ...numbers,
      quiet: { ...numbers.quiet, state: "active" as const },
    };
    render(
      <ul>
        <ClockLine numbers={asBuilt} />
      </ul>,
    );
    expect(screen.getByTestId("week-clock").textContent).toMatch(/Quiet since/);
  });

  it("says the allowance runs until the check-in's end while the project is open", () => {
    const numbers = numbersFor();
    vi.useFakeTimers();
    vi.setSystemTime(((numbers.quiet.quietFrom ?? 0) - 3_600) * 1000);
    render(
      <ul>
        <ClockLine numbers={numbers} />
      </ul>,
    );
    expect(screen.getByTestId("week-clock").textContent).not.toMatch(
      /Quiet since/,
    );
  });
});
