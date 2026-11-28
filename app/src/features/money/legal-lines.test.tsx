// The two lines of the money design that are quoted word for word. What the screens DRAW is compared with the literals in
// `tests/helpers/legal-words.ts`, never with the app's own constants: reword either constant and this fails.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  BANNER_LITERAL,
  NOT_A_RETURN_LITERAL,
} from "../../../tests/helpers/legal-words";
import { numbersFor } from "../../../tests/helpers/pot-harness";
import { BannerText } from "../../app/MoneyBanner";
import { MoneyFacts } from "../pot/MoneyFacts";
import { NOT_A_RETURN, TAKE_OUT_BANNER } from "./copy";

afterEach(cleanup);

describe("the two quoted lines, byte for byte", () => {
  it("the banner on every page is the literal sentence", () => {
    render(<BannerText />);
    expect(screen.getByTestId("money-banner").textContent).toBe(BANNER_LITERAL);
    expect(TAKE_OUT_BANNER).toBe(BANNER_LITERAL);
  });

  it("the sentence under a live number is the literal sentence", () => {
    const numbers = numbersFor();
    render(<MoneyFacts now={numbers.builtAt + 100} numbers={numbers} />);
    expect(screen.getByText(NOT_A_RETURN_LITERAL).textContent).toBe(
      NOT_A_RETURN_LITERAL,
    );
    expect(NOT_A_RETURN).toBe(NOT_A_RETURN_LITERAL);
  });
});
