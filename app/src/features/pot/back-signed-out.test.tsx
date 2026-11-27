// A visitor with no account backs a project: the Back box is there, Back keeps the amount and goes to sign-up with the project
// as `next`, and coming back with an account opens the sheet with that amount. A wallet browser keeps its own way.
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SERVER, wrap } from "../../../tests/helpers/money-harness";
import { nameTheNetwork, numbersFor } from "../../../tests/helpers/pot-harness";
import type { MoneyWallet } from "../money/wallet";
import { markBackAfterSignUp, takeBackAfterSignUp } from "./back-after-sign-up";
import { BackCard } from "./BackCard";

const ACCOUNT = `0x${"11".repeat(20)}`;
const navigate = vi.fn();
let current: MoneyWallet;
let pubkey: string | null;

vi.mock("../money/sender", async (original) => ({
  ...(await original<typeof import("../money/sender")>()),
  useSender: () => current,
}));
vi.mock("../../lib/relay", () => ({
  read: async () => [],
  publish: async () => undefined,
}));
vi.mock("../../lib/account", () => ({
  useAccount: () => ({ pubkey, locked: false }),
}));
vi.mock("@tanstack/react-router", async (actual) => ({
  ...(await actual<object>()),
  Link: ({ children }: { children: ReactNode }) => <a href="/p">{children}</a>,
  useNavigate: () => navigate,
  useLocation: () => ({ pathname: "/p/lantern-aaaa" }),
}));

const numbers = numbersFor();
const NOW = numbers.builtAt + 100;

/** A phone with no wallet app: the passkey is the sender, and it cannot send until an account is made here. */
function phone(hasPasskey: boolean): MoneyWallet {
  return {
    kind: "passkey",
    availability: () =>
      hasPasskey ? { ok: true } : { ok: false, reason: "no-passkey" },
    capabilities: {
      signsMessages: true,
      atomicBatch: true,
      feeSponsored: true,
    },
    isAvailable: () => hasPasskey,
    connectedAddress: async () => (hasPasskey ? ACCOUNT : null),
    getAddress: async () => ACCOUNT,
    chainId: async () => numbers.chainId,
    readCall: async () => "0x",
  } as unknown as MoneyWallet;
}

function box() {
  wrap(<BackCard now={NOW} numbers={numbers} projectName="Lantern" />);
}

beforeEach(() => {
  applyServerSettings({ investing: true, self: SERVER });
  nameTheNetwork(numbers);
  navigate.mockReset();
  sessionStorage.clear();
  pubkey = null;
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  localStorage.clear();
  sessionStorage.clear();
  applyServerSettings(null);
});

describe("Back with no account", () => {
  it("shows the box, and Back keeps the amount and goes to sign-up for this project", async () => {
    current = phone(false);
    box();
    fireEvent.change(await screen.findByLabelText("How many dollars?"), {
      target: { value: "25" },
    });
    fireEvent.click(screen.getByTestId("backing-review"));
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith({
      to: "/welcome",
      search: { next: "/p/lantern-aaaa" },
    });
    expect(takeBackAfterSignUp(sessionStorage, numbers.key)).toBe("25");
    // No dead end: the sentence that sent the person to another browser is not on the page.
    expect(screen.queryByTestId("pot-no-wallet")).toBeNull();
  });

  it("does not leave for sign-up on an amount that is not one, and says what is wrong", async () => {
    current = phone(false);
    box();
    fireEvent.change(await screen.findByLabelText("How many dollars?"), {
      target: { value: "lots" },
    });
    fireEvent.click(screen.getByTestId("backing-review"));
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByText(/Write a number of dollars/)).toBeTruthy();
    expect(takeBackAfterSignUp(sessionStorage, numbers.key)).toBeNull();
  });

  it("leaves a signed-in person without a passkey here on the sentence, as before", async () => {
    pubkey = "b".repeat(64);
    current = phone(false);
    box();
    expect((await screen.findByTestId("pot-no-wallet")).textContent).toMatch(
      /does not hold the passkey/,
    );
    expect(screen.queryByTestId("backing-review")).toBeNull();
  });

  it("leaves a wallet browser on its own way: connect, with nothing kept", async () => {
    current = {
      ...phone(true),
      kind: "wallet",
      availability: () => ({ ok: true }),
      connectedAddress: async () => null,
    } as unknown as MoneyWallet;
    box();
    expect((await screen.findByTestId("pot-connect")).textContent).toMatch(
      /Connect your wallet to back this project/,
    );
    expect(screen.queryByTestId("backing-review")).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe("coming back with an account", () => {
  it("opens the sheet with the amount kept for this project", async () => {
    pubkey = "b".repeat(64);
    current = phone(true);
    markBackAfterSignUp(sessionStorage, numbers.key, "25");
    box();
    const field = (await screen.findByLabelText(
      "How many dollars?",
    )) as HTMLInputElement;
    await waitFor(() => expect(field.value).toBe("25"));
    await waitFor(() => expect(screen.getByTestId("back-sheet")).toBeTruthy());
    // Used up: a second visit starts empty.
    expect(takeBackAfterSignUp(sessionStorage, numbers.key)).toBeNull();
  });

  it("starts empty when nothing was kept", async () => {
    pubkey = "b".repeat(64);
    current = phone(true);
    box();
    const field = (await screen.findByLabelText(
      "How many dollars?",
    )) as HTMLInputElement;
    expect(field.value).toBe("");
    expect(screen.queryByTestId("back-sheet")).toBeNull();
  });
});

describe("the amount kept while signing up", () => {
  it("is for one project, is used up once, and goes stale after ten minutes", () => {
    markBackAfterSignUp(sessionStorage, "project-a", "5", 1_000);
    expect(takeBackAfterSignUp(sessionStorage, "project-b", 1_000)).toBeNull();
    markBackAfterSignUp(sessionStorage, "project-a", "5", 1_000);
    expect(takeBackAfterSignUp(sessionStorage, "project-a", 1_000)).toBe("5");
    expect(takeBackAfterSignUp(sessionStorage, "project-a", 1_000)).toBeNull();
    markBackAfterSignUp(sessionStorage, "project-a", "5", 1_000);
    expect(
      takeBackAfterSignUp(sessionStorage, "project-a", 1_000 + 10 * 60_000 + 1),
    ).toBeNull();
  });
});
