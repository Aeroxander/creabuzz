// After a reload a passkey account is known only once its signer has been registered (the signer loads lazily). A page that
// draws before then shows the person signed out, and a page that was told nothing when the signer arrived never corrects
// it: the unlock prompt did not show on some reloads. The app now waits for the registration before it draws, and the
// registration tells listeners when it is done.
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PUBKEY = "ab".repeat(32);

function storePasskey() {
  localStorage.setItem("buzz.passkey.credentialId", "Y3JlZA");
  localStorage.setItem("buzz.passkey.salt", "c2FsdA");
  localStorage.setItem("buzz.passkey.pubkey", PUBKEY);
  localStorage.setItem("buzz.passkey.mode", "prf");
}

/** Fresh copies of the modules that hold the signer and the account state, as a reload gives. */
async function afterReload() {
  vi.resetModules();
  const identity = await import("@creaton/core/account/passkey-identity.ts");
  const { useAccount } = await import("./account");
  function Probe() {
    const { pubkey, locked } = useAccount();
    return (
      <p data-testid="probe">
        {pubkey ? (locked ? "locked" : "open") : "nobody"}
      </p>
    );
  }
  return { identity, Probe };
}

describe("a passkey account after a reload", () => {
  beforeEach(() => {
    localStorage.clear();
    storePasskey();
  });
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("is nobody until the signer is registered, then locked, without any other event", async () => {
    const { identity, Probe } = await afterReload();
    render(<Probe />);
    expect(screen.getByTestId("probe").textContent).toBe("nobody");
    await act(async () => {
      await identity.registerPasskeySigner();
    });
    expect(screen.getByTestId("probe").textContent).toBe("locked");
  });

  it("is locked from the first draw when the signer was waited for", async () => {
    const { identity, Probe } = await afterReload();
    await identity.registerPasskeySigner();
    render(<Probe />);
    expect(screen.getByTestId("probe").textContent).toBe("locked");
  });
});
