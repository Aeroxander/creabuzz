// Alerts on a device, against a fake browser and a stand-in for the server's two calls: nothing is asked of the browser until
// the press, a device the server did not accept is taken back, another account's subscription is never used, and a removal
// the server did not confirm is kept and asked again.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installBrowser,
  KEY,
  KEY_BYTES,
  makeSub,
  removeBrowser,
} from "./push-fake";

const calls = vi.hoisted(() => ({
  save: vi.fn(async (_json: unknown) => undefined),
  forget: vi.fn(async (_endpoint: string) => undefined),
}));
vi.mock("./push-calls", () => ({
  saveDevice: calls.save,
  forgetDevice: calls.forget,
}));

import {
  deviceCanShowAlerts,
  keyBytes,
  readDeviceState,
  renewIfDue,
  retryRemovals,
  turnOff,
  turnOn,
} from "./push-device";
import { readPending, readSaved, writeSaved } from "./push-store";

const ME = "b".repeat(64);
const OTHER = "c".repeat(64);
const now = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
  window.localStorage.clear();
  calls.save.mockReset().mockResolvedValue(undefined);
  calls.forget.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  removeBrowser();
  vi.useRealTimers();
});

describe("what the device can do", () => {
  it("can show alerts when it has a worker, a push manager and notifications; not otherwise", () => {
    installBrowser();
    expect(deviceCanShowAlerts()).toBe(true);
    removeBrowser();
    expect(deviceCanShowAlerts()).toBe(false);
  });

  it("the server's key is read as the bytes the browser wants", () => {
    expect(Array.from(keyBytes(KEY))).toEqual(Array.from(KEY_BYTES));
  });
});

describe("where alerts stand", () => {
  it("is blocked when the browser says so, and off before anything is asked", async () => {
    const fake = installBrowser({ permission: "denied" });
    expect(await readDeviceState(ME)).toBe("blocked");
    fake.permission = "default";
    expect(await readDeviceState(ME)).toBe("off");
    // Reading never asks the browser.
    expect(fake.asked).toBe(0);
  });

  it("is on only for the account that saved this very subscription", async () => {
    const sub = makeSub();
    installBrowser({ permission: "granted", sub });
    expect(await readDeviceState(ME)).toBe("off");
    writeSaved({ account: ME, endpoint: sub.endpoint, savedAt: now() });
    expect(await readDeviceState(ME)).toBe("on");
    // Another account on the same browser is not told alerts are on for it.
    expect(await readDeviceState(OTHER)).toBe("off");
    // A different subscription than the one saved is not "on" either.
    writeSaved({
      account: ME,
      endpoint: "https://fcm.googleapis.com/other",
      savedAt: now(),
    });
    expect(await readDeviceState(ME)).toBe("off");
  });

  it("is off, not an error, with no worker registered", async () => {
    installBrowser({ permission: "granted", noWorker: true });
    expect(await readDeviceState(ME)).toBe("off");
  });
});

describe("turning alerts on", () => {
  it("asks the browser, subscribes with the server's key, saves the device and remembers who saved it", async () => {
    const fake = installBrowser();
    expect(await turnOn(ME, KEY)).toBe("on");
    expect(fake.asked).toBe(1);
    expect(fake.subscribed).toHaveLength(1);
    expect(fake.subscribed[0].userVisibleOnly).toBe(true);
    expect(Array.from(fake.subscribed[0].applicationServerKey ?? [])).toEqual(
      Array.from(KEY_BYTES),
    );
    expect(calls.save).toHaveBeenCalledTimes(1);
    expect(calls.save.mock.calls[0][0]).toEqual(fake.sub?.toJSON());
    expect(readSaved()).toMatchObject({
      account: ME,
      endpoint: fake.sub?.endpoint,
    });
  });

  it("a refusal in the browser saves nothing and subscribes to nothing", async () => {
    const fake = installBrowser({ answer: "denied" });
    expect(await turnOn(ME, KEY)).toBe("blocked");
    expect(fake.subscribed).toHaveLength(0);
    expect(calls.save).not.toHaveBeenCalled();
    expect(readSaved()).toBeNull();
  });

  it("closing the browser's question is not a refusal and not an error", async () => {
    const fake = installBrowser({ answer: "default" });
    expect(await turnOn(ME, KEY)).toBe("dismissed");
    expect(fake.subscribed).toHaveLength(0);
    expect(calls.save).not.toHaveBeenCalled();
  });

  it("a server that does not accept the device: the subscription is taken back and nothing is remembered as saved", async () => {
    const fake = installBrowser();
    calls.save.mockRejectedValueOnce(new Error("503"));
    expect(await turnOn(ME, KEY)).toBe("failed");
    const made = fake.sub as ReturnType<typeof makeSub>;
    expect(made.unsubscribe).toHaveBeenCalled();
    expect(readSaved()).toBeNull();
  });

  it("a push service that cannot be reached is a failure, with nothing saved at the server", async () => {
    installBrowser({ subscribeFails: true });
    expect(await turnOn(ME, KEY)).toBe("failed");
    expect(calls.save).not.toHaveBeenCalled();
  });

  it("no worker ready in time is a failure", async () => {
    vi.useFakeTimers();
    installBrowser({ noWorker: true });
    const result = turnOn(ME, KEY);
    await vi.advanceTimersByTimeAsync(9_000);
    expect(await result).toBe("failed");
  });

  it("never uses a subscription another account saved: it is dropped and made again", async () => {
    const old = makeSub();
    const fake = installBrowser({ permission: "granted", sub: old });
    writeSaved({ account: OTHER, endpoint: old.endpoint, savedAt: now() });
    expect(await turnOn(ME, KEY)).toBe("on");
    expect(old.unsubscribe).toHaveBeenCalled();
    expect(fake.subscribed).toHaveLength(1);
    expect(fake.sub?.endpoint).not.toBe(old.endpoint);
    expect(readSaved()).toMatchObject({
      account: ME,
      endpoint: fake.sub?.endpoint,
    });
  });

  it("drops a subscription made with another key of the server's, and one with no record at all", async () => {
    const oldKey = makeSub(
      Uint8Array.from([4, ...Array.from({ length: 64 }, () => 9)]),
    );
    installBrowser({ permission: "granted", sub: oldKey });
    writeSaved({ account: ME, endpoint: oldKey.endpoint, savedAt: now() });
    await turnOn(ME, KEY);
    expect(oldKey.unsubscribe).toHaveBeenCalled();
    removeBrowser();
    const unknown = makeSub();
    installBrowser({ permission: "granted", sub: unknown });
    window.localStorage.clear();
    await turnOn(ME, KEY);
    expect(unknown.unsubscribe).toHaveBeenCalled();
  });

  it("keeps its own subscription when it is turned on again, and saves it again", async () => {
    const mine = makeSub();
    const fake = installBrowser({ permission: "granted", sub: mine });
    writeSaved({ account: ME, endpoint: mine.endpoint, savedAt: now() });
    expect(await turnOn(ME, KEY)).toBe("on");
    expect(mine.unsubscribe).not.toHaveBeenCalled();
    expect(fake.subscribed).toHaveLength(0);
    expect(calls.save).toHaveBeenCalledTimes(1);
  });

  it("a failed save of a subscription that was already there leaves it as it was", async () => {
    const mine = makeSub();
    installBrowser({ permission: "granted", sub: mine });
    writeSaved({ account: ME, endpoint: mine.endpoint, savedAt: 123 });
    calls.save.mockRejectedValueOnce(new Error("down"));
    expect(await turnOn(ME, KEY)).toBe("failed");
    expect(mine.unsubscribe).not.toHaveBeenCalled();
    expect(readSaved()?.savedAt).toBe(123);
  });
});

describe("turning alerts off", () => {
  it("stops the browser first, then has the server delete the device, and forgets the record", async () => {
    const sub = makeSub();
    installBrowser({ permission: "granted", sub });
    writeSaved({ account: ME, endpoint: sub.endpoint, savedAt: now() });
    const order: string[] = [];
    sub.unsubscribe.mockImplementation(async () => {
      order.push("browser");
      return true;
    });
    calls.forget.mockImplementation(async () => {
      order.push("server");
    });
    expect(await turnOff(ME)).toBe("off");
    expect(order).toEqual(["browser", "server"]);
    expect(calls.forget).toHaveBeenCalledWith(sub.endpoint);
    expect(readSaved()).toBeNull();
    expect(readPending(now())).toEqual([]);
  });

  it("a server that cannot be reached is remembered and asked again; the device is off in the meantime", async () => {
    const sub = makeSub();
    installBrowser({ permission: "granted", sub });
    writeSaved({ account: ME, endpoint: sub.endpoint, savedAt: now() });
    calls.forget.mockRejectedValue(new Error("offline"));
    expect(await turnOff(ME)).toBe("off-pending");
    expect(sub.unsubscribe).toHaveBeenCalled();
    expect(readSaved()).toBeNull();
    expect(readPending(now())).toMatchObject([
      { account: ME, endpoint: sub.endpoint },
    ]);
    // Still down: it stays. Back up: it is asked, and forgotten once the server says so.
    await retryRemovals(ME);
    expect(readPending(now())).toHaveLength(1);
    calls.forget.mockReset().mockResolvedValue(undefined);
    await retryRemovals(ME);
    expect(calls.forget).toHaveBeenCalledWith(sub.endpoint);
    expect(readPending(now())).toEqual([]);
  });

  it("only the account's own removals are asked for", async () => {
    installBrowser();
    window.localStorage.setItem(
      "creaton.push.pending.v1",
      JSON.stringify([
        { account: ME, endpoint: "https://fcm.googleapis.com/a", at: now() },
        { account: OTHER, endpoint: "https://fcm.googleapis.com/b", at: now() },
      ]),
    );
    await retryRemovals(ME);
    expect(calls.forget).toHaveBeenCalledTimes(1);
    expect(calls.forget).toHaveBeenCalledWith("https://fcm.googleapis.com/a");
    expect(readPending(now())).toMatchObject([{ account: OTHER }]);
  });

  it("a browser that will not stop is a failure, and the device stays saved", async () => {
    const sub = makeSub();
    sub.unsubscribe.mockResolvedValue(false);
    installBrowser({ permission: "granted", sub });
    writeSaved({ account: ME, endpoint: sub.endpoint, savedAt: now() });
    expect(await turnOff(ME)).toBe("failed");
    expect(calls.forget).not.toHaveBeenCalled();
    expect(readSaved()).not.toBeNull();
  });

  it("the list of removals is bounded", async () => {
    installBrowser();
    const { addPending } = await import("./push-store");
    for (let i = 0; i < 12; i += 1)
      addPending(ME, `https://fcm.googleapis.com/${i}`, now());
    expect(readPending(now()).length).toBeLessThanOrEqual(5);
    // An old one is dropped.
    window.localStorage.setItem(
      "creaton.push.pending.v1",
      JSON.stringify([
        {
          account: ME,
          endpoint: "https://fcm.googleapis.com/old",
          at: now() - 91 * 86_400,
        },
      ]),
    );
    expect(readPending(now())).toEqual([]);
  });
});

describe("saving the device again", () => {
  const DAY = 86_400;
  function savedAt(ago: number) {
    const sub = makeSub();
    installBrowser({ permission: "granted", sub });
    writeSaved({ account: ME, endpoint: sub.endpoint, savedAt: now() - ago });
    return sub;
  }

  it("does nothing before 30 days, and saves again after", async () => {
    savedAt(29 * DAY);
    expect(await renewIfDue(ME)).toBe("not-due");
    expect(calls.save).not.toHaveBeenCalled();
    removeBrowser();
    const sub = savedAt(31 * DAY);
    expect(await renewIfDue(ME)).toBe("renewed");
    expect(calls.save).toHaveBeenCalledWith(sub.toJSON());
    expect(now() - (readSaved()?.savedAt ?? 0)).toBeLessThan(5);
  });

  it("is only for the account that saved the device, with the permission and the subscription still there", async () => {
    savedAt(40 * DAY);
    expect(await renewIfDue(OTHER)).toBe("not-due");
    removeBrowser();
    const sub = makeSub();
    const fake = installBrowser({ permission: "granted", sub });
    writeSaved({
      account: ME,
      endpoint: sub.endpoint,
      savedAt: now() - 40 * DAY,
    });
    fake.permission = "denied";
    expect(await renewIfDue(ME)).toBe("not-due");
    fake.permission = "granted";
    fake.sub = null;
    expect(await renewIfDue(ME)).toBe("not-due");
    fake.sub = makeSub();
    expect(await renewIfDue(ME)).toBe("not-due");
    expect(calls.save).not.toHaveBeenCalled();
  });

  it("a save the server does not accept leaves the date as it was, so it is tried again at the next opening", async () => {
    savedAt(40 * DAY);
    const before = readSaved()?.savedAt;
    calls.save.mockRejectedValueOnce(new Error("503"));
    expect(await renewIfDue(ME)).toBe("failed");
    expect(readSaved()?.savedAt).toBe(before);
  });
});
