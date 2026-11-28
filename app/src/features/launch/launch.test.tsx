// Launching a project from its page: the card a founder sees, the sheet (nothing is typed: the two starting numbers are the
// same for every project), and the one call it sends. Every state: not the founder, a build with no network, the wallet's own
// gates, the Launcher's settings unreadable, ceilings under the starting numbers, a change of settings between the sheet and the signature, a refused send, a double press, a launch that
// already landed (only the tie is offered), and the tie that fails and is pressed again. The call is decoded and compared with
// what the sheet showed.
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { decodeCall } from "@creaton/core/pot/abi-codec.ts";
import { LAUNCHER_ABI } from "@creaton/core/pot/abis.generated.ts";
import { chainKeyOf } from "@creaton/core/launchpad/project-chain.ts";
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seriousViolations } from "../../../tests/helpers/axe-dom";
import { published, SERVER, wrap } from "../../../tests/helpers/money-harness";
import {
  installPotChain,
  type PotChain,
} from "../../../tests/helpers/pot-chain";
import {
  FOUNDER_EVM,
  nameTheNetwork,
  numbersFor,
  S,
} from "../../../tests/helpers/pot-harness";
import { parseProject, type Project } from "../project/project-record";
import { launchIdentity } from "./launch-ids";
import { LaunchCard } from "./LaunchCard";

vi.mock(
  "../../lib/relay",
  async () => (await import("../../../tests/helpers/money-harness")).relayMock,
);
vi.mock("../../lib/account", () => ({
  useAccount: () => ({ pubkey: "b".repeat(64), locked: false }),
}));
vi.mock("@tanstack/react-router", async (actual) => ({
  ...(await actual<object>()),
  Link: ({ children }: { children: ReactNode }) => <a href="/p">{children}</a>,
}));

const numbers = numbersFor();
const HASH = `0x${"ab".repeat(32)}`;
const NEW_HASH = `0x${"cd".repeat(32)}`;
const OTHER = "0x00000000000000000000000000000000000000b2";
const project = parseProject({
  id: "1".repeat(64),
  pubkey: "b".repeat(64),
  kind: 37001,
  created_at: 1_800_000_000,
  tags: [
    ["d", "lantern"],
    ["name", "Lantern"],
  ],
  content: "{}",
}) as Project;
const { projectId, key } = launchIdentity(project, FOUNDER_EVM);
let chain: PotChain;

/** The Launcher and the contracts it makes projects from, as a chain would answer them. */
function launcherAnswers() {
  return {
    settingsHash: [HASH],
    platform: [numbers.contracts.dollar, OTHER, 200n, 1680n, 25_000_000n],
    MAX_RATE_PPM: [2000n],
    MAX_TEAM_POOL: [100_000_000n * S],
    AGENT_SHARE_DIV: [1000n],
    treasuryImpl: [numbers.contracts.treasury],
    holderPauseImpl: ["0x0000000000000000000000000000000000000000"],
    vesterImpl: [numbers.contracts.vester],
    MIN_JOIN: [1_000_000n],
    CHECK_IN_MULT: [2n],
    WIND_MULT: [26n],
    CLIFF_MULT: [13n],
    VEST_MULT: [104n],
    // Not launched: the Launcher refuses an unknown key with its own error.
    projectByKey: () => {
      throw { code: -32603, message: "execution reverted: UnknownProject()" };
    },
  };
}

function setup(account = FOUNDER_EVM) {
  chain = installPotChain({
    account,
    launcher: numbers.launcher,
    answers: launcherAnswers() as never,
  });
  // A launch that lands makes the project known.
  chain.onSend = () => {
    chain.answers.projectByKey = [
      [
        FOUNDER_EVM,
        numbers.contracts.shares,
        numbers.contracts.team,
        numbers.contracts.treasury,
        numbers.contracts.vester,
        1_800_000_000n,
      ],
    ] as never;
  };
}
const show = (onLaunched?: () => void) =>
  wrap(<LaunchCard onLaunched={onLaunched} project={project} />);
const open = async () => {
  fireEvent.click(await screen.findByTestId("launch-open"));
  await screen.findByTestId("launch-terms");
};
const text = (id: string) => screen.getByTestId(id).textContent ?? "";
const decodeSent = (index = 0) => {
  const call = chain.sent[index];
  if (!call) throw new Error("nothing was sent");
  const found = decodeCall(LAUNCHER_ABI, call.data);
  if (!found) throw new Error("not a Launcher call");
  return { to: call.to, ...found };
};

beforeEach(() => {
  applyServerSettings({ investing: true, self: SERVER });
  nameTheNetwork(numbers);
  published.length = 0;
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  localStorage.clear();
  sessionStorage.clear();
  applyServerSettings(null);
});

describe("the launch card", () => {
  it("names the project, says the dollars are play money, and offers one button", async () => {
    setup();
    show();
    const card = await screen.findByTestId("launch-card");
    expect(card.textContent).toMatch(/Open Lantern to backers/);
    expect(text("launch-play-money")).toMatch(/play money/);
    expect(await screen.findByTestId("launch-open")).not.toBeNull();
    // Nothing was sent by looking.
    expect(chain.sent).toEqual([]);
  });

  it("is nothing in a build that names no network", () => {
    setup();
    vi.unstubAllEnvs();
    vi.stubEnv("VITE_CREATON_CHAIN_ID", "");
    vi.stubEnv("VITE_CREATON_LAUNCHER", "");
    show();
    expect(screen.queryByTestId("launch-card")).toBeNull();
  });

  it("says what is missing before it offers a launch: no wallet", async () => {
    setup();
    (window as unknown as { ethereum?: unknown }).ethereum = undefined;
    show();
    expect((await screen.findByTestId("pot-no-wallet")).textContent).toMatch(
      /browser with a wallet to launch this project/,
    );
    expect(screen.queryByTestId("launch-open")).toBeNull();
  });

  it("says when the network could not be asked whether it is launched already, and offers no launch", async () => {
    setup();
    chain.answers.projectByKey = () => {
      throw { code: -32603, message: "network down" };
    };
    show();
    expect(
      (await screen.findByTestId("launch-check-failed")).textContent,
    ).toMatch(/could not be asked whether this project is already launched/);
    expect(screen.queryByTestId("launch-open")).toBeNull();
  });
});

describe("the launch sheet", () => {
  it("opens with nothing to type: the starting terms in one sentence, and the fee", async () => {
    setup();
    show();
    await open();
    const sheet = screen.getByTestId("launch-sheet");
    expect(within(sheet).queryAllByRole("textbox")).toEqual([]);
    expect(screen.queryByTestId("launch-rate")).toBeNull();
    expect(screen.queryByTestId("launch-pool")).toBeNull();
    expect(text("launch-terms")).toMatch(
      /The team may take 0\.10% of the project's money a day\. Team pool: 10,000,000 Team Shares\. You sign once\./,
    );
    expect(text("launch-fee")).toBe(
      "Creaton takes 2% of the money people put in.",
    );
    expect(screen.queryByTestId("launch-limits")).toBeNull();
    expect(screen.queryByTestId("launch-later")).toBeNull();
    // The settings fingerprint is under "Technical details", not in the main words.
    expect(text("launch-fingerprint")).toContain(HASH);
    expect(text("sheet-play-money")).toMatch(/play money/);
    expect(chain.sent).toEqual([]);
  });

  it("sends one launch call whose numbers are the ones on the sheet, and the hash it read", async () => {
    setup();
    const landed = vi.fn();
    show(landed);
    await open();
    fireEvent.click(screen.getByTestId("sheet-confirm"));
    await waitFor(() => expect(chain.sent.length).toBe(1));
    const call = decodeSent();
    expect(call.to).toBe(numbers.launcher);
    expect(call.name).toBe("launch");
    expect(call.args).toEqual([
      projectId,
      "Lantern",
      "LANTERN",
      [1000n, 10_000_000n * S],
      HASH,
    ]);
    // It lands, the page is tied to the launch, and the founder is taken to the money.
    await waitFor(() => expect(landed).toHaveBeenCalled());
    expect(published).toHaveLength(1);
    const record = published[0] as { tags: string[][] };
    expect(record.tags.find((t) => t[0] === "chain-key")?.[1]).toBe(
      chainKeyOf(FOUNDER_EVM, projectId),
    );
    expect(key).toBe(chainKeyOf(FOUNDER_EVM, projectId));
  });

  it("sends nothing, and says why, when the platform's limits are under the starting numbers", async () => {
    setup();
    chain.answers = { ...chain.answers, MAX_RATE_PPM: [500n] } as never;
    show();
    fireEvent.click(await screen.findByTestId("launch-open"));
    expect(
      (await screen.findByTestId("launch-over-ceiling")).textContent,
    ).toMatch(/limits are under the starting numbers right now, so nothing/);
    expect(screen.queryByTestId("launch-terms")).toBeNull();
    expect(
      (screen.getByTestId("sheet-confirm") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(chain.sent).toEqual([]);
  });

  it("refuses with words, and sends nothing, when Creaton's settings changed between the sheet and the signature; then sends under the new ones", async () => {
    setup();
    show();
    await open();
    expect(text("launch-fingerprint")).toContain(HASH);
    chain.answers.settingsHash = [NEW_HASH];
    fireEvent.click(screen.getByTestId("sheet-confirm"));
    const problem = await screen.findByTestId("sheet-problem");
    expect(problem.textContent).toMatch(
      /Creaton's settings changed while you were deciding\. Nothing was sent/,
    );
    expect(problem.textContent).not.toMatch(/0x|SettingsMoved|revert/);
    expect(chain.sent).toEqual([]);
    // The sheet shows the new settings now; pressing again sends under them.
    await waitFor(() => expect(text("launch-fingerprint")).toContain(NEW_HASH));
    fireEvent.click(screen.getByTestId("sheet-confirm"));
    await waitFor(() => expect(chain.sent.length).toBe(1));
    expect(decodeSent().args[4]).toBe(NEW_HASH);
  });

  it("says the Launcher's own refusal in words when the settings moved after the check", async () => {
    setup();
    show();
    await open();
    chain.refuse = "execution reverted: SettingsMoved()";
    fireEvent.click(screen.getByTestId("sheet-confirm"));
    const problem = await screen.findByTestId("sheet-problem");
    expect(problem.textContent).toMatch(/settings changed/);
    expect(problem.textContent).not.toMatch(/SettingsMoved/);
    expect(chain.sent).toEqual([]);
  });

  it("says what happened when the wallet says no, and leaves the press to try again", async () => {
    setup();
    show();
    await open();
    chain.refuse = "You rejected the request in your wallet.";
    fireEvent.click(screen.getByTestId("sheet-confirm"));
    expect((await screen.findByTestId("sheet-problem")).textContent).toMatch(
      /You said no in your wallet\. Nothing was sent\./,
    );
    const press = screen.getByTestId("sheet-confirm") as HTMLButtonElement;
    expect(press.disabled).toBe(false);
    fireEvent.click(press);
    await waitFor(() => expect(chain.sent.length).toBe(1));
  });

  it("a double press sends once", async () => {
    setup();
    show();
    await open();
    const press = screen.getByTestId("sheet-confirm");
    fireEvent.click(press);
    fireEvent.click(press);
    fireEvent.click(press);
    await waitFor(() => expect(chain.sent.length).toBe(1));
    await new Promise((r) => setTimeout(r, 100));
    expect(chain.sent.length).toBe(1);
  });

  it("when the Launcher's settings cannot be read it says so, sends nothing, and offers to try again", async () => {
    setup();
    const answers = chain.answers;
    chain.answers = {
      ...answers,
      settingsHash: () => {
        throw { code: -32603, message: "network down" };
      },
    } as never;
    show();
    fireEvent.click(await screen.findByTestId("launch-open"));
    expect(
      (await screen.findByTestId("launch-read-failed")).textContent,
    ).toMatch(/could not be read, so nothing was sent/);
    expect(
      (screen.getByTestId("sheet-confirm") as HTMLButtonElement).disabled,
    ).toBe(true);
    chain.answers = answers;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByTestId("launch-terms");
  });

  it("Escape closes it and focus goes back to the button that opened it", async () => {
    setup();
    show();
    const opener = await screen.findByTestId("launch-open");
    opener.focus();
    fireEvent.click(opener);
    await screen.findByTestId("launch-terms");
    fireEvent.keyDown(screen.getByTestId("launch-sheet"), { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByTestId("launch-sheet")).toBeNull(),
    );
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("the sheet is named, every button has a name, and there is no serious accessibility violation", async () => {
    setup();
    show();
    await open();
    expect(
      screen.getByRole("dialog", { name: /Launch Lantern/ }),
    ).not.toBeNull();
    expect(await seriousViolations()).toEqual([]);
  });
});

describe("a launch that already landed", () => {
  it("offers only the tie, never a second launch, and sends nothing on the chain", async () => {
    setup();
    chain.answers.projectByKey = [
      [
        FOUNDER_EVM,
        numbers.contracts.shares,
        numbers.contracts.team,
        numbers.contracts.treasury,
        numbers.contracts.vester,
        1_800_000_000n,
      ],
    ] as never;
    const linked = vi.fn();
    show(linked);
    expect((await screen.findByTestId("launch-unlinked")).textContent).toMatch(
      /It is on the network from this wallet\. One step is left/,
    );
    expect(screen.queryByTestId("launch-open")).toBeNull();
    fireEvent.click(screen.getByTestId("launch-finish"));
    await waitFor(() => expect(linked).toHaveBeenCalled());
    expect(chain.sent).toEqual([]);
    expect(published).toHaveLength(1);
  });

  it("a tie that fails says so and the same press tries again", async () => {
    setup();
    chain.answers.projectByKey = [
      [
        FOUNDER_EVM,
        numbers.contracts.shares,
        numbers.contracts.team,
        numbers.contracts.treasury,
        numbers.contracts.vester,
        1_800_000_000n,
      ],
    ] as never;
    const relay = await import("../../../tests/helpers/money-harness");
    const publish = vi
      .spyOn(relay.relayMock, "publishAsUser")
      .mockRejectedValueOnce(new Error("Your page could not be saved."));
    show();
    fireEvent.click(await screen.findByTestId("launch-finish"));
    expect((await screen.findByTestId("launch-problem")).textContent).toBe(
      "Your page could not be saved.",
    );
    const again = screen.getByTestId("launch-finish") as HTMLButtonElement;
    expect(again.disabled).toBe(false);
    fireEvent.click(again);
    await waitFor(() => expect(published).toHaveLength(1));
    publish.mockRestore();
  });
});
