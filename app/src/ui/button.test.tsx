import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Button, buttonClass } from "./button";
import { PRESSED_CLASS } from "./press";

function setReducedMotion(reduce: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: reduce && query.includes("prefers-reduced-motion: reduce"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => setReducedMotion(false));
afterEach(cleanup);

describe("Button classes", () => {
  it("primary 48px is the default; small and block add their class", () => {
    expect(buttonClass()).toBe("btn btn-primary");
    expect(buttonClass({ variant: "secondary", size: "sm", block: true })).toBe(
      "btn btn-secondary btn-sm btn-block",
    );
  });

  it("renders a type=button so it never submits a form by accident", () => {
    render(<Button>Start</Button>);
    expect(screen.getByRole("button", { name: "Start" })).toHaveProperty(
      "type",
      "button",
    );
  });
});

describe("the press", () => {
  it("holds the button down from pointer down until up", () => {
    render(<Button>Start</Button>);
    const button = screen.getByRole("button");
    fireEvent.pointerDown(button, { pointerType: "touch" });
    expect(button.classList.contains(PRESSED_CLASS)).toBe(true);
    fireEvent.pointerUp(button, { pointerType: "touch" });
    expect(button.classList.contains(PRESSED_CLASS)).toBe(false);
  });

  it("lets go when the finger slides off or the press is cancelled", () => {
    render(<Button>Start</Button>);
    const button = screen.getByRole("button");
    fireEvent.pointerDown(button, { pointerType: "touch" });
    fireEvent.pointerLeave(button);
    expect(button.classList.contains(PRESSED_CLASS)).toBe(false);
    fireEvent.pointerDown(button, { pointerType: "touch" });
    fireEvent.pointerCancel(button);
    expect(button.classList.contains(PRESSED_CLASS)).toBe(false);
  });

  it("presses on Space and Enter from a keyboard, and lets go on key up or blur", () => {
    render(<Button>Start</Button>);
    const button = screen.getByRole("button");
    fireEvent.keyDown(button, { key: " " });
    expect(button.classList.contains(PRESSED_CLASS)).toBe(true);
    fireEvent.keyUp(button, { key: " " });
    expect(button.classList.contains(PRESSED_CLASS)).toBe(false);
    fireEvent.keyDown(button, { key: "Enter" });
    expect(button.classList.contains(PRESSED_CLASS)).toBe(true);
    fireEvent.blur(button);
    expect(button.classList.contains(PRESSED_CLASS)).toBe(false);
    fireEvent.keyDown(button, { key: "a" });
    expect(button.classList.contains(PRESSED_CLASS)).toBe(false);
  });

  it("ignores the right mouse button", () => {
    render(<Button>Start</Button>);
    const button = screen.getByRole("button");
    fireEvent.pointerDown(button, { pointerType: "mouse", button: 2 });
    expect(button.classList.contains(PRESSED_CLASS)).toBe(false);
  });

  it("does not move under reduced motion", () => {
    setReducedMotion(true);
    render(<Button>Start</Button>);
    const button = screen.getByRole("button");
    fireEvent.pointerDown(button, { pointerType: "touch" });
    expect(button.classList.contains(PRESSED_CLASS)).toBe(false);
    fireEvent.keyDown(button, { key: "Enter" });
    expect(button.classList.contains(PRESSED_CLASS)).toBe(false);
  });

  it("does not move while disabled", () => {
    render(<Button disabled>Start</Button>);
    const button = screen.getByRole("button");
    fireEvent.pointerDown(button, { pointerType: "touch" });
    expect(button.classList.contains(PRESSED_CLASS)).toBe(false);
  });

  it("still runs the caller's own handlers, and a caller can opt out", () => {
    const seen: string[] = [];
    render(
      <Button
        onClick={() => seen.push("click")}
        onPointerDown={(event) => {
          seen.push("down");
          event.preventDefault();
        }}
      >
        Start
      </Button>,
    );
    const button = screen.getByRole("button");
    fireEvent.pointerDown(button, { pointerType: "touch" });
    act(() => button.click());
    expect(seen).toEqual(["down", "click"]);
    expect(button.classList.contains(PRESSED_CLASS)).toBe(false);
  });
});

describe("the stylesheet", () => {
  it("keeps option F's press values and turns them off under reduced motion", async () => {
    // Read from disk: vitest hands CSS imports over empty.
    const { readFileSync } = await import("node:fs");
    const css = readFileSync(`${process.cwd()}/src/styles/app.css`, "utf8");
    expect(css).toContain("transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)");
    expect(css).toContain("transition-duration: 0.07s");
    expect(css).toContain("transform: scale(0.965)");
    expect(css).toContain("linear-gradient(180deg, #63c88e, #47a873)");
    const reduced = css.slice(css.indexOf("prefers-reduced-motion: reduce"));
    expect(reduced).toMatch(
      /\.btn\.is-pressed[\s\S]*transition: none;\s*transform: none;/,
    );
  });
});

describe("ButtonLink", () => {
  async function renderLink() {
    const { ButtonLink } = await import("./button");
    const {
      createMemoryHistory,
      createRootRoute,
      createRouter,
      RouterProvider,
    } = await import("@tanstack/react-router");
    const rootRoute = createRootRoute({
      component: () => <ButtonLink to="/">Start a project</ButtonLink>,
    });
    const router = createRouter({
      routeTree: rootRoute,
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    render(<RouterProvider router={router} />);
    return screen.findByRole("link", { name: "Start a project" });
  }

  it("looks like the green button and presses like it, on touch and from the keyboard", async () => {
    const link = await renderLink();
    expect(link.className).toContain("btn btn-primary");
    fireEvent.pointerDown(link, { pointerType: "touch" });
    expect(link.classList.contains(PRESSED_CLASS)).toBe(true);
    fireEvent.pointerUp(link, { pointerType: "touch" });
    expect(link.classList.contains(PRESSED_CLASS)).toBe(false);
    fireEvent.keyDown(link, { key: "Enter" });
    expect(link.classList.contains(PRESSED_CLASS)).toBe(true);
    fireEvent.keyUp(link, { key: "Enter" });
    expect(link.classList.contains(PRESSED_CLASS)).toBe(false);
  });

  it("holds still under reduced motion", async () => {
    setReducedMotion(true);
    const link = await renderLink();
    fireEvent.pointerDown(link, { pointerType: "touch" });
    expect(link.classList.contains(PRESSED_CLASS)).toBe(false);
  });
});
