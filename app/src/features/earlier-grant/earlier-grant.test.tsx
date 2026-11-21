// The earlier backers' claim page: it exists only where the build has its settings; a link is read strictly; the page decides
// what to show from the link, the account, the record and the network; the claim press needs the box ticked and the text opened,
// sends the one call the ABI builds, and refuses a text that is not the network's. Every row here is invented (anvil's public
// development accounts and amounts chosen in this file); no list exists anywhere in the repository.
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { decodeCall } from "@creaton/core/pot/abi-codec.ts";
import { EARLIER_GRANTS_ABI } from "@creaton/core/pot/abis.generated.ts";
import {
  buildEarlierTree,
  type EarlierRow,
} from "@creaton/core/pot/earlier-proof.ts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COORDINATE,
  NOW,
  recordV2,
  SERVER,
  serve,
  wrap,
} from "../../../tests/helpers/money-harness";
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
import { numbersV2Content } from "../../../tests/helpers/numbers-v2-fixture";
import { createAppRouter } from "../../app/router";
import { forgetSendTargets } from "../money/send-targets";
import { EarlierGrantPage } from "./EarlierGrantPage";
import {
  type EarlierGrantSettings,
  earlierGrantSettings,
} from "./earlier-grant-settings";
import {
  type EarlierLink,
  earlierLinkFragment,
  earlierState,
  readEarlierLink,
} from "./earlier-grant-state";

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
  useRouter: () => ({ history: { back: () => undefined } }),
}));

const CONTRACT = `0x${"c1".repeat(20)}`;
const TEXT = `0x${"ab".repeat(32)}`;
const URL_OK = "https://example.invalid/text";
const settings: EarlierGrantSettings = {
  contract: CONTRACT,
  textHash: TEXT,
  textUrl: URL_OK,
};

// Four invented rows; row 1 is the signed-in account's.
const e18 = 10n ** 18n;
const rows: EarlierRow[] = [
  { index: 0n, account: FOUNDER_EVM, amount: 1000n * e18 },
  { index: 1n, account: BACKER_EVM, amount: 2500n * e18 },
  { index: 2n, account: `0x${"22".repeat(20)}`, amount: 40n * e18 },
  { index: 3n, account: `0x${"33".repeat(20)}`, amount: 12n * e18 },
];
const tree = buildEarlierTree(rows);
const mine = (): EarlierLink => ({
  index: 1n,
  amount: 2500n * e18,
  proof: tree.proofOf(1),
});

describe("the page exists only where the build was given its three settings", () => {
  const all = {
    VITE_CREATON_EARLIER_CONTRACT: CONTRACT,
    VITE_CREATON_EARLIER_TEXT_HASH: TEXT,
    VITE_CREATON_EARLIER_TEXT_URL: URL_OK,
  };
  it("all three, checked, in lower case where it is hex", () => {
    expect(earlierGrantSettings(all)).toEqual({
      contract: CONTRACT,
      textHash: TEXT,
      textUrl: URL_OK,
    });
    expect(
      earlierGrantSettings({
        ...all,
        VITE_CREATON_EARLIER_CONTRACT: CONTRACT.toUpperCase().replace(
          "0X",
          "0x",
        ),
      })?.contract,
    ).toBe(CONTRACT);
  });
  it("any one missing or wrong is no page", () => {
    for (const key of Object.keys(all))
      expect(earlierGrantSettings({ ...all, [key]: undefined })).toBeNull();
    expect(earlierGrantSettings({})).toBeNull();
    expect(
      earlierGrantSettings({ ...all, VITE_CREATON_EARLIER_CONTRACT: "0x12" }),
    ).toBeNull();
    expect(
      earlierGrantSettings({ ...all, VITE_CREATON_EARLIER_TEXT_HASH: "0x12" }),
    ).toBeNull();
    for (const url of [
      "",
      "not a url",
      "javascript:alert(1)",
      "ftp://example.invalid/t",
      "https://user:pass@example.invalid/t",
      "data:text/plain,hello",
    ])
      expect(
        earlierGrantSettings({ ...all, VITE_CREATON_EARLIER_TEXT_URL: url }),
      ).toBeNull();
  });
  it("the route is in the router only with the settings: otherwise its address is not a page", () => {
    expect(
      createAppRouter(false, null).routesByPath["/earlier-grant" as never],
    ).toBeUndefined();
    expect(
      createAppRouter(false, settings).routesByPath["/earlier-grant" as never],
    ).toBeDefined();
    // the old earlier page stays behind its own flag
    expect(
      createAppRouter(false, settings).routesByPath["/earlier" as never],
    ).toBeUndefined();
  });
});

describe("a link is read strictly", () => {
  it("round-trips a row, and anything else is no link", () => {
    const link = mine();
    expect(readEarlierLink(earlierLinkFragment(link))).toEqual(link);
    for (const bad of [
      "",
      "#",
      "#!!!",
      "#e30", // {}
      `#${btoa("not json")}`,
      `#${btoa(JSON.stringify({ index: "-1", amount: "5", proof: [] }))}`,
      `#${btoa(JSON.stringify({ index: "1", amount: "5.5", proof: [] }))}`,
      `#${btoa(JSON.stringify({ index: "4294967296", amount: "5", proof: [] }))}`,
      `#${btoa(JSON.stringify({ index: "1", amount: "5", proof: ["0x12"] }))}`,
      `#${btoa(JSON.stringify({ index: "1", amount: "5", proof: "0x" }))}`,
      `#${btoa(JSON.stringify({ index: "1", amount: "5", proof: Array(33).fill(`0x${"11".repeat(32)}`) }))}`,
      `#${"A".repeat(5_000)}`,
    ])
      expect(readEarlierLink(bad)).toBeNull();
  });
});

describe("what the page decides to show", () => {
  const record = { bound: true, root: tree.root, textHash: TEXT };
  const chain = { textHash: TEXT, bound: true, claimed: false };
  const input = {
    account: BACKER_EVM,
    link: mine(),
    record,
    buildTextHash: TEXT,
    chain,
  };
  it("a row that is the account's, in a list the network names, is shown", () => {
    expect(earlierState(input).kind).toBe("row");
  });
  it("nobody signed in, claims not open, a text that differs, a link that is not the account's, a claimed row", () => {
    expect(earlierState({ ...input, account: null }).kind).toBe("sign-in");
    expect(earlierState({ ...input, record: null }).kind).toBe("not-open");
    expect(
      earlierState({ ...input, record: { ...record, bound: false } }).kind,
    ).toBe("not-open");
    expect(
      earlierState({ ...input, chain: { ...chain, bound: false } }).kind,
    ).toBe("not-open");
    // the build's text is not the record's, or not the network's
    expect(
      earlierState({ ...input, buildTextHash: `0x${"cd".repeat(32)}` }).kind,
    ).toBe("texts-differ");
    expect(
      earlierState({
        ...input,
        chain: { ...chain, textHash: `0x${"cd".repeat(32)}` },
      }).kind,
    ).toBe("texts-differ");
    expect(earlierState({ ...input, link: null }).kind).toBe("not-for-you");
    // another account's link, an altered amount, a proof for another list
    expect(earlierState({ ...input, account: FOUNDER_EVM }).kind).toBe(
      "not-for-you",
    );
    expect(
      earlierState({ ...input, link: { ...mine(), amount: 2501n * e18 } }).kind,
    ).toBe("not-for-you");
    expect(
      earlierState({
        ...input,
        record: { ...record, root: `0x${"ee".repeat(32)}` },
      }).kind,
    ).toBe("not-for-you");
    expect(
      earlierState({ ...input, chain: { ...chain, claimed: true } }).kind,
    ).toBe("claimed");
    expect(earlierState({ ...input, chain: null }).kind).toBe("reading");
  });
});

// --- The page ------------------------------------------------------------------------------------------------------------------

const base = numbersFor();
let chain: PotChain;

function serveRecord(patch?: (grants: Record<string, unknown>) => void) {
  const content = numbersV2Content({
    coordinate: COORDINATE,
    now: NOW,
    patch: (c) => {
      const grants: Record<string, unknown> = {
        contract: CONTRACT,
        bound: true,
        root: tree.root,
        textHash: TEXT,
        total: (4_000n * e18).toString(),
        rows: 4,
        claimedRows: 1,
        claimedTotal: (1000n * e18).toString(),
        clockSecs: 31_536_000,
      };
      patch?.(grants);
      (c as Record<string, unknown>).earlierGrants = grants;
    },
  });
  serve([recordV2(content, COORDINATE, NOW)]);
}

function install(over: Record<string, unknown> = {}) {
  chain = installPotChain({
    account: BACKER_EVM,
    answers: {
      isClaimed: [false],
      textHash: [TEXT],
      vester: [base.contracts.vester],
      ...over,
    } as never,
  });
}
const show = () => wrap(<EarlierGrantPage settings={settings} />);

beforeEach(() => {
  applyServerSettings({ investing: true, self: SERVER });
  nameTheNetwork(base);
  forgetSendTargets();
  window.location.hash = earlierLinkFragment(mine());
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  localStorage.clear();
  serve([]);
  window.location.hash = "";
  applyServerSettings(null);
});

describe("the claim page", () => {
  it("shows the grant, what the contract does, the fingerprint and the counts, and offers the press only after the text is opened and the box ticked", async () => {
    serveRecord();
    install();
    show();
    expect((await screen.findByTestId("claim-grant")).textContent).toBe(
      "Your grant: 2,500 Team Shares.",
    );
    expect(screen.getByTestId("claim-vesting").textContent).toBe(
      "They unlock evenly over 365 days counted from the day the project began, with no waiting period at the start. The team cannot cancel or burn this grant: the contract has no call for it.",
    );
    expect(screen.getByTestId("claim-taking-out").textContent).toBe(
      "Taking Team Shares out pays only what the project holds above what backers put in. That can be nothing.",
    );
    expect(screen.getByTestId("claim-fingerprint").textContent).toBe(
      "The text you accept has the fingerprint 0xabababab…abab.",
    );
    expect(screen.getByTestId("claim-count").textContent).toBe(
      "1 of 4 grants claimed.",
    );
    const press = screen.getByTestId("claim-press") as HTMLButtonElement;
    expect(press.disabled).toBe(true);
    // ticking alone is not enough
    fireEvent.click(screen.getByTestId("claim-tick"));
    expect(press.disabled).toBe(true);
    expect(screen.getByTestId("claim-must-read").textContent).toMatch(
      /Open the text first/,
    );
    // opening the text alone is not enough either
    fireEvent.click(screen.getByTestId("claim-tick"));
    const link = screen.getByTestId("claim-read-text") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe(URL_OK);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    link.addEventListener("click", (e) => e.preventDefault());
    fireEvent.click(link);
    expect(press.disabled).toBe(true);
    fireEvent.click(screen.getByTestId("claim-tick"));
    expect(press.disabled).toBe(false);
    // unticking takes it away again
    fireEvent.click(screen.getByTestId("claim-tick"));
    expect(press.disabled).toBe(true);
  });

  it("opening the text with the middle button counts as opening it", async () => {
    serveRecord();
    install();
    show();
    const link = await screen.findByTestId("claim-read-text");
    link.addEventListener("auxclick", (e) => e.preventDefault());
    fireEvent(link, new MouseEvent("auxclick", { bubbles: true, button: 1 }));
    fireEvent.click(screen.getByTestId("claim-tick"));
    expect(
      (screen.getByTestId("claim-press") as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("the press sends the one claim the ABI builds, with the row, its proof and the build's text fingerprint, and says it is claimed", async () => {
    serveRecord();
    install();
    show();
    const link = await screen.findByTestId("claim-read-text");
    link.addEventListener("click", (e) => e.preventDefault());
    fireEvent.click(link);
    fireEvent.click(screen.getByTestId("claim-tick"));
    fireEvent.click(screen.getByTestId("claim-press"));
    await waitFor(() => expect(chain.sent.length).toBe(1));
    const sent = chain.sent[0];
    expect(sent.to).toBe(CONTRACT);
    const call = decodeCall(EARLIER_GRANTS_ABI, sent.data);
    expect(call?.name).toBe("claim");
    expect(call?.args).toEqual([1n, 2500n * e18, mine().proof, TEXT]);
    expect((await screen.findByTestId("claim-done")).textContent).toBe(
      "Claimed. Your Team Shares unlock over time.",
    );
  });

  it("a link that is another account's reads as not for this account, and never shows whose or what", async () => {
    serveRecord();
    install();
    window.location.hash = earlierLinkFragment({
      index: 0n,
      amount: 1000n * e18,
      proof: tree.proofOf(0),
    });
    show();
    expect((await screen.findByTestId("claim-not-for-you")).textContent).toBe(
      "This link is not for the account you are using. Open it with the account it was made for.",
    );
    expect(screen.queryByTestId("claim-press")).toBeNull();
    expect(document.body.textContent).not.toMatch(/1,000/);
  });

  it("no link at all is the same sentence", async () => {
    serveRecord();
    install();
    window.location.hash = "";
    show();
    expect(await screen.findByTestId("claim-not-for-you")).toBeTruthy();
  });

  it("claims that are not open yet say so, and offer no press", async () => {
    serveRecord((g) => {
      g.bound = false;
    });
    install();
    show();
    expect((await screen.findByTestId("claim-not-open")).textContent).toBe(
      "Claims are not open yet.",
    );
    expect(screen.queryByTestId("claim-press")).toBeNull();
  });

  it("a project whose record has no claim key says claims are not open, and never a row", async () => {
    serve([
      recordV2(
        numbersV2Content({ coordinate: COORDINATE, now: NOW }),
        COORDINATE,
        NOW,
      ),
    ]);
    install();
    show();
    expect(await screen.findByTestId("claim-not-open")).toBeTruthy();
    expect(screen.queryByTestId("claim-grant")).toBeNull();
  });

  it("a page whose text is not the network's refuses, says do not accept, and offers no press", async () => {
    serveRecord();
    install({ textHash: [`0x${"cd".repeat(32)}`] });
    show();
    expect((await screen.findByTestId("claim-texts-differ")).textContent).toBe(
      "This page and the network name different texts. Do not accept. Tell the person who sent you the link.",
    );
    expect(screen.queryByTestId("claim-press")).toBeNull();
    expect(chain.sent.length).toBe(0);
  });

  it("a record that names another text than the build is refused the same way", async () => {
    serveRecord((g) => {
      g.textHash = `0x${"cd".repeat(32)}`;
    });
    install();
    show();
    expect(await screen.findByTestId("claim-texts-differ")).toBeTruthy();
  });

  it("a row already claimed says so and points to Your Shares", async () => {
    serveRecord();
    install({ isClaimed: [true] });
    show();
    expect((await screen.findByTestId("claim-already")).textContent).toBe(
      "This grant is already claimed. You can see it in Your Shares.",
    );
    expect(screen.queryByTestId("claim-press")).toBeNull();
  });

  it("a refusal by the contract says what happened and keeps the press (the double claim, in words)", async () => {
    serveRecord();
    install();
    show();
    const link = await screen.findByTestId("claim-read-text");
    link.addEventListener("click", (e) => e.preventDefault());
    fireEvent.click(link);
    fireEvent.click(screen.getByTestId("claim-tick"));
    chain.refuse = "execution reverted: AlreadyClaimed()";
    fireEvent.click(screen.getByTestId("claim-press"));
    expect((await screen.findByTestId("claim-problem")).textContent).toBe(
      "This grant is already claimed. Nothing changed.",
    );
    expect(chain.sent.length).toBe(0);
    expect(screen.getByTestId("claim-press")).toBeTruthy();
  });

  it("a network that cannot be read is said, with Try again, and nothing is claimed", async () => {
    serveRecord();
    install({
      textHash: () => {
        throw { code: -32603, message: "node down" };
      },
    });
    show();
    expect(
      (await screen.findByTestId("claim-read-failed")).textContent,
    ).toMatch(/could not be read/);
    expect(chain.sent.length).toBe(0);
  });

  it("the sign-in sentence is said where no account is shown", async () => {
    serveRecord();
    install();
    (window as unknown as { ethereum: unknown }).ethereum = undefined;
    show();
    expect((await screen.findByTestId("claim-sign-in")).textContent).toBe(
      "Sign in to see whether this link is for your account.",
    );
    expect(screen.queryByTestId("claim-press")).toBeNull();
  });

  it("the page's own words never promise a profit, an end date or that a grant lasts for ever", async () => {
    serveRecord();
    install();
    show();
    await screen.findByTestId("claim-grant");
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(
      /for ever|forever|no end|never expires|cannot be undone|permanent|guarantee|profit|dividend|earn/i,
    );
    expect(S).toBeGreaterThan(0n);
  });
});
