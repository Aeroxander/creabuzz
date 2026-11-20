// The alerts card on You, drawn against a fake browser and a stand-in for the server's calls: the table of states, nothing asked of
// the browser until the press, every word as the plan fixes it, and a card that is not drawn unless the server says it can send.
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seriousViolations } from "../../../../tests/helpers/axe-dom";
import { ToastProvider } from "../../../ui/toast";
import { installBrowser, KEY, makeSub, removeBrowser } from "./push-fake";

const mocks = vi.hoisted(() => ({
  save: vi.fn(async (_json: unknown) => undefined),
  forget: vi.fn(async (_endpoint: string) => undefined),
  link: {
    state: "linked" as "linked" | "none" | "expired" | "unchecked",
    pending: false,
  },
  kind: "wallet" as "wallet" | "passkey",
  confirm: vi.fn(),
}));
vi.mock("./push-calls", () => ({
  saveDevice: mocks.save,
  forgetDevice: mocks.forget,
}));
vi.mock("../../team/use-wallets", () => ({
  useTeamWallets: () => ({
    data: mocks.link.pending
      ? undefined
      : { [ME]: { state: mocks.link.state } },
    isPending: mocks.link.pending,
  }),
  useLinkWallet: () => ({ mutate: mocks.confirm, isPending: false }),
}));
vi.mock("../../money/use-money", async (original) => ({
  ...(await original<object>()),
  useWallet: () => ({ kind: mocks.kind, isAvailable: () => true }),
}));
vi.mock("../../../lib/account", () => ({
  useAccount: () => ({ pubkey: ME, locked: false }),
}));

import { PushCard } from "./PushCard";
import {
  PUSH_ASKING,
  PUSH_BLOCKED,
  PUSH_CANNOT,
  PUSH_EXPLAINED,
  PUSH_FAILED,
  PUSH_HEADING,
  PUSH_IS_ON,
  PUSH_NEEDS_LINK,
  PUSH_NO_PHONE,
  PUSH_OFF_DONE,
  PUSH_OFF_FAILED,
  PUSH_OFF_PENDING,
  PUSH_SMALL,
  PUSH_TURN_OFF,
  PUSH_TURN_ON,
} from "./push-words";
import { readPending, readSaved, writeSaved } from "./push-store";

const ME = "b".repeat(64);
const ON = { investing: true, webPush: { publicKey: KEY } };
const now = () => Math.floor(Date.now() / 1000);

function card() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <ToastProvider>
        <PushCard me={ME} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  mocks.save.mockReset().mockResolvedValue(undefined);
  mocks.forget.mockReset().mockResolvedValue(undefined);
  mocks.link.state = "linked";
  mocks.link.pending = false;
  mocks.kind = "wallet";
  mocks.confirm.mockReset();
  applyServerSettings(ON);
});
afterEach(() => {
  cleanup();
  removeBrowser();
  applyServerSettings(null);
});

describe("when the card is drawn", () => {
  it("is not drawn when the server does not say it can send alerts, nor where investing is off", () => {
    installBrowser();
    applyServerSettings({ investing: true });
    card();
    expect(screen.queryByTestId("push-card")).toBeNull();
    cleanup();
    applyServerSettings({ webPush: { publicKey: KEY } });
    card();
    expect(screen.queryByTestId("push-card")).toBeNull();
  });

  it("is a region with its heading and the two small lines, always", async () => {
    installBrowser();
    card();
    const region = await screen.findByRole("region", { name: PUSH_HEADING });
    for (const line of PUSH_SMALL) expect(region.textContent).toContain(line);
  });
});

describe("the states", () => {
  it("off: explains in one sentence what is sent, and asks nothing of the browser before the press", async () => {
    const fake = installBrowser();
    card();
    expect((await screen.findByTestId("push-state")).textContent).toBe(
      PUSH_EXPLAINED,
    );
    expect(screen.getByRole("button", { name: PUSH_TURN_ON })).not.toBeNull();
    // Opening the card (and reading everything it reads) asked nothing.
    expect(fake.asked).toBe(0);
    expect(fake.subscribed).toHaveLength(0);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("the sentence says what is sent and what is not: no amounts or names, and the news is in the app", () => {
    expect(PUSH_EXPLAINED).toMatch(/task is planned, taken or ended/);
    expect(PUSH_EXPLAINED).toMatch(/nothing about amounts or names/i);
    expect(PUSH_EXPLAINED).toMatch(/Open the app to read the news/);
  });

  it("the press asks the browser, turns alerts on, and the card says so with a way to turn them off", async () => {
    const fake = installBrowser();
    card();
    fireEvent.click(await screen.findByRole("button", { name: PUSH_TURN_ON }));
    expect((await screen.findByTestId("push-state")).textContent).toBe(
      PUSH_IS_ON,
    );
    expect(fake.asked).toBe(1);
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: PUSH_TURN_OFF })).not.toBeNull();
    expect(screen.queryByRole("button", { name: PUSH_TURN_ON })).toBeNull();
  });

  it("while the browser is being asked the press says so and cannot be pressed twice", async () => {
    const fake = installBrowser();
    let answer: (v: NotificationPermission) => void = () => undefined;
    // biome-ignore lint/suspicious/noExplicitAny: the fake's Notification
    (globalThis as any).Notification.requestPermission = () =>
      new Promise((resolve) => {
        answer = resolve;
      });
    card();
    fireEvent.click(await screen.findByRole("button", { name: PUSH_TURN_ON }));
    const busy = await screen.findByRole("button", { name: PUSH_ASKING });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    fake.permission = "granted";
    answer("granted");
    await screen.findByTestId("push-state");
  });

  it("turning off says what was done, and offers to turn them on again", async () => {
    const sub = makeSub();
    installBrowser({ permission: "granted", sub });
    writeSaved({ account: ME, endpoint: sub.endpoint, savedAt: now() });
    card();
    expect((await screen.findByTestId("push-state")).textContent).toBe(
      PUSH_IS_ON,
    );
    fireEvent.click(screen.getByRole("button", { name: PUSH_TURN_OFF }));
    expect((await screen.findByTestId("push-note")).textContent).toBe(
      PUSH_OFF_DONE,
    );
    expect(sub.unsubscribe).toHaveBeenCalled();
    expect(mocks.forget).toHaveBeenCalledWith(sub.endpoint);
    expect(screen.getByRole("button", { name: PUSH_TURN_ON })).not.toBeNull();
    expect(readSaved()).toBeNull();
  });

  it("turning off with a server that cannot be reached says so truthfully, and keeps the removal to try again", async () => {
    const sub = makeSub();
    installBrowser({ permission: "granted", sub });
    writeSaved({ account: ME, endpoint: sub.endpoint, savedAt: now() });
    mocks.forget.mockRejectedValue(new Error("offline"));
    card();
    fireEvent.click(await screen.findByRole("button", { name: PUSH_TURN_OFF }));
    const note = await screen.findByTestId("push-note");
    expect(note.textContent).toBe(PUSH_OFF_PENDING);
    expect(note.textContent).not.toBe(PUSH_OFF_DONE);
    expect(readPending(now())).toHaveLength(1);
  });

  it("a browser that will not turn them off says so and stays on", async () => {
    const sub = makeSub();
    sub.unsubscribe.mockResolvedValue(false);
    installBrowser({ permission: "granted", sub });
    writeSaved({ account: ME, endpoint: sub.endpoint, savedAt: now() });
    card();
    fireEvent.click(await screen.findByRole("button", { name: PUSH_TURN_OFF }));
    const note = await screen.findByTestId("push-note");
    expect(note.textContent).toBe(PUSH_OFF_FAILED);
    expect(note.getAttribute("role")).toBe("alert");
    expect(screen.getByTestId("push-state").textContent).toBe(PUSH_IS_ON);
  });

  it("a server that does not accept the device: said, and nothing is left on", async () => {
    const fake = installBrowser();
    mocks.save.mockRejectedValue(new Error("503"));
    card();
    fireEvent.click(await screen.findByRole("button", { name: PUSH_TURN_ON }));
    const note = await screen.findByTestId("push-note");
    expect(note.textContent).toBe(PUSH_FAILED);
    expect(note.getAttribute("role")).toBe("alert");
    expect(screen.getByRole("button", { name: PUSH_TURN_ON })).not.toBeNull();
    expect(
      (fake.sub as ReturnType<typeof makeSub>).unsubscribe,
    ).toHaveBeenCalled();
  });

  it("blocked in the browser: says so, with no button", async () => {
    installBrowser({ permission: "denied" });
    card();
    await screen.findByText(PUSH_BLOCKED);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("the person refusing the browser's question ends blocked; closing it leaves the card as it was", async () => {
    installBrowser({ answer: "denied" });
    card();
    fireEvent.click(await screen.findByRole("button", { name: PUSH_TURN_ON }));
    await screen.findByText(PUSH_BLOCKED);
    cleanup();
    removeBrowser();
    installBrowser({ answer: "default" });
    card();
    fireEvent.click(await screen.findByRole("button", { name: PUSH_TURN_ON }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: PUSH_TURN_ON })).not.toBeNull(),
    );
    expect(screen.queryByTestId("push-note")).toBeNull();
  });

  it("a browser that cannot show alerts says so, with the iPhone hint and no button", async () => {
    card();
    await screen.findByText(PUSH_CANNOT);
    expect(PUSH_CANNOT).toMatch(
      /iPhone, add the app to your Home Screen first/,
    );
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("an account the server cannot tie to a wallet", () => {
  it("is told what to do, with the room's own press, and cannot turn alerts on", async () => {
    installBrowser();
    mocks.link.state = "none";
    card();
    expect((await screen.findByTestId("push-needs-link")).textContent).toBe(
      PUSH_NEEDS_LINK,
    );
    expect(screen.queryByRole("button", { name: PUSH_TURN_ON })).toBeNull();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Confirm this account backs the project",
      }),
    );
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
  });

  it("a link that has ended is the same; one that could not be checked here does not stand in the way", async () => {
    installBrowser();
    mocks.link.state = "expired";
    card();
    await screen.findByTestId("push-needs-link");
    cleanup();
    mocks.link.state = "unchecked";
    card();
    await screen.findByRole("button", { name: PUSH_TURN_ON });
  });

  it("waits for the link to be read before it shows a press", async () => {
    installBrowser();
    mocks.link.pending = true;
    card();
    await screen.findByTestId("push-checking");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("a phone account on a server that cannot check its link is told so, with no button", async () => {
    installBrowser();
    mocks.kind = "passkey";
    mocks.link.state = "none";
    applyServerSettings({ ...ON, smartAccountLinks: false });
    card();
    await screen.findByText(PUSH_NO_PHONE);
    expect(screen.queryByRole("button")).toBeNull();
    // A phone account on a server that can check it is asked to confirm like anyone.
    cleanup();
    applyServerSettings({ ...ON, smartAccountLinks: true });
    card();
    await screen.findByTestId("push-needs-link");
  });
});

describe("the card for a person using it", () => {
  it("has no serious accessibility violation, off and on", async () => {
    installBrowser();
    card();
    await screen.findByRole("button", { name: PUSH_TURN_ON });
    expect(await seriousViolations()).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: PUSH_TURN_ON }));
    await screen.findByRole("button", { name: PUSH_TURN_OFF });
    expect(await seriousViolations()).toEqual([]);
  });

  it("each press has one name and can be reached and pressed by the keyboard alone", async () => {
    installBrowser();
    card();
    const press = await screen.findByRole("button", { name: PUSH_TURN_ON });
    press.focus();
    expect(document.activeElement).toBe(press);
    fireEvent.keyDown(press, { key: "Enter" });
    fireEvent.keyUp(press, { key: "Enter" });
    fireEvent.click(press);
    await screen.findByTestId("push-state");
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });
});
