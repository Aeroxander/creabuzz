// The stand sheet (`docs/next-version/COUNCIL-PLAN.md` section 6.2): one sheet, three modes; one press that signs a short
// text and then sends the chain call; the plan's words word for word; the five account fields' Tab/Enter/paste behaviour;
// the live count; and a second step that fails kept for a retry without signing again.
import { decodeCall } from "@creaton/core/pot/abi-codec.ts";
import { HOLDER_VOTE_ABI } from "@creaton/core/pot/abis.generated.ts";
import {
  encodeParameters,
  selectorOf,
} from "@creaton/core/launchpad/evmAbi.ts";
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACCOUNTS,
  councilRecord,
  LIST,
  NOW,
} from "../../../tests/helpers/council-v2-parse";
import {
  installWallet,
  published,
  sent,
  serve,
  wrap,
} from "../../../tests/helpers/money-harness";
import { nameTheNetwork } from "../../../tests/helpers/pot-harness";
import { StandSheet } from "./StandSheet";

vi.mock(
  "../../lib/relay",
  async () => (await import("../../../tests/helpers/money-harness")).relayMock,
);

const COORDINATE = `37001:${"b".repeat(64)}:demo`;
const ME = "0x1111111111111111111111111111111111111111";
const short = (address: string) =>
  `${address.slice(0, 6)}…${address.slice(-4)}`;
const nameOf = (address: string) => short(address);

/** The record a sheet is opened on: a replace ballot for a list, a seat ballot for a person, no ballot for opening one. */
type Mode = "person" | "list" | "open";
function recordFor(mode: Mode) {
  if (mode === "person") return councilRecord("seats");
  if (mode === "list") return councilRecord("voting");
  return councilRecord("voting", (r) => {
    r.vote.open = null;
  });
}

function show(
  mode: Mode,
  options: { onClose?: () => void; text?: string } = {},
) {
  const record = recordFor(mode);
  nameTheNetwork(record);
  const view = wrap(
    <StandSheet
      mode={mode}
      nameOf={nameOf}
      now={NOW}
      numbers={record}
      onClose={options.onClose ?? (() => undefined)}
      open
      projectCoordinate={COORDINATE}
    />,
  );
  return view;
}

/** Answer `nextBallot()` from the vote contract (what an opening vote will be numbered). */
function answerNextBallot(ballot: bigint) {
  const eth = (window as unknown as { ethereum: { request: unknown } })
    .ethereum as { request: (args: unknown) => Promise<unknown> };
  const original = eth.request.bind(eth);
  eth.request = async (args: unknown) => {
    const call = args as { method?: string; params?: { data?: string }[] };
    if (call.method === "eth_call") {
      const data = String(call.params?.[0]?.data ?? "");
      if (data.startsWith(selectorOf("nextBallot()")))
        return encodeParameters(["uint32"], [ballot]);
    }
    return original(args);
  };
}

/** Make the wallet refuse the next transaction, as a network that answered a call with a revert would. */
function refuseNextSend() {
  const eth = (window as unknown as { ethereum: { request: unknown } })
    .ethereum as { request: (args: unknown) => Promise<unknown> };
  const original = eth.request.bind(eth);
  let once = true;
  eth.request = async (args: unknown) => {
    const call = args as { method?: string };
    if (once && call.method === "eth_sendTransaction") {
      once = false;
      throw { code: -32603, message: "execution reverted: NotEligible" };
    }
    return original(args);
  };
}

beforeEach(() => {
  applyServerSettings({ investing: true, self: "f".repeat(64) });
  installWallet({ account: ME });
  serve([]);
  published.length = 0;
  sent.length = 0;
});
afterEach(() => {
  cleanup();
  applyServerSettings(null);
  vi.unstubAllEnvs();
});

describe("the sheet's words", () => {
  it("carries the plan's label, promise line, public line and banner once", async () => {
    show("list");
    await screen.findByTestId("stand-text");
    expect(
      screen.getByLabelText(
        "Say in a few words who you are and what you would do",
      ),
    ).toBeTruthy();
    expect(screen.getByTestId("stand-promise").textContent).toBe(
      "Do not promise anyone a profit or a return.",
    );
    expect(screen.getByTestId("stand-public").textContent).toBe(
      "Posts and votes are public.",
    );
    expect(screen.getByTestId("stand-no-removal").textContent).toBe(
      "You cannot take your name off once you stand.",
    );
    expect(
      screen.getAllByText(
        "You can take your money out any time. Nothing here promises a profit.",
      ),
    ).toHaveLength(1);
    expect(screen.getByText("Put forward this list")).toBeTruthy();
  });

  it("says why the press cannot run while the words are empty, and stops saying it once they are written", async () => {
    show("person");
    await screen.findByTestId("stand-text");
    expect(
      screen.getByTestId("stand-confirm").getAttribute("disabled"),
    ).not.toBeNull();
    expect(screen.getByTestId("stand-needs-words").textContent).toBe(
      "Write your words above to stand.",
    );
    fireEvent.change(screen.getByTestId("stand-text"), {
      target: { value: "I would keep the marketplace open on Fridays." },
    });
    expect(screen.queryByTestId("stand-needs-words")).toBeNull();
    expect(
      screen.getByTestId("stand-confirm").getAttribute("disabled"),
    ).toBeNull();
  });

  it("says what opening a vote starts, in the rule's own numbers", async () => {
    show("open");
    await screen.findByTestId("stand-text");
    expect(screen.getByTestId("stand-opening").textContent).toBe(
      "This opens a vote. For the first one day anyone with parked Shares can put forward a list. Then holders vote for three days. Nothing changes for 16.5 days after that, so anyone can take their money out first. Parked Shares also count toward pausing the project's spending.",
    );
    expect(screen.getByRole("button", { name: "Open the vote" })).toBeTruthy();
  });

  it("keeps the press off until the text says something, and counts the characters out loud", async () => {
    show("person");
    await screen.findByTestId("stand-text");
    const press = screen.getByTestId("stand-confirm");
    expect(press.textContent).toBe("Stand");
    expect(press.hasAttribute("disabled")).toBe(true);
    const count = screen.getByTestId("stand-count");
    expect(count.getAttribute("aria-live")).toBe("polite");
    expect(count.textContent).toBe("0 of 280 characters");
    const words = "I would open the shop on Sundays.";
    fireEvent.change(screen.getByTestId("stand-text"), {
      target: { value: words },
    });
    expect(screen.getByTestId("stand-count").textContent).toBe(
      `${words.length} of 280 characters`,
    );
    expect(press.hasAttribute("disabled")).toBe(false);
  });
});

describe("one press signs the text, then sends the call", () => {
  it("stands a person: the record names the ballot, the proposer and the account, and the call carries its id", async () => {
    const onClose = vi.fn();
    show("person", { onClose });
    await screen.findByTestId("stand-text");
    fireEvent.change(screen.getByTestId("stand-text"), {
      target: { value: "I would keep the marketplace open on Fridays." },
    });
    fireEvent.click(screen.getByTestId("stand-confirm"));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(published).toHaveLength(1);
    const signed = published[0] as {
      id: string;
      tags: string[][];
      content: string;
    };
    const tag = (name: string) =>
      signed.tags.find((t) => t[0] === name)?.[1] ?? null;
    expect(tag("a")).toBe(COORDINATE);
    expect(tag("candidacy")).toBe("3");
    expect(tag("t")).toBe(`vote:${recordFor("person").key.toLowerCase()}:3`);
    expect(tag("proposer")).toBe(ME);
    expect(
      signed.tags.filter((t) => t[0] === "candidate").map((t) => t[1]),
    ).toEqual([ME]);
    expect(JSON.parse(signed.content)).toEqual({
      v: 1,
      text: "I would keep the marketplace open on Fridays.",
    });
    // The chain call carries the signed record's id, and goes to the vote contract the record names.
    expect(sent[0]?.to).toBe(recordFor("person").vote?.contract);
    const call = decodeCall(HOLDER_VOTE_ABI, sent[0]?.data ?? "");
    expect(call?.name).toBe("stand");
    expect(call?.args).toEqual([`0x${signed.id}`]);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("keeps the signed id when the second step fails, so pressing again sends without signing again", async () => {
    show("list");
    await screen.findByTestId("stand-text");
    const values = [
      ACCOUNTS[0],
      ACCOUNTS[1],
      ACCOUNTS[2],
      ACCOUNTS[3],
      ACCOUNTS[4],
    ];
    values.forEach((address, i) => {
      fireEvent.change(screen.getByTestId(`stand-seat-${i + 1}`), {
        target: { value: address as string },
      });
    });
    fireEvent.change(screen.getByTestId("stand-text"), {
      target: { value: "Five accounts who would keep the room open." },
    });
    refuseNextSend();
    fireEvent.click(screen.getByTestId("stand-confirm"));
    const problem = await screen.findByTestId("stand-problem");
    expect(problem.textContent).toBe(
      "To stand you need Shares parked from before the vote opened. Nothing was sent.",
    );
    expect(problem.textContent).not.toMatch(/NotEligible|execution reverted/);
    expect(screen.getByTestId("stand-signed").textContent).toBe(
      "Your text is signed. Press again to send it; nothing was sent yet.",
    );
    expect(published).toHaveLength(1);
    expect(sent).toHaveLength(0);
    fireEvent.click(screen.getByTestId("stand-confirm"));
    await waitFor(() => expect(sent).toHaveLength(1));
    // One signature for the text, not two.
    expect(published).toHaveLength(1);
    // A list goes as five accounts and the signed id; the shared decoder does not read fixed-size arrays, so the data is
    // checked for the addresses and the id it must carry.
    expect(sent[0]?.to).toBe(recordFor("list").vote?.contract);
    const data = (sent[0]?.data ?? "").toLowerCase();
    for (const address of values)
      expect(data).toContain((address as string).slice(2).toLowerCase());
    expect(data).toContain((published[0] as { id: string }).id.toLowerCase());
  });
});

describe("the five account fields", () => {
  it("reads an account's name or pasted address, says what it understood, counts only five different accounts", async () => {
    show("list");
    await screen.findByTestId("stand-text");
    const first = screen.getByTestId("stand-seat-1");
    fireEvent.change(first, {
      target: { value: short(ACCOUNTS[0] as string) },
    });
    // The hint says what the field understood, with the account's short address.
    expect(
      screen.getByText(
        `${short(ACCOUNTS[0] as string)} · ${short(ACCOUNTS[0] as string)}`,
      ),
    ).toBeTruthy();
  });

  it("fills all five on a paste of five addresses", async () => {
    show("list");
    await screen.findByTestId("stand-text");
    const first = screen.getByTestId("stand-seat-1");
    fireEvent.paste(first, {
      clipboardData: {
        getData: () =>
          [
            ACCOUNTS[0],
            ACCOUNTS[1],
            ACCOUNTS[2],
            ACCOUNTS[3],
            ACCOUNTS[4],
          ].join("\n"),
      },
    });
    for (let i = 0; i < 5; i += 1) {
      expect(
        (screen.getByTestId(`stand-seat-${i + 1}`) as HTMLInputElement).value,
      ).toBe(ACCOUNTS[i]);
    }
    fireEvent.change(screen.getByTestId("stand-text"), {
      target: { value: "Five accounts." },
    });
    expect(screen.getByTestId("stand-confirm").hasAttribute("disabled")).toBe(
      false,
    );
  });

  it("moves on with Enter, and refuses a list with the same account twice", async () => {
    show("list");
    await screen.findByTestId("stand-text");
    const first = screen.getByTestId("stand-seat-1") as HTMLInputElement;
    fireEvent.change(first, { target: { value: ACCOUNTS[0] as string } });
    fireEvent.keyDown(first, { key: "Enter" });
    expect(document.activeElement).toBe(screen.getByTestId("stand-seat-2"));
    fireEvent.change(first, { target: { value: ACCOUNTS[0] as string } });
    fireEvent.change(screen.getByTestId("stand-seat-2"), {
      target: { value: ACCOUNTS[0] as string },
    });
    fireEvent.change(screen.getByTestId("stand-text"), {
      target: { value: "Five accounts." },
    });
    expect(
      screen.getAllByText("A list needs five different accounts.").length,
    ).toBeGreaterThan(0);
    expect(screen.getByTestId("stand-confirm").hasAttribute("disabled")).toBe(
      true,
    );
  });
});

describe("opening a replace vote", () => {
  it("reads the ballot the vote will get and sends the opener's own list with the text", async () => {
    answerNextBallot(7n);
    show("open");
    await screen.findByTestId("stand-text");
    const values = LIST;
    values.forEach((address, i) => {
      fireEvent.change(screen.getByTestId(`stand-seat-${i + 1}`), {
        target: { value: address as string },
      });
    });
    fireEvent.change(screen.getByTestId("stand-text"), {
      target: { value: "We would keep the marketplace open." },
    });
    fireEvent.click(screen.getByTestId("stand-confirm"));
    await waitFor(() => expect(sent).toHaveLength(1));
    const signed = published[0] as { id: string; tags: string[][] };
    expect(signed.tags.find((t) => t[0] === "candidacy")?.[1]).toBe("7");
    expect(sent[0]?.to).toBe(recordFor("open").vote?.contract);
    const data = (sent[0]?.data ?? "").toLowerCase();
    for (const address of values)
      expect(data).toContain((address as string).slice(2).toLowerCase());
    expect(data).toContain(signed.id.toLowerCase());
  });
});
