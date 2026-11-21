// The recovery key: never drawn, not even in part, until Reveal is pressed; saved to a file only on the Download press, named for
// the product and the account and holding only the key; never logged.
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const secret = Array.from(generateSecretKey(), (b) =>
  b.toString(16).padStart(2, "0"),
).join("");
const account = getPublicKey(
  Uint8Array.from(secret.match(/../g) ?? [], (p) => Number.parseInt(p, 16)),
);

vi.mock("@creaton/core/client/identity.ts", async (importActual) => ({
  ...(await importActual<object>()),
  existingUserPubkey: () => account,
  storedIdentityHex: () => secret,
}));

import { BACKED_UP_KEY, KEY_MASK, RecoveryKeyPanel } from "./RecoveryKeyPanel";

const logged: unknown[][] = [];
beforeEach(() => {
  logged.length = 0;
  localStorage.clear();
  for (const level of ["log", "info", "warn", "error", "debug"] as const)
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the recovery key panel", () => {
  it("shows no part of the key until Reveal is pressed, and hides it again", () => {
    render(<RecoveryKeyPanel onSaved={() => undefined} />);
    const box = screen.getByTestId("backup-key");
    expect(box.textContent).toBe(KEY_MASK);
    expect(document.body.textContent).not.toContain(secret.slice(0, 6));
    expect(document.body.textContent).not.toContain(secret.slice(-6));
    fireEvent.click(screen.getByTestId("backup-reveal"));
    expect(box.textContent).toBe(secret);
    fireEvent.click(screen.getByTestId("backup-reveal"));
    expect(box.textContent).toBe(KEY_MASK);
    expect(document.body.textContent).not.toContain(secret.slice(0, 6));
  });

  it("downloads a file named for the account holding only the key, on the Download press, without drawing the key", async () => {
    const blobs: Blob[] = [];
    URL.createObjectURL = (blob: Blob) => {
      blobs.push(blob);
      return "blob:key";
    };
    URL.revokeObjectURL = vi.fn();
    const clicked: { href: string; download: string }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push({ href: this.href, download: this.download });
    });
    render(<RecoveryKeyPanel onSaved={() => undefined} />);
    expect(blobs).toHaveLength(0);
    fireEvent.click(screen.getByTestId("backup-download"));
    expect(clicked).toHaveLength(1);
    expect(clicked[0].download).toBe(
      `creaton-recovery-key-${account.slice(0, 8)}.key`,
    );
    const saved = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(blobs[0]);
    });
    expect(saved).toBe(secret);
    // Saving it counts as keeping it, and the key is still not on the screen.
    expect(localStorage.getItem(BACKED_UP_KEY)).toBe(account);
    expect(screen.getByTestId("backup-key").textContent).toBe(KEY_MASK);
  });

  it("never logs the key, whatever is pressed", () => {
    URL.createObjectURL = () => "blob:key";
    URL.revokeObjectURL = () => undefined;
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
      () => undefined,
    );
    render(<RecoveryKeyPanel onSaved={() => undefined} />);
    fireEvent.click(screen.getByTestId("backup-reveal"));
    fireEvent.click(screen.getByTestId("backup-download"));
    fireEvent.click(screen.getByTestId("backup-done"));
    expect(JSON.stringify(logged)).not.toContain(secret);
  });
});
