// Demo day's order: the same for everyone, different between seasons, and made of nothing a project can change after the
// season began (not money, not the time it entered).
import { describe, expect, it } from "vitest";
import { inSeasonOrder, orderValue } from "./season-order";

const coordinates = Array.from(
  { length: 60 },
  (_, i) => `37001:${i.toString(16).padStart(2, "0").repeat(32)}:p${i}`,
);

describe("demo day's order", () => {
  it("is stable: the same list in any order gives the same order, every time", () => {
    const first = inSeasonOrder(3, coordinates);
    expect(inSeasonOrder(3, [...coordinates].reverse())).toEqual(first);
    expect(
      inSeasonOrder(
        3,
        [...coordinates].sort(() => 0.5 - Math.random()),
      ),
    ).toEqual(first);
    expect(first).toHaveLength(coordinates.length);
    expect(new Set(first).size).toBe(coordinates.length);
  });

  it("differs between seasons, so nobody has top billing for good", () => {
    const one = inSeasonOrder(1, coordinates);
    const two = inSeasonOrder(2, coordinates);
    expect(two).not.toEqual(one);
    // The first place is not the same project in all of the first ten seasons.
    const firsts = new Set(
      Array.from(
        { length: 10 },
        (_, i) => inSeasonOrder(i + 1, coordinates)[0],
      ),
    );
    expect(firsts.size).toBeGreaterThan(3);
  });

  it("is a function of the season number and the project's address alone", () => {
    expect(orderValue(5, coordinates[0])).toBe(orderValue(5, coordinates[0]));
    expect(orderValue(5, coordinates[0])).not.toBe(
      orderValue(6, coordinates[0]),
    );
    expect(orderValue(5, coordinates[0])).not.toBe(
      orderValue(5, coordinates[1]),
    );
    // Taking the list apart does not move a project: the order of two does not depend on who else is there.
    const whole = inSeasonOrder(5, coordinates);
    const some = inSeasonOrder(5, [
      coordinates[7],
      coordinates[19],
      coordinates[41],
    ]);
    expect(whole.filter((c) => some.includes(c))).toEqual(some);
  });
});
