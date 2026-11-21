// The project page's card about the holder pause: when it shows, what each state says, what it never says, and what an older
// or unreadable record leads to. Records are the example changed through the app's real parser.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  numbersWithPause,
  withPause,
} from "../../../tests/helpers/pause-harness";
import { numbersFor, S } from "../../../tests/helpers/pot-harness";
import { PauseCard } from "./PauseCard";

afterEach(cleanup);

const show = (
  numbers: ReturnType<typeof numbersWithPause>,
  holds = false,
  later = 100,
) => {
  if (!numbers.pause) throw new Error("the record has no pause");
  return render(
    <PauseCard
      holds={holds}
      now={numbers.builtAt + later}
      numbers={numbers}
      pause={numbers.pause}
    />,
  );
};

describe("the pause card", () => {
  it("with nothing parked and nobody holding, shows one plain line and no card", () => {
    show(numbersWithPause({ parked: 0n }));
    expect(screen.queryByTestId("pause-card")).toBeNull();
    expect(screen.getByTestId("pause-info").textContent).toBe(
      "Holders can pause the team's spending: a third of Shares parked.",
    );
  });

  it("a holder sees the card under the line: the share parked and the line needed, with a meter that says its value", () => {
    const numbers = numbersWithPause({ parked: 1_000n * S });
    show(numbers, true);
    expect(screen.getByRole("region").textContent).toMatch(
      /Holders can pause the team's spending\./,
    );
    expect(screen.getByTestId("pause-intro").textContent).toMatch(
      /^If a third of all backers' Shares are parked, the team's daily allowance and new task plans pause one day later, for as long as that much stays parked\. Parking does not move anyone's money\. You can take your money out any time\.$/,
    );
    expect(screen.getByTestId("pause-state-under").textContent).toMatch(
      /of backers' Shares are parked\. A third is needed\.$/,
    );
    const meter = screen.getByRole("meter");
    expect(meter.getAttribute("aria-valuetext")).toMatch(
      /parked, a third needed$/,
    );
    expect(screen.getByText(/More Shares joining can lower the parked share/));
  });

  it("an armed line says when the pause starts, and never says stopped", () => {
    const numbers = numbersWithPause({
      parked: 200_000n * S,
      armedAgo: 3_600,
    });
    expect(numbers.pause?.paused).toBe(false);
    show(numbers);
    const text = screen.getByTestId("pause-state-armed").textContent ?? "";
    expect(text).toMatch(
      /^A third is parked\. The team's allowance and new task plans pause on .* if it stays there\.$/,
    );
    expect(text).not.toMatch(/Paused/);
  });

  it("a paused project says since when, that Take out is not held, and what ends it", () => {
    const numbers = numbersWithPause({
      parked: 200_000n * S,
      armedAgo: 2 * 86_400,
    });
    expect(numbers.pause?.paused).toBe(true);
    show(numbers);
    const text = screen.getByTestId("pause-state-paused").textContent ?? "";
    expect(text).toMatch(/^Paused since /);
    expect(text).toMatch(/Everyone can still take their money out\./);
    expect(text).toMatch(/It ends when .* fewer Shares are parked\./);
  });

  it("says the same things for a line that is not a third, without the words 'a third', and for a short day", () => {
    const numbers = numbersFor((c) =>
      withPause(c, { parked: 100n * S, divisor: 5 }),
    );
    // a short day on a demo network: the unit is 7 times the day
    show(numbers, true);
    expect(screen.getByRole("region").textContent).not.toMatch(/third/);
    expect(screen.getByTestId("pause-intro").textContent).toMatch(
      /If 1 in 5 of all backers' Shares are parked/,
    );
  });

  it("a record older than its promise says so and makes no claim about the pause", () => {
    const numbers = numbersWithPause({
      parked: 200_000n * S,
      armedAgo: 2 * 86_400,
    });
    show(numbers, true, 10 * numbers.refreshEverySecs);
    expect(screen.getByTestId("pause-old").textContent).toMatch(
      /older than the server promises/,
    );
    expect(screen.queryByTestId("pause-state-paused")).toBeNull();
    expect(screen.queryByRole("meter")).toBeNull();
  });
});
