import { expect, test, type Page } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";

import { installAnvilWallet } from "../helpers/anvil-wallet";

/**
 * A contributor project from start to award, entirely from pages, against a REAL local chain: no command line.
 *
 * Opt-in: `scripts/web-contributor-e2e.sh` boots the chain (with the contributor kit) and builds the app for it, then
 * runs this spec. The founder starts the project on the Start page: one transaction makes its DAO with no sale, its
 * first work budget and first project, and locks its Shares; then it is published. Work starts at once, with no vote:
 * everything after is done in pages, each as the wallet of the person whose job it is. What is stubbed: the relay (it
 * keeps what pages publish and hands it to the others) and the wallets (`window.ethereum` forwarding to Anvil's
 * unlocked accounts).
 */

const ANVIL_URL = process.env.E2E_ANVIL_URL ?? "";
const KIT = process.env.E2E_KIT ?? "";
const REVIEWER1 = process.env.E2E_REVIEWER1 ?? "";
const REVIEWER2 = process.env.E2E_REVIEWER2 ?? "";
const CONTRIBUTOR = process.env.E2E_CONTRIBUTOR ?? "";
const FOUNDER_WALLET = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const NSEC = "33".repeat(32);
const FOUNDER = getPublicKey(
  Uint8Array.from(NSEC.match(/.{2}/g) ?? [], (b) => Number.parseInt(b, 16)),
);
const CHECK = "docs merged and reviewed";
const E18 = 10n ** 18n;

test.skip(
  !ANVIL_URL || !KIT || !CONTRIBUTOR,
  "set E2E_ANVIL_URL, E2E_KIT and E2E_CONTRIBUTOR (scripts/web-contributor-e2e.sh does)",
);

async function rpc(method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(ANVIL_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: unknown; error?: unknown };
  if (body.error) throw new Error(JSON.stringify(body.error));
  return body.result;
}

async function call(to: string, data: string): Promise<string> {
  return String(await rpc("eth_call", [{ to, data }, "latest"]));
}

const addressArg = (address: string) =>
  address.slice(2).toLowerCase().padStart(64, "0");
const wordAddress = (hex: string) => `0x${hex.slice(-40)}`;

/** Let time pass on the chain, the way waiting would. */
async function pass(seconds: number) {
  await rpc("anvil_increaseTime", [seconds]);
  await rpc("anvil_mine", ["0x1"]);
}

/** Everything the pages publish, served back to every page that asks for its kind (the launch record, the evidence). */
const published: { id: string; kind: number }[] = [];

async function open(page: Page, wallet: string | null, path: string) {
  await page.routeWebSocket(/127\.0\.0\.1:4173/, (ws) => {
    ws.onMessage((message) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(message));
      } catch {
        return;
      }
      if (!Array.isArray(parsed)) return;
      if (parsed[0] === "EVENT") {
        const event = parsed[1] as { id: string; kind: number };
        if (!published.some((known) => known.id === event.id))
          published.push(event);
        ws.send(JSON.stringify(["OK", event.id, true, ""]));
        return;
      }
      if (parsed[0] !== "REQ") return;
      const [, subId, filter] = parsed as [
        string,
        string,
        { kinds?: number[] },
      ];
      for (const event of published) {
        if (filter.kinds?.includes(event.kind))
          ws.send(JSON.stringify(["EVENT", subId, event]));
      }
      ws.send(JSON.stringify(["EOSE", subId]));
    });
  });
  if (wallet) await installAnvilWallet(page, wallet, { rpcUrl: ANVIL_URL });
  await page.addInitScript(
    ([nsec, rpcUrl]) => {
      window.localStorage.setItem("buzz.identity.nsec", nsec);
      window.localStorage.setItem("buzz.identity.backedUp", "1");
      window.localStorage.setItem("buzz.launchpad.rpc", rpcUrl);
    },
    [NSEC, ANVIL_URL],
  );
  await page.goto(path);
}

const projectPath = (tab: string) =>
  `/launchpad/docs-commons?author=${FOUNDER}&tab=${tab}`;

/** Re-read the page after the chain's clock moved. */
async function refresh(page: Page, tab: "Decisions" | "Work") {
  await page.reload();
  await page.getByRole("tab", { name: tab }).click();
}

/** Back the newest decision, let its review pass, start its wait, let that pass, run it: each press the founder's. */
async function carryOut(page: Page, toApprove: number, toWait: number) {
  const card = page.getByTestId("decision-card").first();
  await expect(card.getByTestId("decision-status")).toHaveText(
    "Collecting support",
    { timeout: 30_000 },
  );
  await card.getByTestId("decision-vote-for").click();
  await expect(card.getByTestId("decision-support")).toContainText(
    "Backing 200",
    { timeout: 30_000 },
  );
  await pass(toApprove);
  await refresh(page, "Decisions");
  const next = page.getByTestId("decision-card").first();
  await expect(next.getByTestId("decision-status")).toHaveText("Approved", {
    timeout: 30_000,
  });
  await next.getByTestId("decision-start-wait").click();
  await expect(next.getByTestId("decision-status")).toHaveText(
    "Waiting to run",
    { timeout: 30_000 },
  );
  await pass(toWait);
  await refresh(page, "Decisions");
  const ready = page.getByTestId("decision-card").first();
  await expect(ready.getByTestId("decision-status")).toHaveText(
    "Ready to run",
    { timeout: 30_000 },
  );
  await ready.getByTestId("decision-run").click();
  await expect(ready.getByTestId("decision-status")).toHaveText("Done", {
    timeout: 30_000,
  });
}

test("a contributor project is started from the page, work is claimed the same day, and the award shows on its contributions", async ({
  context,
}) => {
  test.setTimeout(600_000);

  // ── 1. the founder starts it: one transaction makes the DAO, its budget and first project; then it is published ──
  const founder = await context.newPage();
  await open(founder, FOUNDER_WALLET, "/start");
  await founder.getByTestId("start-go-contributor").click();
  await expect(founder.getByTestId("contributor-no-raise")).toContainText(
    "This project cannot raise money",
  );
  await founder.getByTestId("contributor-name").fill("Docs Commons");
  await founder
    .getByTestId("contributor-pitch")
    .fill("Open docs for everyone, written by the people who use them.");
  await founder.getByTestId("contributor-founder-shares").fill("200");
  // Three times the founder's 200: the founder starts with at most a third of the first budget (D79).
  await founder.getByTestId("contributor-budget-shares").fill("600");
  await founder.getByTestId("contributor-project-cap").fill("40");
  await founder
    .getByTestId("contributor-reviewers")
    .fill(`${REVIEWER1}\n${REVIEWER2}`);
  await founder.getByTestId("contributor-project-name").fill("docs");
  await founder.getByTestId("contributor-project-check").fill(CHECK);
  await expect(founder.getByTestId("contributor-gate")).toHaveCount(0, {
    timeout: 20_000,
  });
  const blockBefore = BigInt(String(await rpc("eth_blockNumber")));
  await founder.getByTestId("contributor-submit").click();
  await expect(founder.getByTestId("contributor-done")).toBeVisible({
    timeout: 120_000,
  });
  // One wallet prompt: the whole project is one transaction.
  const sent = BigInt(String(await rpc("eth_blockNumber"))) - blockBefore;
  expect(sent).toBe(1n);

  // The chain agrees: the kit made one project for this founder, the founder holds its only Shares, nothing is for
  // sale, and the Shares cannot be sent between wallets.
  const launched = (
    (await rpc("eth_getLogs", [
      {
        address: KIT,
        fromBlock: `0x${blockBefore.toString(16)}`,
        toBlock: "latest",
      },
    ])) as { topics: string[] }[]
  ).filter(
    (log) =>
      log.topics[0] ===
      "0x9dec7eb8f63140ffdc1e32aab051934ead41f327697e78bfb0eb2c911303ca18",
  );
  expect(launched).toHaveLength(1);
  expect(wordAddress(launched[0].topics[1])).toBe(FOUNDER_WALLET.toLowerCase());
  const dao = wordAddress(launched[0].topics[2]);
  const shares = wordAddress(await call(dao, "0x03314efa"));
  const sharesOf = async (holder: string) =>
    BigInt(await call(shares, `0x70a08231${addressArg(holder)}`));
  expect(await sharesOf(FOUNDER_WALLET)).toBe(200n * E18);
  expect(BigInt(await call(shares, "0x18160ddd"))).toBe(200n * E18);
  const record = published.find((e) => e.kind === 37001) as
    | { content?: string }
    | undefined;
  const currency = (
    JSON.parse(record?.content ?? "{}") as { currency?: string }
  ).currency;
  expect(currency).toMatch(/^0x[0-9a-fA-F]{40}$/);
  // `sales(currency)`: no price, so nothing can be bought from the DAO.
  expect(
    BigInt(
      (await call(dao, `0xc6b9f06a${addressArg(currency as string)}`)).slice(
        0,
        66,
      ),
    ),
  ).toBe(0n);
  // `transfer(reviewer, 1)` from the founder is refused: the Shares are locked.
  await expect(
    rpc("eth_call", [
      {
        from: FOUNDER_WALLET,
        to: shares,
        data: `0xa9059cbb${addressArg(REVIEWER1)}${1n.toString(16).padStart(64, "0")}`,
      },
      "latest",
    ]),
  ).rejects.toThrow();

  // ── 2. the same day, with no vote: a contributor files a claim that asks for no money ──────────────
  await founder.getByTestId("contributor-open-project").click();
  await expect(founder.getByTestId("contributor-badge")).toHaveText(
    "Contributor project",
    { timeout: 30_000 },
  );
  const contributor = await context.newPage();
  await open(contributor, CONTRIBUTOR, projectPath("work"));
  await expect(contributor.getByTestId("work-projects")).toContainText("docs", {
    timeout: 30_000,
  });
  await contributor.getByTestId("work-claim-name").fill("write-docs");
  await contributor
    .getByTestId("work-claim-evidence")
    .fill("https://example.com/pr/1");
  await contributor.getByTestId("work-claim-check").fill(CHECK);
  await contributor.getByTestId("work-claim-submit").click();
  await expect(contributor.getByTestId("work-claim-filed")).toBeVisible({
    timeout: 90_000,
  });

  // ── 3. the founder (the first project's manager) takes it on, two reviewers approve, it is finished ──
  await refresh(founder, "Work");
  await founder.getByTestId("work-bind").click();
  await expect(founder.getByTestId("work-claim-next")).toContainText(
    "0 of 2 approvals",
    { timeout: 60_000 },
  );
  for (const account of [REVIEWER1, REVIEWER2]) {
    const reviewer = await context.newPage();
    await open(reviewer, account, projectPath("work"));
    await reviewer.getByTestId("work-approve").click();
    await expect(reviewer.getByTestId("work-claim-next")).not.toContainText(
      "0 of 2 approvals",
      { timeout: 60_000 },
    );
  }
  await refresh(founder, "Work");
  await founder.getByTestId("work-settle").click();
  await expect(founder.getByTestId("work-claim-status")).toContainText(
    "Approved",
    { timeout: 60_000 },
  );
  await pass(700_000);
  await refresh(contributor, "Work");
  await contributor.getByTestId("work-payout").click();
  await expect(contributor.getByTestId("work-claim-status")).toContainText(
    "Paid",
    { timeout: 60_000 },
  );
  expect(await sharesOf(CONTRIBUTOR)).toBe(0n);

  // ── 4. the award is still the project's vote ────────────────────────────────────────────────────
  await refresh(founder, "Decisions");
  await founder.getByTestId("decision-new").click();
  await founder.getByTestId("decision-kind-award").click();
  await expect(founder.getByTestId("award-claim")).toBeVisible({
    timeout: 30_000,
  });
  await founder.getByTestId("award-shares").fill("25");
  await founder.getByTestId("decision-draft-submit").click();
  await expect(founder.getByTestId("decision-opened")).toBeVisible({
    timeout: 60_000,
  });
  await carryOut(founder, 90_000, 90_000);
  expect(await sharesOf(CONTRIBUTOR)).toBe(25n * E18);

  // ── 5. anyone, with no wallet, reads who earned what, for which work ────────────────────────────
  const reader = await context.newPage();
  await open(reader, null, projectPath("contributions"));
  const person = reader.getByTestId("contribution-person");
  await expect(person).toHaveCount(1, { timeout: 30_000 });
  await expect(person.getByTestId("contribution-person-name")).toContainText(
    CONTRIBUTOR.slice(2, 6),
    { ignoreCase: true },
  );
  await expect(person.getByTestId("contribution-person-earned")).toHaveText(
    "25 Shares, 11.1% of all",
  );
  await expect(person.getByTestId("contribution-award")).toHaveText(
    "25 Shares for write-docs in the project docs",
  );
  await expect(reader.getByTestId("contributions-earned")).toHaveText(
    "25 (11.1% of all)",
  );
  await expect(reader.getByTestId("contributions-not-from-work")).toHaveText(
    "200",
  );
  if (process.env.E2E_SHOTS) {
    await reader
      .getByTestId("contributions-tab")
      .screenshot({ path: `${process.env.E2E_SHOTS}/contributions.png` });
  }
});
