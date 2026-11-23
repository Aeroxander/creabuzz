// The Council section of the Team part: the five seats with their names and short addresses, "You" on the reader's own,
// "Open seat" for a vacant one, when two come up, the seat holder's waiting list and the last line — and, for a project
// that runs alone or as a Pair, nothing at all. A record that says it runs on a Council but whose Council cannot be read
// says so and offers no press. Every sentence is compared with the words module's own, so none is retyped here.
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { decodeCall } from "@creaton/core/pot/abi-codec.ts";
import { COUNCIL_ABI } from "@creaton/core/pot/abis.generated.ts";
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACCOUNTS,
  councilPlain,
  councilRecord,
} from "../../../tests/helpers/council-v2-parse";
import {
  installWallet,
  sent,
  SERVER,
  wrap,
} from "../../../tests/helpers/money-harness";
import {
  councilLastLine,
  councilSummary,
  nextElectionLine,
  seatLine,
} from "./council-words";
import { CouncilSection } from "./CouncilSection";

vi.mock(
  "../../lib/relay",
  async () => (await import("../../../tests/helpers/money-harness")).relayMock,
);

const nameOf = (address: string) =>
  address === ACCOUNTS[0]
    ? "Fred"
    : `${address.slice(0, 6)}…${address.slice(-4)}`;

function show(
  numbers = councilRecord("voting"),
  address: string | null = null,
) {
  return wrap(
    <CouncilSection
      address={address}
      nameOf={nameOf}
      now={numbers.asOf.time}
      numbers={numbers}
    />,
  );
}

beforeEach(() => applyServerSettings({ investing: true, self: SERVER }));
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  localStorage.clear();
  applyServerSettings(null);
});

describe("the Council section", () => {
  it("a seat holder can give up their seat: what it does is said first, and it is sent from their own account", async () => {
    installWallet({ account: ACCOUNTS[1] as string });
    show(councilRecord("voting"), ACCOUNTS[1] as string);
    fireEvent.click(await screen.findByTestId("resign-open"));
    const sheet = await screen.findByTestId("resign-sheet");
    expect(sheet.textContent).toContain(
      "Your seat comes up first at the next vote, which fills it again.",
    );
    expect(sheet.textContent).toContain(
      "Every call waiting for the seats' agreement now stops.",
    );
    expect(sheet.textContent).toContain(
      "Nothing else changes: the project keeps running with the seats that are left, and taking out stays open.",
    );
    fireEvent.click(within(sheet).getByTestId("sheet-confirm"));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.from).toBe(ACCOUNTS[1] as string);
    expect(sent[0]?.to).toBe(
      councilRecord("voting").council?.contract.toLowerCase(),
    );
    expect(decodeCall(COUNCIL_ABI, sent[0]?.data ?? "")?.name).toBe("resign");
  });

  it("an account that holds no seat is offered no way to give one up", () => {
    show(councilRecord("voting"), "0x000000000000000000000000000000000000dead");
    expect(screen.queryByTestId("resign-open")).toBeNull();
  });

  it("says what the Council is, its five seats with short addresses, when two come up, and the last line", () => {
    const numbers = councilRecord("voting");
    const council = numbers.council;
    if (!council) throw new Error("the record has no Council");
    show(numbers);
    expect(screen.getByTestId("council-section")).toBeTruthy();
    expect(screen.getByTestId("council-summary").textContent).toBe(
      councilSummary(council),
    );
    const seats = screen.getAllByTestId("council-seat");
    expect(seats).toHaveLength(5);
    expect(seats[0]?.textContent).toContain(
      seatLine({
        index: 0,
        isMe: false,
        nameOf,
        seat: council.seats[0],
      }),
    );
    // The short address is beside the name, once.
    expect(seats[0]?.textContent).toContain("0x7099…79c8");
    expect(screen.getByTestId("council-next-election").textContent).toBe(
      nextElectionLine({ council, now: numbers.asOf.time, voteOpen: false }),
    );
    expect(screen.getByTestId("council-last-line").textContent).toBe(
      councilLastLine(5),
    );
  });

  it("says 'You' on the reader's own seat and 'Open seat' for a vacant one", () => {
    const me = ACCOUNTS[2] as string;
    const numbers = councilRecord("voting", (r) => {
      r.council.seats[4] = { account: null, seatedAt: null };
    });
    const council = numbers.council;
    if (!council) throw new Error("the record has no Council");
    show(numbers, me);
    const seats = screen.getAllByTestId("council-seat");
    expect(seats[2]?.textContent).toContain("Seat 3: You");
    expect(seats[4]?.textContent).toContain("Seat 5: Open seat");
    expect(seats[4]?.textContent).not.toContain("0x");
    // A seat holder's waiting list stays with the record's own count: it is not drawn here with no wallet.
    expect(screen.getByTestId("council-propose-line")).toBeTruthy();
  });

  it("shows nothing at all for a project that runs alone or as a Pair, or for an older record", () => {
    show(councilPlain());
    expect(screen.queryByTestId("council-section")).toBeNull();
    const pair = councilRecord("voting", (r) => {
      r.runner = {
        address: "0x9a0000000000000000000000000000000000a1b2",
        isPair: true,
        signers: [ACCOUNTS[0], ACCOUNTS[1]],
      };
      delete r.council;
    });
    show(pair);
    expect(screen.queryByTestId("council-section")).toBeNull();
  });

  it("says the Council could not be read, and offers no press, when the record says it runs on one", () => {
    const numbers = councilRecord("voting", (r) => {
      r.council = null;
    });
    show(numbers);
    expect(screen.getByTestId("council-unreadable").textContent).toBe(
      "The Council could not be read right now, so nothing is shown about it. Nothing changed. Reload the page in a moment to look again.",
    );
    expect(screen.queryByTestId("council-seats")).toBeNull();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});
