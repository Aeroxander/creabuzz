import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Avatar, hueOf, initialsOf } from "./avatar";
import { Card } from "./card";
import { EmptyState } from "./empty-state";
import { Field, TextArea } from "./field";
import { Sheet } from "./sheet";
import { Tabs } from "./tabs";
import { ToastProvider, useToast } from "./toast";

afterEach(cleanup);

describe("Field", () => {
  it("labels its box and points it at the hint", () => {
    render(<Field hint="Shown on your project" label="Name" />);
    const box = screen.getByLabelText("Name");
    expect(box.getAttribute("aria-describedby")).toBeTruthy();
    expect(screen.getByText("Shown on your project").id).toBe(
      box.getAttribute("aria-describedby"),
    );
    expect(box.getAttribute("aria-invalid")).toBeNull();
  });

  it("says what is wrong in place of the hint and marks the box", () => {
    render(<TextArea hint="Hint" label="Goal" problem="Too long" />);
    const box = screen.getByLabelText("Goal");
    expect(box.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("alert").textContent).toBe("Too long");
    expect(screen.queryByText("Hint")).toBeNull();
  });

  it("shows the count in fixed-width figures", () => {
    render(<Field count={{ used: 12, max: 80 }} label="Name" />);
    expect(screen.getByText("12/80").className).toContain("num");
  });
});

describe("Avatar", () => {
  it("is initials on a stable colour when there is no picture, hidden from screen readers", () => {
    render(<Avatar name="Fay Founder" pubkey={"ab".repeat(32)} />);
    const avatar = screen.getByTestId("avatar");
    expect(avatar.textContent).toBe("FF");
    expect(avatar.getAttribute("aria-hidden")).toBe("true");
    expect(hueOf("x")).toBe(hueOf("x"));
    expect(initialsOf("nia")).toBe("NI");
    expect(initialsOf("  ")).toBe("?");
  });
});

describe("Card and EmptyState", () => {
  it("uses the calm surface for reading", () => {
    render(<Card data-testid="c" tone="plain" />);
    expect(screen.getByTestId("c").className).toContain("plain");
  });

  it("names the empty list and offers one thing to do", () => {
    render(
      <EmptyState
        action={<button type="button">Start</button>}
        title="Nothing yet"
      >
        Say what you are making.
      </EmptyState>,
    );
    expect(screen.getByRole("heading", { name: "Nothing yet" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start" })).toBeTruthy();
  });
});

describe("Tabs", () => {
  it("switches content and marks a tab that is not built yet", () => {
    function Harness() {
      const [tab, setTab] = useState("a");
      return (
        <Tabs
          items={[
            { value: "a", label: "Updates", content: <p>updates here</p> },
            {
              value: "b",
              label: "Money",
              soon: true,
              content: <p>money here</p>,
            },
          ]}
          label="Project"
          onValueChange={setTab}
          value={tab}
        />
      );
    }
    render(<Harness />);
    expect(screen.getByText("updates here")).toBeTruthy();
    expect(screen.getByRole("tab", { name: /Money/ }).textContent).toContain(
      "soon",
    );
    const money = screen.getByRole("tab", { name: /Money/ });
    fireEvent.mouseDown(money, { button: 0 });
    expect(screen.getByText("money here")).toBeTruthy();
  });
});

describe("Sheet", () => {
  it("opens with its title as the dialog's name and closes from its button", () => {
    const changes: boolean[] = [];
    render(
      <Sheet
        onOpenChange={(open) => changes.push(open)}
        open
        title="Ask to join"
      >
        <p>body</p>
      </Sheet>,
    );
    expect(screen.getByRole("dialog", { name: "Ask to join" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(changes).toEqual([false]);
  });
});

describe("Toast", () => {
  it("announces a note and lets it go by itself", () => {
    vi.useFakeTimers();
    function Harness() {
      const toast = useToast();
      return (
        <button onClick={() => toast("Posted", "done")} type="button">
          go
        </button>
      );
    }
    render(
      <ToastProvider>
        <Harness />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText("go"));
    expect(screen.getByRole("status").textContent).toContain("Posted");
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(screen.queryByText("Posted")).toBeNull();
    vi.useRealTimers();
  });
});
