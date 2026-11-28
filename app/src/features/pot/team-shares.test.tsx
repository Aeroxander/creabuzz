// Team Shares: the runner grants from the pool (each grant on its own clock), a member sees their grants, what has unlocked,
// claims it, and can give up the part that has not. The screens say plainly that Team Shares claim only the project's money
// above what backers put in, and each call is made from the numbers on its sheet.
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { decodeCall } from "@creaton/core/pot/abi-codec.ts";
import {
  PAIR_ABI,
  TREASURY_ABI,
  VESTER_ABI,
} from "@creaton/core/pot/abis.generated.ts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SERVER, wrap } from "../../../tests/helpers/money-harness";
import {
  installPotChain,
  type PotChain,
} from "../../../tests/helpers/pot-chain";
import {
  BACKER_EVM,
  FOUNDER_EVM,
  nameTheNetwork,
  numbersFor,
  S,
} from "../../../tests/helpers/pot-harness";
import type { ProjectNumbers } from "../money/numbers";
import { sharesWords } from "../money/copy";
import type { GrantMember } from "./GrantSheet";
import { TeamSharesSection } from "./TeamSharesSection";

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
// The example's third grant: a member whose first unlock date has not come.
const MEMBER = "0x14dc79964da2c08b23698b3d3cc7ca32193d9955";
const PAIR = "0x00000000000000000000000000000000000000a1";
const ANNA: GrantMember = {
  pubkey: "a".repeat(64),
  name: "Anna",
  address: BACKER_EVM,
};
const NOWALLET: GrantMember = {
  pubkey: "c".repeat(64),
  name: "Carl",
  address: null,
};
let chain: PotChain;

function setup(
  account: string,
  grant: Partial<{
    state: bigint;
    burnAt: bigint;
    total: bigint;
    claimed: bigint;
    burn: bigint;
    prot: boolean;
    vested: bigint;
    claimable: bigint;
    accrued: bigint;
  }> = {},
) {
  const g = {
    state: 0n,
    burnAt: 0n,
    total: 100_000n * S,
    claimed: 0n,
    burn: 0n,
    prot: false,
    vested: 0n,
    claimable: 0n,
    accrued: 4_000n * S,
    ...grant,
  };
  chain = installPotChain({
    account,
    answers: {
      idsOf: [[2n]],
      grantOf: [
        [account, g.prot, g.state, g.burnAt, g.total, g.claimed, 0n, g.burn],
      ],
      vestedOf: [g.vested],
      claimableOf: [g.claimable],
      accruedOf: [g.accrued],
      // The Vester's `claimable` shares its name with nothing else; the Treasury's reads are not asked here.
      claimable: [g.claimable],
    } as never,
  });
}
const show = (
  n: ProjectNumbers = numbers,
  address: string | null = FOUNDER_EVM,
) =>
  wrap(
    <TeamSharesSection
      address={address}
      members={[ANNA, NOWALLET]}
      numbers={n}
    />,
  );

beforeEach(() => {
  applyServerSettings({ investing: true, self: SERVER });
  nameTheNetwork(numbers);
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  localStorage.clear();
  applyServerSettings(null);
});

describe("Team Shares says what they are", () => {
  it("that they claim only the project's money above what backers put in, and what the team's side gets", async () => {
    setup(FOUNDER_EVM);
    show();
    const words =
      (await screen.findByTestId("team-shares-words")).textContent ?? "";
    expect(words).toMatch(
      /claim only the project's money above what backers put in/,
    );
    expect(words).toMatch(/Team's side gets \d+% of that/);
    expect(words).toMatch(/worth nothing/);
  });
  it("is not shown to someone who neither runs the project nor holds a grant", () => {
    setup(BACKER_EVM);
    show(numbers, BACKER_EVM);
    expect(screen.queryByTestId("team-shares")).toBeNull();
  });
});

describe("grant Team Shares", () => {
  async function open() {
    setup(FOUNDER_EVM);
    show();
    fireEvent.click(await screen.findByTestId("grant-open"));
    await screen.findByTestId("grant-pool");
  }
  it("shows the pool, the clock of a grant and the Team Shares' limit, and sends the member and amount typed", async () => {
    await open();
    expect(screen.getByTestId("grant-pool").textContent).toContain(
      `${sharesWords(numbers.team.ungranted)} of the ${sharesWords(numbers.team.pool)} Team Shares are left to grant`,
    );
    expect(screen.getByTestId("grant-clock").textContent).toMatch(
      /Each grant has its own clock.*about 91 days.*about 728 days/s,
    );
    expect(screen.getByTestId("grant-clock").textContent).toMatch(
      /claim only the project's money above what backers put in/,
    );
    fireEvent.change(screen.getByLabelText("Grant to"), {
      target: { value: ANNA.pubkey },
    });
    fireEvent.change(screen.getByLabelText("How many Team Shares?"), {
      target: { value: "1,500" },
    });
    expect(screen.getByTestId("grant-terms").textContent).toMatch(
      new RegExp(`1,500 Team Shares go to Anna \\(${BACKER_EVM}\\)`),
    );
    fireEvent.click(screen.getByTestId("sheet-confirm"));
    await waitFor(() => expect(chain.sent.length).toBe(1));
    expect(chain.sent[0].to).toBe(numbers.contracts.treasury);
    const decoded = decodeCall(TREASURY_ABI, chain.sent[0].data);
    expect(decoded?.name).toBe("grantTeam");
    expect(decoded?.args).toEqual([BACKER_EVM, 1_500n * S]);
  });
  it("someone who has not linked an account cannot be chosen, and says why", async () => {
    await open();
    const option = screen.getByRole("option", {
      name: /Carl \(has not linked an account\)/,
    }) as HTMLOptionElement;
    expect(option.disabled).toBe(true);
  });
  it("less than the smallest grant, or more than the pool holds, is refused on the sheet", async () => {
    await open();
    fireEvent.change(screen.getByLabelText("Grant to"), {
      target: { value: ANNA.pubkey },
    });
    fireEvent.change(screen.getByLabelText("How many Team Shares?"), {
      target: { value: "0.5" },
    });
    expect(
      screen.getByText(/The smallest grant is 1 Team Share/),
    ).not.toBeNull();
    fireEvent.change(screen.getByLabelText("How many Team Shares?"), {
      target: { value: "9,000,000" },
    });
    expect(
      screen.getByText(
        `Only about ${sharesWords(numbers.team.ungranted)} Team Shares are left in the pool`,
        { exact: false },
      ),
    ).not.toBeNull();
    expect(
      (screen.getByTestId("sheet-confirm") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(chain.sent).toEqual([]);
  });
  it("with a Pair, a grant is a proposal the other signer confirms", async () => {
    setup(FOUNDER_EVM);
    const pairRun: ProjectNumbers = {
      ...numbers,
      runner: {
        address: PAIR,
        isPair: true,
        signers: [FOUNDER_EVM, BACKER_EVM],
      },
      contracts: { ...numbers.contracts, pair: PAIR },
    };
    show(pairRun);
    fireEvent.click(await screen.findByTestId("grant-open"));
    await screen.findByTestId("grant-pool");
    fireEvent.change(screen.getByLabelText("Grant to"), {
      target: { value: ANNA.pubkey },
    });
    fireEvent.change(screen.getByLabelText("How many Team Shares?"), {
      target: { value: "10" },
    });
    fireEvent.click(screen.getByTestId("sheet-confirm"));
    await waitFor(() => expect(chain.sent.length).toBe(1));
    expect(chain.sent[0].to).toBe(PAIR);
    const proposal = decodeCall(PAIR_ABI, chain.sent[0].data);
    expect(proposal?.name).toBe("propose");
    expect(decodeCall(TREASURY_ABI, proposal?.args[1] as string)?.args).toEqual(
      [BACKER_EVM, 10n * S],
    );
  });
});

describe("a member's grants", () => {
  it("shows what was granted, what has unlocked and what can be claimed, with the dates, and claims it", async () => {
    setup(MEMBER, { vested: 600n * S, claimable: 250n * S });
    show(numbers, MEMBER);
    expect((await screen.findByTestId("grant-total")).textContent).toBe(
      "100,000 Team Shares",
    );
    expect(screen.getByTestId("grant-vested").textContent).toBe("600");
    expect(screen.getByTestId("grant-claimable").textContent).toBe("250");
    expect(screen.getByTestId("my-grants").textContent).toMatch(
      /nothing unlocks before about/,
    );
    expect(screen.getByTestId("my-grants").textContent).toMatch(
      /fully unlocked by about/,
    );
    fireEvent.click(screen.getByTestId("grant-claim"));
    expect((await screen.findByTestId("claim-words")).textContent).toMatch(
      /250 Team Shares have unlocked/,
    );
    fireEvent.click(screen.getByTestId("sheet-confirm"));
    await waitFor(() => expect(chain.sent.length).toBe(1));
    expect(chain.sent[0].to).toBe(numbers.contracts.vester);
    const decoded = decodeCall(VESTER_ABI, chain.sent[0].data);
    expect(decoded?.name).toBe("claim");
    expect(decoded?.args).toEqual([2n]);
  });

  it("with nothing to claim the Claim press is off", async () => {
    setup(MEMBER);
    show(numbers, MEMBER);
    await screen.findByTestId("grant-total");
    expect(
      (screen.getByTestId("grant-claim") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("their own exit says what they keep and what is removed after the notice, and announces it", async () => {
    setup(MEMBER, { accrued: 4_000n * S });
    show(numbers, MEMBER);
    fireEvent.click(await screen.findByTestId("grant-exit"));
    const words = (await screen.findByTestId("exit-words")).textContent ?? "";
    expect(words).toMatch(/You keep 4,000 Team Shares/);
    expect(words).toMatch(
      /The other 96,000 are removed after a public notice of 7 days/,
    );
    fireEvent.click(screen.getByTestId("sheet-confirm"));
    await waitFor(() => expect(chain.sent.length).toBe(1));
    const decoded = decodeCall(VESTER_ABI, chain.sent[0].data);
    expect(decoded?.name).toBe("announceForfeit");
    expect(decoded?.args).toEqual([2n]);
  });

  it("a protected grant cannot be given up", async () => {
    setup(MEMBER, { prot: true });
    show(numbers, MEMBER);
    await screen.findByTestId("grant-total");
    expect(screen.queryByTestId("grant-exit")).toBeNull();
  });

  it("an announced exit shows the date it is removed, and can be finished after it", async () => {
    const past = BigInt(Math.floor(Date.now() / 1000) - 60);
    setup(MEMBER, { state: 1n, burnAt: past, burn: 96_000n * S });
    show(numbers, MEMBER);
    expect((await screen.findByTestId("grant-announced")).textContent).toMatch(
      /You gave up 96,000 Team Shares/,
    );
    fireEvent.click(screen.getByTestId("grant-burn"));
    fireEvent.click(await screen.findByTestId("sheet-confirm"));
    await waitFor(() => expect(chain.sent.length).toBe(1));
    expect(decodeCall(VESTER_ABI, chain.sent[0].data)?.name).toBe("execute");
  });

  it("grants that could not be read say nothing changed", async () => {
    setup(MEMBER);
    chain.answers.idsOf = () => {
      throw new Error("down");
    };
    show(numbers, MEMBER);
    expect(
      (await screen.findByTestId("grants-read-failed")).textContent,
    ).toMatch(/Nothing changed/);
  });
});
