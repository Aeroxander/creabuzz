// Sign-up's two ways in end at once, with no recovery-key sheet in between (the key is saved from You, on a press), and the
// plain one says what it risks before the press: the account made without a passkey lives in this browser's site data only,
// so clearing the site data loses it unless the key was saved.
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { wrap } from "../../../tests/helpers/money-harness";
import { SignUpPage } from "./SignUpPage";

const arrived: unknown[] = [];
const device = vi.hoisted(() => ({ passkeys: false }));

vi.mock("@creaton/core/account/platform-passkey", () => ({
  platformPasskeyAvailable: async () => device.passkeys,
}));

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
  device.passkeys = false;
  delete (window as { ethereum?: unknown }).ethereum;
});

describe("making an account", () => {
  it("says what an account without a passkey risks, before the press", async () => {
    wrap(<SignUpPage />);
    expect(await screen.findByTestId("onboarding-create")).toBeTruthy();
    expect(
      screen.getByText(/clearing this browser's data loses the account/),
    ).toBeTruthy();
  });

  it("goes straight on after the plain press: no recovery-key sheet, and no key drawn", async () => {
    wrap(<SignUpPage next="/start" />);
    // The press needs no name: only the boxes, and this policy has none.
    fireEvent.click(await screen.findByTestId("onboarding-create"));
    await waitFor(() => expect(arrived).toEqual([{ to: "/start" }]));
    expect(screen.queryByTestId("backup-sheet")).toBeNull();
    expect(screen.queryByTestId("backup-key")).toBeNull();
  });

  it("offers no plain account on a phone that makes passkeys and has no wallet, which could never send from it", async () => {
    device.passkeys = true;
    wrap(<SignUpPage />);
    await screen.findByTestId("onboarding-passkey");
    await waitFor(() =>
      expect(screen.queryByTestId("onboarding-create")).toBeNull(),
    );
  });

  it("offers the plain account again when this browser has a wallet", async () => {
    device.passkeys = true;
    (window as { ethereum?: unknown }).ethereum = { request: async () => null };
    wrap(<SignUpPage />);
    expect(await screen.findByTestId("onboarding-create")).toBeTruthy();
  });
});
