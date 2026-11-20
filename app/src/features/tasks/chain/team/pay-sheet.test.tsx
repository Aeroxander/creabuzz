// The team pays for handed-in work on the network: the card offers the presses, and the sheet reads the task from the chain when
// it opens, pays in full or in part to the wallet that took the task and to nobody else, never sends twice, and writes the
// team's record from the payment the chain gives for the task's number. What stops it is in `pay-sheet-gate.test.tsx`.
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { decodeCall } from "@creaton/core/pot/abi-codec.ts";
import { TREASURY_ABI } from "@creaton/core/pot/abis.generated.ts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { published, SERVER } from "../../../../../tests/helpers/money-harness";
import { STRANGER_EVM } from "../../../../../tests/helpers/pot-harness";
import {
  FOUNDER_KEY,
  handedInTask,
  settled,
  TAKEN_SERIAL,
  TASK_ID,
  WORKER_WALLET,
} from "../../../../../tests/helpers/plan-scene";
import {
  PAID_TX,
  chain,
  numbers,
  setAside,
  show,
  setup,
  chainPays,
  openSheet,
  confirm,
} from "../../../../../tests/helpers/pay-scene";
import { forgetPaid, paidNotRecorded } from "../../paid-journal";
import { exactPhrase } from "./pay-words";

vi.mock(
  "../../../../lib/relay",
  async () =>
    (await import("../../../../../tests/helpers/money-harness")).relayMock,
);

beforeEach(() => {
  applyServerSettings({ investing: true, self: SERVER });
  published.length = 0;
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  localStorage.clear();
  forgetPaid(TASK_ID);
  applyServerSettings(null);
});

describe("the card of a task that is taken on the network", () => {
  it("offers to pay for the work and to send the money back, and nothing to plan", async () => {
    setup();
    show();
    expect((await screen.findByTestId("pay-open")).textContent).toBe(
      "Pay for the work",
    );
    expect(screen.getByTestId("send-back-open").textContent).toBe(
      "Send the money back",
    );
    expect(screen.queryByTestId("door-choice")).toBeNull();
    expect(screen.queryByTestId("withdraw-open")).toBeNull();
  });

  it("offers only to send the money back while the work is not handed in", async () => {
    setup();
    show({ task: handedInTask(numbers, { state: "working", handIn: null }) });
    await screen.findByTestId("send-back-open");
    expect(screen.queryByTestId("pay-open")).toBeNull();
    cleanup();
    // A record that says work was handed in but names no piece has nothing to pay against.
    show({ task: handedInTask(numbers, { handIn: null }) });
    await screen.findByTestId("send-back-open");
    expect(screen.queryByTestId("pay-open")).toBeNull();
  });

  it("offers nothing to anyone who does not run the project", async () => {
    setup();
    show({ address: STRANGER_EVM });
    await settled();
    expect(screen.queryByTestId("pay-presses")).toBeNull();
    expect(screen.queryByTestId("pay-open")).toBeNull();
    expect(screen.queryByTestId("send-back-open")).toBeNull();
  });

  it("offers nothing once the deadline has passed: the network ends the task by itself", async () => {
    setup();
    const late = numbers.asOf.time + 30 * 86_400;
    // Positive control: the same card before the deadline offers both.
    show();
    await screen.findByTestId("pay-open");
    cleanup();
    show({ now: late });
    await settled();
    expect(screen.queryByTestId("pay-presses")).toBeNull();
  });
});

describe("the pay sheet", () => {
  it("reads the task from the network when it opens and shows who is paid and what is set aside", async () => {
    setup();
    show();
    await openSheet();
    expect(screen.getByTestId("accept-pay-to").textContent).toContain(
      WORKER_WALLET,
    );
    expect(screen.getByTestId("accept-set-aside").textContent).toMatch(
      /^\d[\d,.]* dollars, due /,
    );
    expect(chain.reads.map((r) => r.name)).toEqual(
      expect.arrayContaining(["tasks", "taskOf"]),
    );
    expect(chain.reads.find((r) => r.name === "taskOf")?.args).toEqual([
      BigInt(TAKEN_SERIAL),
    ]);
    expect(screen.getByTestId("sheet-play-money").textContent).toMatch(
      /play money/,
    );
    expect(confirm().textContent).toBe(`Pay ${exactPhrase(setAside)}`);
  });

  it("pays all of it by one call to the wallet that took the task, and the call has no recipient", async () => {
    setup();
    show();
    await openSheet();
    fireEvent.click(confirm());
    await waitFor(() => expect(chain.sent).toHaveLength(1));
    const [sent] = chain.sent;
    expect(sent?.to).toBe(numbers.contracts.treasury);
    const call = decodeCall(TREASURY_ABI, sent?.data ?? "");
    expect(call?.name).toBe("acceptTask");
    expect(call?.args).toEqual([BigInt(TAKEN_SERIAL), setAside]);
  });

  it("pays part: the amount typed is what the call carries, and the sheet says what goes back", async () => {
    setup();
    show();
    await openSheet();
    fireEvent.click(screen.getByTestId("accept-part"));
    fireEvent.change(await screen.findByTestId("accept-amount"), {
      target: { value: "12.50" },
    });
    expect(confirm().textContent).toBe("Pay 12.50 dollars");
    expect(screen.getByTestId("accept-left").textContent).toMatch(
      /What is left goes back to the project and to the people who took out while it was set aside\. \d[\d.,]* dollars go back\./,
    );
    fireEvent.click(confirm());
    await waitFor(() => expect(chain.sent).toHaveLength(1));
    const call = decodeCall(TREASURY_ABI, chain.sent[0]?.data ?? "");
    expect(call?.args).toEqual([BigInt(TAKEN_SERIAL), 12_500_000n]);
  });

  it.each([
    ["", /Type how much to pay/],
    ["abc", /numbers only/],
    ["0.50", /at least 1 dollar/],
    ["12.345", /dollars and cents/],
    ["1000000", /at most/],
  ])("does not let %j be pressed: it says what is wrong", async (typed, words) => {
    setup();
    show();
    await openSheet();
    fireEvent.click(screen.getByTestId("accept-part"));
    fireEvent.change(await screen.findByTestId("accept-amount"), {
      target: { value: typed },
    });
    expect(confirm().disabled).toBe(true);
    if (typed !== "") expect(screen.getByText(words)).toBeTruthy();
    expect(chain.sent).toEqual([]);
  });

  it("a double press sends one call", async () => {
    setup();
    chain.holdReceipts = true;
    show();
    await openSheet();
    fireEvent.click(confirm());
    fireEvent.click(confirm());
    await waitFor(() => expect(chain.sent).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(chain.sent).toHaveLength(1);
  });

  it("a payment that landed writes the team's record with the transaction the network gives for this task's number", async () => {
    setup();
    chain.onSend = () => chainPays(setAside);
    show();
    await openSheet();
    fireEvent.click(confirm());
    await waitFor(() => expect(published).toHaveLength(1));
    const record = published[0] as { tags: string[][] };
    const tag = (name: string) => record.tags.find((t) => t[0] === name)?.[1];
    expect(tag("task-part")).toBe("confirm");
    expect(tag("task-paid")).toBe(PAID_TX);
    expect(tag("task-evidence")).toBe("ab".repeat(32));
    // The transaction is not the hash the wallet gave for the send.
    expect(chain.sent).toHaveLength(1);
    expect(PAID_TX).not.toBe(`0x${"1".padStart(64, "0")}`);
    // Once the record is on the server the remembered payment is forgotten.
    await waitFor(() => expect(paidNotRecorded(TASK_ID)).toBeNull());
  });

  it("for work already accepted with the pay owed, the record is a second confirmation of the same piece", async () => {
    setup();
    chain.onSend = () => chainPays(setAside);
    show({
      task: handedInTask(numbers, {
        state: "accepted",
        acceptedBy: FOUNDER_KEY,
        acceptedAt: numbers.asOf.time - 100,
      }),
    });
    await openSheet();
    fireEvent.click(confirm());
    await waitFor(() => expect(published).toHaveLength(1));
    const record = published[0] as { tags: string[][]; content: string };
    expect(JSON.parse(record.content).title).toBe("Pay recorded");
    expect(record.tags.find((t) => t[0] === "task-paid")?.[1]).toBe(PAID_TX);
  });

  it("does not write a record when the network cannot say which transaction paid", async () => {
    setup();
    chain.logs = [];
    chain.onSend = () => chainPays(setAside);
    show();
    await openSheet();
    fireEvent.click(confirm());
    await waitFor(() => expect(chain.sent).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 100));
    expect(published).toEqual([]);
  });
});

describe("keyboard, focus and names", () => {
  it("Escape closes the sheet, sends nothing, and focus goes back to the button that opened it", async () => {
    setup();
    show();
    const opener = await screen.findByTestId("pay-open");
    opener.focus();
    fireEvent.click(opener);
    await screen.findByTestId("accept-pay-to");
    fireEvent.keyDown(screen.getByTestId("accept-sheet"), { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByTestId("accept-sheet")).toBeNull(),
    );
    expect(chain.sent).toEqual([]);
    expect(document.activeElement).toBe(screen.getByTestId("pay-open"));
  });

  it("the choice is a group with a legend and radios, the amount has its label, and each press has one owner of its name", async () => {
    setup();
    show();
    await openSheet();
    const group = screen.getByRole("group", { name: "How much to pay" });
    expect(group).toBeTruthy();
    expect(screen.getAllByRole("radio")).toHaveLength(2);
    expect(screen.getByRole("radio", { name: /^Pay all / })).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "Pay part" }));
    fireEvent.change(
      await screen.findByRole("textbox", { name: "Amount to pay, in dollars" }),
      { target: { value: "5" } },
    );
    expect(screen.getByText("Pay to").tagName).toBe("DT");
    expect(screen.getByText("Set aside").tagName).toBe("DT");
    expect(screen.getAllByRole("button", { name: /^Pay \d/ })).toHaveLength(1);
  });
});
