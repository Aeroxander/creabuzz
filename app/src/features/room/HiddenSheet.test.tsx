// The list of people a person has hidden: each has a press to show them again, an empty list says so, and a list that could
// not be opened says it is not known (someone hidden may show).
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { seriousViolations } from "../../../tests/helpers/axe-dom";
import { HiddenSheet } from "./HiddenSheet";

vi.mock("../../lib/profiles", () => ({
  useProfiles: () => ({ data: { [ANA]: { name: "Ana" } } }),
  nameOf: (_profiles: unknown, pubkey: string) =>
    pubkey === ANA ? "Ana" : "Someone",
}));

const ANA = "a".repeat(64);

afterEach(cleanup);

const sheet = (hidden: string[], unknown = false, onShowAgain = vi.fn()) =>
  render(
    <HiddenSheet
      hidden={hidden}
      onOpenChange={() => undefined}
      onShowAgain={onShowAgain}
      open
      pending={false}
      unknown={unknown}
    />,
  );

describe("the hidden people", () => {
  it("lists each person with a press to show them again, with no accessibility violations", async () => {
    const onShowAgain = vi.fn();
    sheet([ANA], false, onShowAgain);
    fireEvent.click(screen.getByRole("button", { name: /^Show again/ }));
    expect(onShowAgain).toHaveBeenCalledWith(ANA);
    expect(await seriousViolations(document.body)).toEqual([]);
  });

  it("says so when nobody is hidden", () => {
    sheet([]);
    expect(screen.getByText("You have not hidden anyone.")).toBeTruthy();
  });

  it("says the list could not be opened, rather than that it is empty", () => {
    sheet([], true);
    expect(screen.getByTestId("hidden-unknown").textContent).toMatch(
      /could not be opened/,
    );
    expect(screen.queryByText("You have not hidden anyone.")).toBeNull();
  });
});
