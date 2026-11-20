// "Link this wallet" is offered only where a wallet can sign the proof: a phone whose only sender is the passkey account
// cannot, so it would end in an error. It must not be shown there.
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../ui/toast";
import type { MoneyWallet } from "../money/wallet";

const stand = (kind: "wallet" | "passkey", signsMessages: boolean) =>
  ({
    kind,
    capabilities: {
      signsMessages,
      atomicBatch: !signsMessages,
      feeSponsored: !signsMessages,
    },
    isAvailable: () => true,
    connectedAddress: async () => `0x${"11".repeat(20)}`,
    getAddress: async () => `0x${"11".repeat(20)}`,
  }) as unknown as MoneyWallet;

let current: MoneyWallet;
vi.mock("../money/sender", async (original) => ({
  ...(await original<typeof import("../money/sender")>()),
  useSender: () => current,
}));
vi.mock("../../lib/relay", () => ({
  read: async () => [],
  publish: async () => undefined,
}));

import { LinkWallet } from "./LinkWallet";

const shown = () => {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ToastProvider>
        <LinkWallet me={"a".repeat(64)} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return screen.queryByTestId("link-wallet");
};

beforeEach(() =>
  applyServerSettings({ investing: true, self: "http://s.invalid" } as never),
);
afterEach(() => {
  cleanup();
  applyServerSettings(null);
});

describe("Your wallet on You", () => {
  it("is offered to a wallet that can sign", () => {
    current = stand("wallet", true);
    expect(shown()).not.toBeNull();
  });
  it("is not offered to a sender that cannot sign the proof", () => {
    current = stand("passkey", false);
    expect(shown()).toBeNull();
  });
  it("is offered to a phone account, which signs the link with its passkey", () => {
    current = stand("passkey", true);
    expect(shown()).not.toBeNull();
  });
  it("is not offered to a phone account when the server says it cannot check one", () => {
    current = stand("passkey", true);
    applyServerSettings({
      investing: true,
      self: "http://s.invalid",
      smartAccountLinks: false,
    } as never);
    expect(shown()).toBeNull();
  });
});
