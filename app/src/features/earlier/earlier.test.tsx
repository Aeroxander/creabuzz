// The earlier backers' page through its components: only the line the link names is ever read, the agreement is shown
// only when its fingerprints are the contract's, and each press sends exactly the call the contract expects.
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { selectorOf } from "@creaton/core/launchpad/evmAbi.ts";
import {
  cancelHolderData,
  claimFragment,
  consentData,
  deliverData,
  fingerprintOf,
  leafOf,
} from "@creaton/core/launchpad/earlier-claim.ts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addressWord,
  installChainStub,
  word,
} from "../../../tests/helpers/chain-stub";
import {
  NOW,
  record,
  SERVER,
  serve,
  wrap,
} from "../../../tests/helpers/money-harness";
import {
  BACKER_EVM,
  numbersContent,
} from "../../../tests/helpers/numbers-fixture";
import { EarlierBody } from "./EarlierPage";

vi.mock(
  "../../lib/relay",
  async () => (await import("../../../tests/helpers/money-harness")).relayMock,
);

// Made-up line: entry 2 of a list, five Shares.
const CLAIM = "0x5c0000000000000000000000000000000000c1a1";
const HOLDER = BACKER_EVM;
const OTHER = "0x90f79bf6eb2c4f870365e785982e1f101e93b906";
const NEW_HOLDER = "0x15d34aaf54267db7d7c367839aaf71a00a2c6a65";
const SALT = `0x${"11".repeat(32)}`;
const AMOUNT = 5_000_000_000_000_000_000n;
const ENTRY = 2n;
const TEXT = "Made-up agreement text for tests.";
const SUMMARY = "Made-up one-line summary for tests.";
const KEY = `0x${"ab".repeat(32)}`;
const DAY = 86_400;

interface World {
  me?: string;
  holder?: string | null;
  consentAt?: number;
  receiver?: string;
  pending?: string | null;
  pendingAt?: number;
  vetoed?: boolean;
  barred?: string | null;
  taken?: bigint;
  due?: bigint;
  closed?: boolean;
  funded?: boolean;
  leafOk?: boolean;
  textHash?: string;
  text?: "ok" | "missing" | "moved";
}

const zero = `0x${"0".repeat(40)}`;
const orZero = (a: string | null | undefined) => addressWord(a ?? zero);

function setup(w: World = {}) {
  window.location.hash = claimFragment({
    entry: ENTRY,
    holder: HOLDER,
    amount: AMOUNT,
    salt: SALT,
  });
  applyServerSettings({ investing: true, self: SERVER });
  const content = numbersContent({
    coordinate: `37001:${"b".repeat(64)}:p0`,
    now: NOW,
  });
  serve([
    record({
      ...content,
      earlierBackers: {
        claim: CLAIM,
        bound: true,
        textVersion: 1,
        consented: { count: 3, total: "15000000000000000000" },
        voidedCount: 0,
        delivered: { count: 1, total: "1000000000000000000" },
        replacements: { pending: 0, done: 0, cancelled: 0 },
        listClosed: null,
        sentToReserve: "0",
      },
    }),
  ]);
  const calls: string[] = [];
  const log = (answer: string) => (_to: string, data: string) => {
    calls.push(data);
    return answer;
  };
  const leaf =
    w.leafOk === false
      ? `0x${"00".repeat(32)}`
      : leafOf(ENTRY, HOLDER, AMOUNT, SALT);
  const textHash = w.textHash ?? fingerprintOf(TEXT);
  const entry = `0x${[
    orZero(w.holder),
    word(w.holder ? 1 : 0),
    word(w.consentAt ?? 0),
    orZero(w.consentAt ? (w.me ?? HOLDER) : null),
    word(w.pendingAt ?? 0),
    word(w.vetoed ? 1 : 0),
    orZero(w.pending),
    orZero(w.barred),
    orZero(w.consentAt ? (w.receiver ?? HOLDER) : null),
    word(w.consentAt ? AMOUNT : 0),
    word(w.taken ?? 0n),
  ].join("")}`;
  const stub = installChainStub({
    account: w.me ?? HOLDER,
    reads: {
      "textHash()": log(`0x${word(textHash)}`),
      "summaryHash()": log(`0x${word(fingerprintOf(SUMMARY))}`),
      "textVersion()": log(`0x${word(1)}`),
      "key()": log(`0x${word(KEY)}`),
      "closed()": log(`0x${word(w.closed ? 1 : 0)}`),
      "closeAt()": log(`0x${word(NOW + 400 * DAY)}`),
      "total()": log(`0x${word(AMOUNT * 4n)}`),
      "funding()": log(`0x${word(w.funded === false ? 0n : AMOUNT * 4n)}`),
      "entryCount()": log(`0x${word(21)}`),
      "leaf(uint256)": log(leaf),
      "entryOf(uint256)": log(entry),
      "due(uint256)": log(`0x${word(w.due ?? 0n)}`),
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      w.text === "missing"
        ? { ok: false, json: async () => null }
        : {
            ok: true,
            json: async () => ({
              version: 1,
              text: w.text === "moved" ? "Another text." : TEXT,
              summary: SUMMARY,
            }),
          },
    ),
  );
  return { stub, calls };
}

beforeEach(() => {
  window.location.hash = "";
});
afterEach(() => {
  cleanup();
  applyServerSettings(null);
  vi.unstubAllGlobals();
});

const show = () => wrap(<EarlierBody />);

describe("agreeing to a line", () => {
  it("shows the agreement, holds the press until it is read, and sends the exact call in person", async () => {
    const { stub } = setup();
    show();
    expect(await screen.findByTestId("earlier-text")).toHaveProperty(
      "value",
      TEXT,
    );
    expect(screen.getByTestId("earlier-summary").textContent).toBe(SUMMARY);
    const agree = screen.getByTestId("earlier-agree") as HTMLButtonElement;
    expect(agree.disabled).toBe(true);
    fireEvent.click(screen.getByTestId("earlier-read"));
    expect(agree.disabled).toBe(false);
    fireEvent.click(agree);
    await waitFor(() => expect(stub.sent.length).toBe(1));
    const sent = stub.sent[0];
    expect(sent.from).toBe(HOLDER);
    expect(sent.to).toBe(CLAIM);
    // Same call as the contract's `consent`, in person (no signature), to the holder, for the text read.
    const expected = consentData({
      entry: ENTRY,
      holder: HOLDER,
      amount: AMOUNT,
      salt: SALT,
      receiver: HOLDER,
      textHash: fingerprintOf(TEXT),
      validUntil: 0n,
    });
    // Everything but the deadline (the word before the empty signature's offset) is pinned.
    const strip = (data: string) =>
      data.slice(0, 2 + 8 + 64 * 6) + data.slice(2 + 8 + 64 * 7);
    expect(strip(sent.data)).toBe(strip(expected));
  });

  it("sends the Shares to another wallet only once a real address is typed", async () => {
    const { stub } = setup();
    show();
    await screen.findByTestId("earlier-text");
    fireEvent.click(screen.getByTestId("earlier-read"));
    fireEvent.click(screen.getAllByRole("radio")[1]);
    const agree = screen.getByTestId("earlier-agree") as HTMLButtonElement;
    expect(agree.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("earlier-receiver"), {
      target: { value: "0x12" },
    });
    expect(screen.getByText(/not a wallet address/)).toBeTruthy();
    expect(agree.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("earlier-receiver"), {
      target: { value: OTHER },
    });
    expect(agree.disabled).toBe(false);
    fireEvent.click(agree);
    await waitFor(() => expect(stub.sent.length).toBe(1));
    expect(stub.sent[0].data).toContain(addressWord(OTHER));
  });

  it("reads only the line the link names, never another", async () => {
    const { calls } = setup();
    show();
    await screen.findByTestId("earlier-text");
    const indexed = calls.filter((d) =>
      ["leaf(uint256)", "entryOf(uint256)", "due(uint256)"].some((s) =>
        d.startsWith(selector(s)),
      ),
    );
    expect(indexed.length).toBe(3);
    for (const data of indexed) expect(data.slice(10)).toBe(word(ENTRY));
  });

  it("shows no agreement and no press when its fingerprint is not the contract's", async () => {
    setup({ text: "moved" });
    show();
    expect(await screen.findByTestId("earlier-text-moved")).toBeTruthy();
    expect(screen.queryByTestId("earlier-text")).toBeNull();
    expect(screen.queryByTestId("earlier-agree")).toBeNull();
  });

  it("says plainly when the agreement is not published yet", async () => {
    setup({ text: "missing" });
    show();
    expect(
      (await screen.findByTestId("earlier-text-missing")).textContent,
    ).toMatch(/not published here yet/);
    expect(screen.queryByTestId("earlier-agree")).toBeNull();
  });

  it("offers nothing when the link's data is not the stored line", async () => {
    setup({ leafOk: false });
    show();
    expect(await screen.findByTestId("earlier-not-on-list")).toBeTruthy();
    expect(screen.queryByTestId("earlier-agree")).toBeNull();
  });

  it("offers nothing from another wallet, and says which one the line is for", async () => {
    setup({ me: OTHER });
    show();
    const note = await screen.findByTestId("earlier-wrong-wallet");
    expect(note.textContent).toContain(`ending ${HOLDER.slice(-4)}`);
    expect(screen.queryByTestId("earlier-agree")).toBeNull();
  });

  it("offers nothing on a closed list, or before the Shares are in place", async () => {
    setup({ closed: true });
    show();
    expect(await screen.findByTestId("earlier-closed")).toBeTruthy();
    cleanup();
    setup({ funded: false });
    show();
    expect(await screen.findByTestId("earlier-not-funded")).toBeTruthy();
  });
});

describe("after agreeing", () => {
  it("shows the clock and offers sending only from 21 days, when something is due", async () => {
    setup({ consentAt: NOW - 5 * DAY, due: 1_000n });
    show();
    expect(await screen.findByTestId("earlier-agreed")).toBeTruthy();
    expect(screen.queryByTestId("earlier-deliver")).toBeNull();
    cleanup();
    setup({ consentAt: NOW - 22 * DAY, due: 0n });
    show();
    await screen.findByTestId("earlier-agreed");
    expect(screen.queryByTestId("earlier-deliver")).toBeNull();
  });

  it("sends the released Shares in one press, the call being this line's alone", async () => {
    const { stub } = setup({ consentAt: NOW - 22 * DAY, due: 1_000n });
    show();
    fireEvent.click(await screen.findByTestId("earlier-deliver"));
    await waitFor(() => expect(stub.sent.length).toBe(1));
    expect(stub.sent[0]).toEqual({
      from: HOLDER,
      to: CLAIM,
      data: deliverData(ENTRY),
    });
  });
});

describe("a proposed replacement", () => {
  it("tells the holder when it applies and offers the one veto", async () => {
    const { stub } = setup({ pending: NEW_HOLDER, pendingAt: NOW - 2 * DAY });
    show();
    expect(await screen.findByTestId("earlier-replacement")).toBeTruthy();
    fireEvent.click(screen.getByTestId("earlier-veto"));
    await waitFor(() => expect(stub.sent.length).toBe(1));
    expect(stub.sent[0].data).toBe(cancelHolderData(ENTRY, AMOUNT, SALT));
  });

  it("offers no veto after it was used, or to a wallet the keeper voided", async () => {
    setup({ pending: NEW_HOLDER, pendingAt: NOW, vetoed: true });
    show();
    await screen.findByTestId("earlier-replacement");
    expect(screen.queryByTestId("earlier-veto")).toBeNull();
    cleanup();
    setup({ pending: NEW_HOLDER, pendingAt: NOW, barred: HOLDER });
    show();
    await screen.findByTestId("earlier-replacement");
    expect(screen.queryByTestId("earlier-veto")).toBeNull();
  });
});

describe("the page itself", () => {
  it("says the link is incomplete and reads nothing", async () => {
    setup();
    window.location.hash = "#entry=2";
    const { calls } = setup();
    window.location.hash = "#entry=2";
    show();
    expect(await screen.findByTestId("earlier-no-link")).toBeTruthy();
    expect(calls.length).toBe(0);
  });

  it("is closed with investing off", () => {
    setup();
    applyServerSettings(null);
    show();
    expect(screen.getByTestId("earlier-off")).toBeTruthy();
  });

  it("tells where the list stands from the server's counts and this list's size", async () => {
    setup();
    show();
    await waitFor(() =>
      expect(screen.getByTestId("earlier-status").textContent).toMatch(
        /3 of 21 lines agreed/,
      ),
    );
  });
});

const selector = (signature: string) => selectorOf(signature);
