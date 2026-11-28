// One Start press survives sign-up: with no account, Start keeps the press and goes to sign-up for this page; coming back with an
// account sends the project that was typed, with no second press. A press that is stale, used, or left by someone who did not sign
// up sends nothing.
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { published, wrap } from "../../../tests/helpers/money-harness";
import { StartPage } from "./StartPage";
import {
  markStartAfterSignUp,
  takeStartAfterSignUp,
} from "./start-after-sign-up";

const FOUNDER = "f".repeat(64);
const navigate = vi.fn();
let pubkey: string | null;

vi.mock(
  "../../lib/relay",
  async () => (await import("../../../tests/helpers/money-harness")).relayMock,
);
vi.mock("../../lib/account", () => ({
  useAccount: () => ({ pubkey, locked: false }),
}));
vi.mock("@creaton/core/client/identity.ts", () => ({
  userPubkey: () => FOUNDER,
}));
vi.mock("@tanstack/react-router", async (actual) => ({
  ...(await actual<object>()),
  useNavigate: () => navigate,
  useRouterState: () => "/start",
}));

const answers = (name = "Night Sky Maps") => {
  fireEvent.change(screen.getByTestId("start-name"), {
    target: { value: name },
  });
  fireEvent.change(screen.getByTestId("start-goal"), {
    target: { value: "A map of the night sky that ten people use." },
  });
  fireEvent.change(screen.getByTestId("start-how"), {
    target: { value: "Ten people use it every week." },
  });
};

beforeEach(() => {
  navigate.mockReset();
  published.length = 0;
  sessionStorage.clear();
  pubkey = null;
});
afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

describe("a Start pressed before signing up", () => {
  it("goes to sign-up for this page with the answers kept, then sends them by itself once there is an account", async () => {
    wrap(<StartPage />);
    answers();
    fireEvent.click(screen.getByTestId("start-submit"));
    expect(navigate).toHaveBeenCalledWith({
      to: "/welcome",
      search: { next: "/start" },
    });
    expect(published).toEqual([]);

    // Signed up and back on Start: the page is new, the account is there, and nothing is pressed.
    cleanup();
    pubkey = FOUNDER;
    wrap(<StartPage />);
    expect((screen.getByTestId("start-name") as HTMLInputElement).value).toBe(
      "Night Sky Maps",
    );
    await waitFor(() => expect(published).toHaveLength(2));
    expect(navigate).toHaveBeenLastCalledWith(
      expect.objectContaining({ to: "/p/$ref" }),
    );
    // Used up: a visit to Start later does not send again.
    expect(sessionStorage.getItem("creaton.start.after-sign-up")).toBeNull();
  });

  it("sends nothing on its own when the person comes back without an account", async () => {
    wrap(<StartPage />);
    answers();
    fireEvent.click(screen.getByTestId("start-submit"));
    cleanup();
    wrap(<StartPage />);
    await new Promise((r) => setTimeout(r, 60));
    expect(published).toEqual([]);
    // The kept press was dropped: an account made later does not send a project nobody pressed Start for.
    expect(takeStartAfterSignUp(sessionStorage)).toBe(false);
  });

  it("does not send a project when the answers are missing, with or without an account", async () => {
    markStartAfterSignUp(sessionStorage);
    pubkey = FOUNDER;
    wrap(<StartPage />);
    await new Promise((r) => setTimeout(r, 60));
    expect(published).toEqual([]);
  });

  it("an account that is already there sends on the one press, as before", async () => {
    pubkey = FOUNDER;
    wrap(<StartPage />);
    answers();
    fireEvent.click(screen.getByTestId("start-submit"));
    await waitFor(() => expect(published).toHaveLength(2));
    expect(navigate).not.toHaveBeenCalledWith(
      expect.objectContaining({ to: "/welcome" }),
    );
  });
});

describe("the kept press", () => {
  it("is used once, and goes stale after ten minutes", () => {
    markStartAfterSignUp(sessionStorage, 1_000);
    expect(takeStartAfterSignUp(sessionStorage, 1_000 + 9 * 60_000)).toBe(true);
    expect(takeStartAfterSignUp(sessionStorage, 1_000 + 9 * 60_000)).toBe(
      false,
    );
    markStartAfterSignUp(sessionStorage, 1_000);
    expect(takeStartAfterSignUp(sessionStorage, 1_000 + 11 * 60_000)).toBe(
      false,
    );
    expect(takeStartAfterSignUp(null)).toBe(false);
  });
});
