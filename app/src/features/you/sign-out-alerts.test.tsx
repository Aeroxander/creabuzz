// Signing out on a device that has alerts on turns them off first: the browser stops delivering, and the server is told to forget the
import type { ReactNode } from "react";
// device (a call only the signing-out account can sign), so one person's news never keeps arriving on a phone the next person uses.
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
import { ToastProvider } from "../../ui/toast";
import {
  installBrowser,
  KEY,
  makeSub,
  removeBrowser,
} from "../alerts/push/push-fake";

const ME = "b".repeat(64);
const mocks = vi.hoisted(() => ({
  save: vi.fn(async () => undefined),
  forget: vi.fn(async () => undefined),
}));
vi.mock("../alerts/push/push-calls", () => ({
  saveDevice: mocks.save,
  forgetDevice: mocks.forget,
}));
vi.mock("../../lib/account", () => ({
  useAccount: () => ({ pubkey: ME, locked: false }),
}));
vi.mock("../../lib/profiles", () => ({
  useProfiles: () => ({ data: undefined }),
  nameOf: () => "Me",
}));
vi.mock("../profile/use-own-projects", () => ({
  useProjectsBy: () => ({ data: [] }),
}));
vi.mock("../profile/ProfilePage", () => ({ ProfileHead: () => null }));
vi.mock("../notifications/NotificationsList", () => ({
  NotificationsList: () => null,
}));
vi.mock("../alerts/NewsSection", () => ({ default: () => null }));
vi.mock("../pot/YourSharesList", () => ({ default: () => null }));
vi.mock("../team/LinkWallet", () => ({ LinkWallet: () => null }));
vi.mock("../money/SenderChoice", () => ({ SenderChoice: () => null }));
vi.mock("../team/use-wallets", () => ({
  useTeamWallets: () => ({
    data: { [ME]: { state: "linked" } },
    isPending: false,
  }),
  useLinkWallet: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("../money/use-money", async (o) => ({
  ...(await o<object>()),
  useWallet: () => ({ kind: "wallet", isAvailable: () => true }),
}));
vi.mock("@tanstack/react-router", async (o) => ({
  ...(await o<object>()),
  Link: ({ children }: { children: ReactNode }) => <a href="/x">{children}</a>,
  useNavigate: () => () => undefined,
  useRouterState: () => "/you",
}));
vi.mock("../../app/BackHeader", () => ({
  ScreenHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
}));

import { YouPage } from "./YouPage";
import { writeSaved } from "../alerts/push/push-store";

beforeEach(() => {
  mocks.save.mockClear();
  mocks.forget.mockClear();
  localStorage.clear();
  applyServerSettings({
    investing: true,
    webPush: { publicKey: KEY },
  } as never);
  Object.defineProperty(window, "location", {
    value: { ...window.location, assign: vi.fn() },
    writable: true,
  });
});
afterEach(() => {
  cleanup();
  removeBrowser();
  applyServerSettings(null);
});

describe("signing out with alerts on", () => {
  it("turns the device's alerts off, in the browser and at the server, before the account is forgotten", async () => {
    const sub = makeSub();
    installBrowser({ permission: "granted", sub });
    writeSaved({
      account: ME,
      endpoint: sub.endpoint,
      savedAt: Math.floor(Date.now() / 1000),
    });
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <ToastProvider>
          <YouPage />
        </ToastProvider>
      </QueryClientProvider>,
    );
    await screen.findByText("Alerts are on for this device.");
    const tab = screen.getByRole("tab", { name: "Account" });
    fireEvent.mouseDown(tab, { button: 0, ctrlKey: false });
    fireEvent.click(tab);
    fireEvent.focus(tab);
    fireEvent.click(await screen.findByTestId("sign-out"));
    fireEvent.click(await screen.findByTestId("sign-out-confirm"));
    await new Promise((r) => setTimeout(r, 50));
    // The browser must stop delivering to a signed-out account, and the server must be told to forget the device.
    expect(sub.unsubscribe).toHaveBeenCalled();
    expect(mocks.forget).toHaveBeenCalledWith(sub.endpoint);
  });

  it("leaves a device that another account saved alone", async () => {
    const sub = makeSub();
    installBrowser({ permission: "granted", sub });
    writeSaved({
      account: "c".repeat(64),
      endpoint: sub.endpoint,
      savedAt: Math.floor(Date.now() / 1000),
    });
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <ToastProvider>
          <YouPage />
        </ToastProvider>
      </QueryClientProvider>,
    );
    const tab = await screen.findByRole("tab", { name: "Account" });
    fireEvent.mouseDown(tab, { button: 0, ctrlKey: false });
    fireEvent.click(tab);
    fireEvent.focus(tab);
    fireEvent.click(await screen.findByTestId("sign-out"));
    fireEvent.click(await screen.findByTestId("sign-out-confirm"));
    await waitFor(() => expect(window.location.assign).toHaveBeenCalled());
    expect(sub.unsubscribe).not.toHaveBeenCalled();
    expect(mocks.forget).not.toHaveBeenCalled();
  });
});
