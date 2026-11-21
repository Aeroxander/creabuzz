// Where focus goes when a sheet closes: back to the button that opened it, and, when that button is no longer on the page (or is
// turned off), to the page's heading, never to nothing. Escape and the Close button are both paths a person takes.
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { Sheet } from "./sheet";

afterEach(cleanup);

function Page({
  vanishes = false,
  disables = false,
}: {
  vanishes?: boolean;
  disables?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [gone, setGone] = useState(false);
  const [off, setOff] = useState(false);
  return (
    <main>
      <h1>Lantern</h1>
      {gone ? null : (
        <button disabled={off} onClick={() => setOpen(true)} type="button">
          Take out
        </button>
      )}
      <Sheet onOpenChange={setOpen} open={open} title="Taking out">
        <button
          onClick={() => {
            if (vanishes) setGone(true);
            if (disables) setOff(true);
            setOpen(false);
          }}
          type="button"
        >
          Confirm
        </button>
      </Sheet>
    </main>
  );
}

const closeWith = async (how: "confirm" | "escape" | "close") => {
  // A press takes focus, as it does in a browser.
  screen.getByRole("button", { name: "Take out" }).focus();
  fireEvent.click(screen.getByRole("button", { name: "Take out" }));
  await screen.findByRole("dialog");
  await act(async () => {
    if (how === "confirm")
      fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    else if (how === "close")
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
    else fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
};

describe("focus after a sheet closes", () => {
  for (const how of ["confirm", "escape", "close"] as const)
    it(`goes back to the button that opened it (${how})`, async () => {
      render(<Page />);
      await closeWith(how);
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Take out" }),
      );
    });

  it("goes to the page's heading when the opening press took no focus at all (Safari)", async () => {
    render(<Page />);
    fireEvent.click(screen.getByRole("button", { name: "Take out" }));
    await screen.findByRole("dialog");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { name: "Lantern" }),
    );
  });

  it("goes to the page's heading when the button that opened it left the page", async () => {
    render(<Page vanishes />);
    await closeWith("confirm");
    expect(screen.queryByRole("button", { name: "Take out" })).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { name: "Lantern" }),
    );
  });

  it("goes to the page's heading when the button that opened it is turned off", async () => {
    render(<Page disables />);
    await closeWith("confirm");
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { name: "Lantern" }),
    );
  });
});
