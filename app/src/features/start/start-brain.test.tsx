import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wrap } from "../../../tests/helpers/money-harness";
import { StartPage } from "./StartPage";

const FOUNDER = "b".repeat(64);
const navigated: unknown[] = [];
const published: { kind: number }[] = [];

vi.mock("@creaton/core/client/identity.ts", () => ({
  userPubkey: () => FOUNDER,
}));
vi.mock("../../lib/relay", () => ({
  read: async () => [],
  publishAsUser: async (template: { kind: number }) => {
    published.push(template);
    return template;
  },
}));
vi.mock("../../lib/use-require-account", () => ({
  useRequireAccount: () => (action: () => void) => {
    action();
    return true;
  },
}));
vi.mock("../../app/BackHeader", () => ({
  ScreenHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
}));
vi.mock("@tanstack/react-router", async (actual) => ({
  ...(await actual<object>()),
  Link: ({ children }: { children: ReactNode }) => <a href="/p">{children}</a>,
  useNavigate: () => (to: unknown) => {
    navigated.push(to);
  },
}));

function fill() {
  fireEvent.change(screen.getByTestId("start-name"), {
    target: { value: "Lantern" },
  });
  fireEvent.change(screen.getByTestId("start-goal"), {
    target: { value: "A first version that ten people use." },
  });
  fireEvent.change(screen.getByTestId("start-how"), {
    target: { value: "Ten people use it every week." },
  });
}

beforeEach(() => {
  navigated.length = 0;
  published.length = 0;
  window.sessionStorage.clear();
});
afterEach(cleanup);

describe("Start offers the project brain", () => {
  it("is one optional line: not checked to begin with, with what it does in plain words", () => {
    wrap(<StartPage />);
    const box = screen.getByRole("checkbox", {
      name: "Also keep a project brain",
    });
    expect((box as HTMLInputElement).checked).toBe(false);
    expect(box.getAttribute("aria-describedby")).toBeTruthy();
    expect(
      document.getElementById(box.getAttribute("aria-describedby") ?? "")
        ?.textContent,
    ).toContain("helper reads before it drafts anything");
    // Three answers, still: the offer is not a text box.
    expect(screen.getAllByRole("textbox")).toHaveLength(3);
  });

  it("never blocks Start: skipping it (the default) starts the project and goes to its page as before", async () => {
    wrap(<StartPage />);
    fill();
    fireEvent.click(screen.getByTestId("start-submit"));
    await waitFor(() => expect(navigated).toHaveLength(1));
    expect(published.length).toBeGreaterThanOrEqual(1);
    expect(navigated[0]).not.toHaveProperty("search");
  });

  it("a yes starts the project all the same and opens the set-up steps on it", async () => {
    wrap(<StartPage />);
    fill();
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Also keep a project brain" }),
    );
    fireEvent.click(screen.getByTestId("start-submit"));
    await waitFor(() => expect(navigated).toHaveLength(1));
    expect(navigated[0]).toMatchObject({ search: { brain: "setup" } });
  });

  it("keeps the yes for this visit, as it keeps the answers", () => {
    wrap(<StartPage />);
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Also keep a project brain" }),
    );
    cleanup();
    wrap(<StartPage />);
    expect(
      (
        screen.getByRole("checkbox", {
          name: "Also keep a project brain",
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
  });

  it("does not hold Start back when nothing was answered: the three answers are still what is asked for", () => {
    wrap(<StartPage />);
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Also keep a project brain" }),
    );
    fireEvent.click(screen.getByTestId("start-submit"));
    expect(navigated).toHaveLength(0);
    expect(screen.getByText("Give the project a name.")).toBeTruthy();
  });
});
