// A locked passkey account is told to unlock inside the sheets that cover the bar at the top (the recovery key, the writing
// box), and the press is right there: the person never has to close the sheet to find it.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const unlock = vi.hoisted(() => ({ calls: 0, fail: false }));
vi.mock("@creaton/core/account/passkey-identity.ts", async (importActual) => ({
  ...(await importActual<object>()),
  hasPasskeyIdentity: () => true,
  passkeyMode: () => "prf",
  exportPasskeyNsec: () => null,
  signInPasskeyIdentity: async () => {
    unlock.calls += 1;
    if (unlock.fail) throw new Error("cancelled");
  },
}));
vi.mock("@creaton/core/client/identity.ts", async (importActual) => ({
  ...(await importActual<object>()),
  existingUserPubkey: () => "a".repeat(64),
  storedIdentityHex: () => null,
}));

import { RecoveryKeyPanel } from "./RecoveryKeyPanel";

afterEach(() => {
  cleanup();
  unlock.calls = 0;
  unlock.fail = false;
});

describe("Unlock inside the recovery key sheet", () => {
  it("a locked account sees the sentence and the Unlock press, and the press asks for the passkey", () => {
    render(<RecoveryKeyPanel onSaved={() => undefined} />);
    expect(screen.getByTestId("backup-unavailable").textContent).toMatch(
      /^Unlock with your passkey to show your recovery key\.$/,
    );
    fireEvent.click(screen.getByTestId("backup-unlock"));
    expect(unlock.calls).toBe(1);
  });

  it("a passkey that is refused says so in words and keeps the press", async () => {
    unlock.fail = true;
    render(<RecoveryKeyPanel onSaved={() => undefined} />);
    fireEvent.click(screen.getByTestId("backup-unlock"));
    expect(
      (await screen.findByRole("alert")).textContent?.length,
    ).toBeGreaterThan(10);
    expect(screen.getByTestId("backup-unlock")).toBeTruthy();
  });
});
