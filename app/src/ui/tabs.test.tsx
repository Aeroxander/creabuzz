// A tab with news carries a dot that a screen reader hears as "New"; one without carries nothing.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Tabs } from "./tabs";

afterEach(cleanup);

describe("a tab with news", () => {
  it("has a dot and says new to a screen reader, and only that tab", () => {
    render(
      <Tabs
        items={[
          { value: "a", label: "Updates", content: <p>one</p> },
          { value: "b", label: "Room", news: true, content: <p>two</p> },
        ]}
        label="Sections"
        onValueChange={() => undefined}
        value="a"
      />,
    );
    expect(screen.getByRole("tab", { name: "Room, new" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Updates" })).toBeTruthy();
    expect(screen.getByTestId("tab-b-new").getAttribute("aria-hidden")).toBe(
      "true",
    );
    expect(screen.queryByTestId("tab-a-new")).toBeNull();
  });
});
