// Sign-up's two ways in end at once, with no recovery-key sheet in between (the key is saved from You, on a press), and the
// plain one says what it risks before the press: the account made without a passkey lives in this browser's site data only,
// so clearing the site data loses it unless the key was saved.
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { wrap } from "../../../tests/helpers/money-harness";
import { SignUpPage } from "./SignUpPage";

const arrived: unknown[] = [];

vi.mock(
  "../../lib/relay",
  async () => (await import("../../../tests/helpers/money-harness")).relayMock,
);
vi.mock("@creaton/core/client/identity", () => ({
  getOrCreateIdentity: () => ({}),
  userPubkey: () => "b".repeat(64),
  importIdentity: () => {},
}));
vi.mock("@creaton/core/account/policy-acceptance", () => ({
  recordSignUpTerms: () => {},
}));
vi.mock("../../lib/profile-save", () => ({ saveName: async () => {} }));
vi.mock("../../lib/account", () => ({ announceAccountChange: () => {} }));
vi.mock("./use-join-policy", () => ({
  useJoinPolicy: () => ({ state: { status: "none" }, reload: () => {} }),
}));
vi.mock("@tanstack/react-router", async (actual) => ({
  ...(await actual<object>()),
  useNavigate: () => (to: unknown) => {
    arrived.push(to);
    return Promise.resolve();
  },
  Link: ({ children }: { children: ReactNode }) => (
    <a href="/week">{children}</a>
  ),
}));

afterEach(() => {
  cleanup();
  arrived.length = 0;
});

describe("making an account", () => {
  it("says what an account without a passkey risks, before the press", () => {
    wrap(<SignUpPage />);
    expect(screen.getByTestId("onboarding-create")).toBeTruthy();
    expect(screen.getByText(/kept in this browser only/)).toBeTruthy();
    expect(
      screen.getByText(/only your recovery key can bring it back/),
    ).toBeTruthy();
  });

  it("goes straight on after the plain press: no recovery-key sheet, and no key drawn", async () => {
    wrap(<SignUpPage next="/start" />);
    // The press stays disabled until a name is typed: without this the click did nothing and the test proved nothing.
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Sam" },
    });
    fireEvent.click(screen.getByTestId("onboarding-create"));
    await waitFor(() => expect(arrived).toEqual([{ to: "/start" }]));
    expect(screen.queryByTestId("backup-sheet")).toBeNull();
    expect(screen.queryByTestId("backup-key")).toBeNull();
  });

  it("says where the recovery key is saved, not that it is about to be offered", () => {
    wrap(<SignUpPage />);
    expect(screen.getAllByText(/save it from You|save from You/).length).toBe(
      2,
    );
    expect(document.body.textContent).not.toMatch(/save it when it is offered/);
  });
});
