// A money step whose call went out but has not landed is looked up, never sent a second time on a guess (A10 in
// PLANV2-M6-REPORT.md's "Review fixes", and the review of those fixes): the call may have been sped up in the wallet
// (a new hash, the same nonce), the wallet may now send from another account, or the amount may have changed.
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COORDINATE,
  installWallet,
  NOW,
  numbersOf,
  record,
  SERVER,
  sent,
  serve,
  settle,
  switchAccount,
  type WalletOptions,
  wrap,
} from "../../../tests/helpers/money-harness";
import {
  BACKER_EVM,
  CONTRACTS,
  FOUNDER_EVM,
  numbersContent,
} from "../../../tests/helpers/numbers-fixture";
import { BackBox } from "./BackBox";
import { openRound } from "./numbers";
import { Receipts } from "./Receipts";
import {
  forgetPending,
  type PendingSend,
  pendingSend,
  rememberPending,
  sendKey,
} from "./pending-sends";

vi.mock(
  "../../lib/relay",
  async () => (await import("../../../tests/helpers/money-harness")).relayMock,
);

const BACK_ACTION = `back:31337:${CONTRACTS.rounds}:2`;
const KEY = sendKey(BACK_ACTION, BACKER_EVM);
const isAsk = (c: { to: string }) => c.to === CONTRACTS.rounds;
const DOLLARS_25 = "25000000";

function backNumbers() {
  return numbersOf(
    numbersContent({
      coordinate: COORDINATE,
      now: NOW,
      openRound: { openedAgo: 3600 },
    }),
  );
}

/** The Back box of an open round, with `amount` typed and its sheet open. */
async function openBackSheet(amount = "25") {
  const numbers = backNumbers();
  const round = openRound(numbers, NOW);
  if (!round) throw new Error("no open round");
  wrap(
    <BackBox
      now={NOW}
      numbers={numbers}
      primary
      projectName="Lantern"
      round={round}
    />,
  );
  await typeAndReview(amount);
}

async function typeAndReview(amount: string) {
  fireEvent.change(screen.getByTestId("back-amount"), {
    target: { value: amount },
  });
  fireEvent.click(screen.getByTestId("back-review"));
  await screen.findByTestId("back-sheet");
}

/** A Back's ask sent earlier (before this page) whose outcome is still to be looked up. */
function earlierAsk(change: Partial<PendingSend> = {}) {
  rememberPending(KEY, {
    hash: `0x${"7".repeat(64)}`,
    index: 1,
    total: 2,
    chainId: 31337,
    at: NOW,
    from: BACKER_EVM,
    nonce: 4,
    detail: DOLLARS_25,
    ...change,
  });
}

/** Press Back with a call left waiting from before: the wallet's answers are `wallet`. */
async function pressWithEarlier(wallet: WalletOptions) {
  installWallet(wallet);
  await openBackSheet();
  await waitFor(() =>
    expect(screen.getByTestId("back-confirm").textContent).toMatch(
      /^Look for your backing/,
    ),
  );
  fireEvent.click(screen.getByTestId("back-confirm"));
}

/** Press Back and let the wallet's wait for the ask run out ("not landed yet"). */
async function pressUntilNotLanded() {
  fireEvent.click(screen.getByTestId("back-confirm"));
  await waitFor(() => expect(sent).toHaveLength(2));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200_000);
  });
  await screen.findByTestId("back-problem");
}

beforeEach(() => {
  applyServerSettings({ investing: true, self: SERVER });
  serve([]);
  installWallet();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  applyServerSettings(null);
  forgetPending(KEY);
  forgetPending(sendKey(BACK_ACTION, FOUNDER_EVM));
});

describe("A10: a Back whose ask has not landed cannot be sent again as a second ask", () => {
  it("does not send a second ask after 'not landed yet'", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    installWallet({ pendingFrom: 2 }); // the first ask never lands in time; everything else does
    await openBackSheet();
    await pressUntilNotLanded();
    // Kept with the waiting ask: who sent it, its nonce (its place in that account's order) and its amount.
    expect(pendingSend(KEY)).toMatchObject({
      from: BACKER_EVM,
      nonce: 1,
      index: 1,
      detail: DOLLARS_25,
    });
    const confirm = screen.getByTestId("back-confirm");
    if (!(confirm as HTMLButtonElement).disabled) fireEvent.click(confirm);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(sent.filter(isAsk)).toHaveLength(1);
  });

  it("sends afresh once the network says the earlier call was never seen, nor another in its place", async () => {
    earlierAsk();
    await pressWithEarlier({ count: { latest: 4, pending: 4 } });
    await screen.findByText(/^Backed with 25 dollars\./);
    expect(sent).toHaveLength(2);
    expect(sent.filter(isAsk)).toHaveLength(1);
  });

  it("sends only the ask once the earlier approval is found to have landed", async () => {
    earlierAsk({ hash: `0x${"8".repeat(64)}`, index: 0 });
    await pressWithEarlier({ landedEarlier: [`0x${"8".repeat(64)}`] });
    await screen.findByText(/^Backed with 25 dollars\./);
    expect(sent).toHaveLength(1);
    expect(sent.filter(isAsk)).toHaveLength(1);
  });
});

describe("A10 sped up: an ask the wallet sent again under a new hash is not asked twice", () => {
  it("reports the backing found in the round, with nothing sent again", async () => {
    earlierAsk();
    await pressWithEarlier({
      count: { latest: 5, pending: 5 },
      asked: 25_000_000n,
    });
    await screen.findByText(/^Backed with 25 dollars\./);
    expect(sent).toHaveLength(0);
  });

  it("sends afresh when the nonce was used but the round has no ask (the wallet cancelled it)", async () => {
    earlierAsk();
    await pressWithEarlier({ count: { latest: 5, pending: 5 }, asked: 0n });
    await screen.findByText(/^Backed with 25 dollars\./);
    expect(sent).toHaveLength(2);
    expect(sent.filter(isAsk)).toHaveLength(1);
  });

  it("sends afresh when the round holds less than that ask (an earlier, smaller ask of this account)", async () => {
    earlierAsk();
    await pressWithEarlier({
      count: { latest: 5, pending: 5 },
      asked: 10_000_000n,
    });
    await screen.findByText(/^Backed with 25 dollars\./);
    expect(sent.filter(isAsk)).toHaveLength(1);
  });

  it("waits while another call with the same nonce has not landed", async () => {
    earlierAsk();
    await pressWithEarlier({ count: { latest: 4, pending: 5 } });
    expect((await screen.findByTestId("back-problem")).textContent).toMatch(
      /has not landed yet/,
    );
    expect(sent).toHaveLength(0);
  });
});

describe("a step that cannot read whether a replaced call took effect", () => {
  it("does not send a refund again, and says to look in the wallet", async () => {
    const refundKey = sendKey(`refund:31337:${CONTRACTS.rounds}:1`, BACKER_EVM);
    rememberPending(refundKey, {
      hash: `0x${"6".repeat(64)}`,
      index: 0,
      total: 1,
      chainId: 31337,
      at: NOW,
      from: BACKER_EVM,
      nonce: 4,
    });
    installWallet({ count: { latest: 5, pending: 5 } });
    serve([record(numbersContent({ coordinate: COORDINATE, now: NOW }))]);
    wrap(<Receipts />);
    fireEvent.click(await screen.findByTestId("receipt-take-back"));
    await waitFor(() =>
      expect(screen.getByTestId("refund-confirm").textContent).toBe(
        "Look for your refund",
      ),
    );
    fireEvent.click(screen.getByTestId("refund-confirm"));
    expect((await screen.findByTestId("refund-problem")).textContent).toMatch(
      /another call/,
    );
    expect(sent).toHaveLength(0);
    forgetPending(refundKey);
  });
});

describe("a waiting call is kept per sending account and says its amount", () => {
  it("sends this account's own backing after the wallet switched accounts", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    installWallet({ pendingFrom: 2 }); // the backer's ask does not land
    await openBackSheet();
    await pressUntilNotLanded();
    switchAccount(FOUNDER_EVM);
    fireEvent.click(screen.getByTestId("back-confirm"));
    await screen.findByText(/^Backed with 25 dollars\./);
    const fromOther = sent.filter((c) => c.from === FOUNDER_EVM);
    expect(fromOther).toHaveLength(2);
    expect(fromOther.filter(isAsk)).toHaveLength(1);
    expect(sent.filter((c) => c.from === BACKER_EVM && isAsk(c))).toHaveLength(
      1,
    );
  });

  it("names the waiting amount when another is typed, and reports the one that landed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    installWallet({ pendingFrom: 2 });
    await openBackSheet("25");
    await pressUntilNotLanded();
    fireEvent.click(screen.getByLabelText("Close"));
    await waitFor(() => expect(screen.queryByTestId("back-sheet")).toBeNull());
    await typeAndReview("30");
    expect(screen.getByTestId("back-waiting-amount").textContent).toMatch(
      /backing of 25 dollars/,
    );
    expect(screen.getByTestId("back-confirm").textContent).toBe(
      "Look for your backing of 25 dollars",
    );
    settle(); // the 25-dollar ask lands
    fireEvent.click(screen.getByTestId("back-confirm"));
    await screen.findByText(/^Backed with 25 dollars\./);
    expect(sent.filter(isAsk)).toHaveLength(1);
  });

  it("approves the new amount again when only an approval of another amount landed", async () => {
    earlierAsk({
      hash: `0x${"8".repeat(64)}`,
      index: 0,
      detail: "20000000",
    });
    await pressWithEarlier({ landedEarlier: [`0x${"8".repeat(64)}`] });
    await screen.findByText(/^Backed with 25 dollars\./);
    expect(sent).toHaveLength(2);
    expect(sent[0].to).toBe(CONTRACTS.quote);
  });
});
