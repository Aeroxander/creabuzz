// Sign-up's two ways in both end with a recovery key offered, and the plain one says what it risks before the press.
// The account made without a passkey lives in this browser's site data only: without the offer, clearing the site data
// lost the account for good and nothing on the page had said so (the risk line sat only under the passkey button).
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { wrap } from "../../../tests/helpers/money-harness";
import { SignUpPage } from "./SignUpPage";

const offered: string[] = [];

vi.mock(
  "../../lib/relay",
  async () => (await import("../../../tests/helpers/money-harness")).relayMock,
);
vi.mock("@creaton/core/account/recovery-offer", () => ({
  offerRecoveryKey: (input: { account: string }) => {
    offered.push(input.account);
  },
}));
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
  useNavigate: () => () => Promise.resolve(),
  Link: ({ children }: { children: ReactNode }) => (
    <a href="/week">{children}</a>
  ),
}));

afterEach(() => {
  cleanup();
  offered.length = 0;
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

  it("offers the recovery key after the plain press, exactly as the passkey path does", async () => {
    wrap(<SignUpPage />);
    // The press stays disabled until a name is typed: without this the click did nothing and the test proved nothing.
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Sam" },
    });
    fireEvent.click(screen.getByTestId("onboarding-create"));
    await waitFor(() => expect(offered).toEqual(["b".repeat(64)]));
  });
});
