// Opening the app saves the device at the server again once it is 30 days old (the server forgets a device after 90), and does
// nothing otherwise: not without the server's word that it sends alerts, not for another account, not before 30 days.
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installBrowser, KEY, makeSub, removeBrowser } from "./push-fake";

const mocks = vi.hoisted(() => ({
  save: vi.fn(async (_json: unknown) => undefined),
  who: { me: "b".repeat(64) as string | null },
}));
vi.mock("./push-calls", () => ({
  saveDevice: mocks.save,
  forgetDevice: vi.fn(),
}));
vi.mock("../../../lib/account", () => ({
  useAccount: () => ({ pubkey: mocks.who.me, locked: false }),
}));

import PushRenewal from "./PushRenewal";
import { readSaved, writeSaved } from "./push-store";

const ME = "b".repeat(64);
const now = () => Math.floor(Date.now() / 1000);
const DAY = 86_400;

function device(ago: number) {
  const sub = makeSub();
  installBrowser({ permission: "granted", sub });
  writeSaved({ account: ME, endpoint: sub.endpoint, savedAt: now() - ago });
  return sub;
}

beforeEach(() => {
  window.localStorage.clear();
  mocks.save.mockReset().mockResolvedValue(undefined);
  mocks.who.me = ME;
  applyServerSettings({ investing: true, webPush: { publicKey: KEY } });
});
afterEach(() => {
  cleanup();
  removeBrowser();
  applyServerSettings(null);
});

describe("saving the device again on opening the app", () => {
  it("saves a device older than 30 days, draws nothing, and does nothing for a newer one", async () => {
    const sub = device(31 * DAY);
    const { container } = render(<PushRenewal />);
    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith(sub.toJSON()));
    expect(container.innerHTML).toBe("");
    expect(now() - (readSaved()?.savedAt ?? 0)).toBeLessThan(5);
    cleanup();
    mocks.save.mockClear();
    device(10 * DAY);
    render(<PushRenewal />);
    await new Promise((r) => setTimeout(r, 30));
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("does nothing where the server does not say it sends alerts, nor without an account", async () => {
    device(40 * DAY);
    applyServerSettings({ investing: true });
    render(<PushRenewal />);
    await new Promise((r) => setTimeout(r, 30));
    expect(mocks.save).not.toHaveBeenCalled();
    cleanup();
    applyServerSettings({ investing: true, webPush: { publicKey: KEY } });
    mocks.who.me = null;
    render(<PushRenewal />);
    await new Promise((r) => setTimeout(r, 30));
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("does nothing for an account that did not save this device", async () => {
    device(40 * DAY);
    mocks.who.me = "c".repeat(64);
    render(<PushRenewal />);
    await new Promise((r) => setTimeout(r, 30));
    expect(mocks.save).not.toHaveBeenCalled();
  });
});
