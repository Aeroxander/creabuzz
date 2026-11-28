// The sentences of the top of a project's page, made from the example the server's own code wrote. Every figure below is read
// from the parsed record and never typed.
import { describe, expect, it } from "vitest";
import { parsedExample } from "../../../tests/helpers/numbers-v2-parse";
import { smallDollarsText } from "../money/copy";
import { timeText } from "../money/numbers";
import { asOfLine, takeOutNowLine } from "./project-top-words";

describe("the money line of a project's top", () => {
  it("gives what one Share gets from the record's own figure", () => {
    const n = parsedExample();
    expect(takeOutNowLine(n)).toBe(
      `Taking out now gives ${smallDollarsText(n.value.leaveValue)} per Share.`,
    );
  });

  it("says when the numbers are as of", () => {
    const n = parsedExample();
    expect(asOfLine(n)).toBe(`Numbers as of ${timeText(n.asOf.time)}`);
  });
});
