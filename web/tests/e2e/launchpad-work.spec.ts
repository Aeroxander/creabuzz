import { expect, test, type Page } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";
import { installAnvilWallet } from "../helpers/anvil-wallet";
import { createMockRelay } from "./mock-relay";
import { publishedEvents } from "../helpers/published-events";

/**
 * The contributor path in the browser, against a REAL local chain.
 *
 * Opt-in: `scripts/web-work-e2e.sh` builds the world (a DAO with a Shares-only work budget and a project, and no claim
 * yet) and runs this spec. Each person acts from their own wallet: the contributor files a claim, the manager
 * takes it on, two reviewers approve it, anyone finishes it, and after the challenge window the contributor takes it. What is stubbed: the relay (it only serves the launch record) and the wallet
 * (`window.ethereum` forwarding to Anvil's unlocked accounts).
 */

const ANVIL_URL = process.env.E2E_ANVIL_URL ?? "";
const DAO = process.env.E2E_DAO ?? "";
const MANDATE = process.env.E2E_MANDATE ?? "";
const MANAGER = process.env.E2E_MANAGER ?? "";
const REVIEWER1 = process.env.E2E_REVIEWER1 ?? "";
const REVIEWER2 = process.env.E2E_REVIEWER2 ?? "";
const CONTRIBUTOR = process.env.E2E_CONTRIBUTOR ?? "";
const NSEC = "22".repeat(32);
const FOUNDER = getPublicKey(
  Uint8Array.from(NSEC.match(/.{2}/g) ?? [], (b) => Number.parseInt(b, 16)),
);

test.skip(
  !ANVIL_URL || !DAO || !MANDATE,
  "set E2E_ANVIL_URL, E2E_DAO and E2E_MANDATE (scripts/web-work-e2e.sh does)",
);

/** What the pages of one test publish, read back by the others (the reviewers read the contributor's evidence). */
const published = publishedEvents();
test.beforeEach(() => published.clear());

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

const record = {
  id: "record-work",
  pubkey: FOUNDER,
  created_at: 100,
  kind: 37001,
  tags: [
    ["d", "nebula-work"],
    ["name", "Nebula DAO"],
    ["t", "dao-launchpad"],
    ["chain", "31337"],
    ["treasury", DAO],
  ],
  content: JSON.stringify({
    pitch: "Work with no money in it.",
    stage: "graduated",
    tokenPlan: {
      mode: "dao",
      name: "Nebula",
      symbol: "NEB",
      supply: "200000000",
    },
  }),
  sig: "sig",
};

/** A tiny relay: serves the launch record and nothing else. */
async function serveRecord(page: Page) {
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
        published.remember(parsed[1] as { id: string; kind: number });
        ws.send(
          JSON.stringify(["OK", (parsed[1] as { id: string }).id, true, ""]),
        );
        return;
      }
      if (parsed[0] !== "REQ") return;
      const [, subId, filter] = parsed as [
        string,
        string,
        { kinds?: number[] },
      ];
      if (filter.kinds?.includes(37001)) {
        ws.send(JSON.stringify(["EVENT", subId, record]));
      }
      published.serve(ws, subId, filter.kinds);
      ws.send(JSON.stringify(["EOSE", subId]));
    });
  });
}

/** Open the Work tab as one person's wallet. */
async function openWork(page: Page, account: string) {
  await serveRecord(page);
  await installAnvilWallet(page, account, { rpcUrl: ANVIL_URL });
  await page.addInitScript(
    ([nsec, rpcUrl]) => {
      window.localStorage.setItem("buzz.identity.nsec", nsec);
      window.localStorage.setItem("buzz.launchpad.rpc", rpcUrl);
    },
    [NSEC, ANVIL_URL],
  );
  await page.goto(`/launchpad/nebula-work?author=${FOUNDER}`);
  await page.getByRole("tab", { name: "Work" }).click();
  await expect(page.getByTestId("work-mandate")).toBeVisible({
    timeout: 20_000,
  });
}

const claimNext = (page: Page) => page.getByTestId("work-claim-next");

/** Set by the script when the panel asks reviewers for a bond (whole units of the dev currency). */
const REVIEWER_BOND = process.env.E2E_REVIEWER_BOND ?? "";

/**
 * On a bonded panel a reviewer is offered no verdict until they hold the bond: the page says what is owed, they post it
 * from their own wallet (an approval, then the bond), and only then is Approve offered. On an unbonded panel there is
 * nothing to do and the page says so.
 */
async function postBondIfAsked(page: Page) {
  if (REVIEWER_BOND === "") {
    await expect(page.getByTestId("work-bond")).toContainText("None");
    await expect(page.getByTestId("work-post-bond")).toHaveCount(0);
    return;
  }
  await expect(page.getByTestId("work-bond")).toContainText(`${REVIEWER_BOND}`);
  await expect(page.getByTestId("work-bond-owed")).toBeVisible();
  // The panel is listed with who has not posted yet, and there is nothing to judge with until the bond is in.
  await expect(
    page
      .getByTestId("work-reviewer")
      .filter({ hasText: "bond not posted yet" }),
  ).not.toHaveCount(0);
  await expect(page.getByTestId("work-approve")).toHaveCount(0);
  await page.getByTestId("work-post-bond").click();
  await expect(page.getByTestId("work-bond-owed")).toHaveCount(0, {
    timeout: 90_000,
  });
  await expect(
    page.getByTestId("work-reviewer").filter({ hasText: "bond posted" }),
  ).not.toHaveCount(0, { timeout: 30_000 });
}

test("a claim goes from filed to taken, one person at a time, each from their own wallet", async ({
  context,
}) => {
  test.setTimeout(240_000);

  // ── the contributor files a claim that asks for no money ───────────────────
  const filer = await context.newPage();
  await openWork(filer, CONTRIBUTOR);
  await expect(filer.getByTestId("work-claims")).toHaveCount(0);
  // Words that do not make a claim are refused before the wallet is asked.
  await filer.getByTestId("work-claim-submit").click();
  await expect(filer.getByTestId("work-claim-problem")).toContainText(
    "short name",
  );
  await filer.getByTestId("work-claim-name").fill("write-docs");
  await filer.getByTestId("work-claim-submit").click();
  await expect(filer.getByTestId("work-claim-problem")).toContainText(
    "where the work is",
  );
  await filer
    .getByTestId("work-claim-evidence")
    .fill("https://example.com/pr/1");
  await filer.getByTestId("work-claim-check").fill("docs merged and reviewed");
  await filer.getByTestId("work-claim-submit").click();
  await expect(filer.getByTestId("work-claim-filed")).toBeVisible({
    timeout: 60_000,
  });
  await expect(claimNext(filer)).toContainText(
    "Waiting for a work area's manager",
  );
  // What they submitted is published beside the claim, and the page shows it matches what the claim committed to.
  await expect(filer.getByTestId("work-evidence-text")).toContainText(
    "https://example.com/pr/1",
    { timeout: 30_000 },
  );
  await expect(filer.getByTestId("work-evidence-check")).toContainText(
    "docs merged and reviewed",
  );

  // ── the manager takes the claim on ─────────────────────────────────────────
  const manager = await context.newPage();
  await openWork(manager, MANAGER);
  await expect(manager.getByTestId("work-share-budget")).toContainText(
    "40 of 100",
  );
  await expect(manager.getByTestId("work-projects")).toContainText("docs");
  await expect(manager.getByTestId("work-claims")).toContainText("write-docs");
  await expect(claimNext(manager)).toContainText(
    "Waiting for a work area's manager",
  );
  await expect(manager.getByTestId("work-claim-status")).toContainText(
    "asks for Shares, not money",
  );
  await manager.getByTestId("work-bind").click();
  await expect(claimNext(manager)).toContainText("0 of 2 approvals", {
    timeout: 60_000,
  });

  // ── someone who is not a reviewer is offered nothing to review ─────────────
  const stranger = await context.newPage();
  await openWork(stranger, MANAGER);
  await expect(stranger.getByTestId("work-approve")).toHaveCount(0);

  // ── the contributor is on the panel too, and still cannot review their own claim ─
  const contributor = await context.newPage();
  await openWork(contributor, CONTRIBUTOR);
  await expect(claimNext(contributor)).toContainText("0 of 2 approvals");
  await expect(contributor.getByTestId("work-approve")).toHaveCount(0);

  // ── a reviewer who cannot read the evidence is told so and is not offered Approve ─────
  published.withhold(true);
  const blind = await context.newPage();
  await openWork(blind, REVIEWER1);
  await expect(blind.getByTestId("work-evidence-missing")).toContainText(
    "cannot approve what they cannot read",
  );
  await expect(blind.getByTestId("work-approve")).toHaveCount(0);
  published.withhold(false);
  await blind.close();

  // ── two reviewers approve ──────────────────────────────────────────────────
  const first = await context.newPage();
  await openWork(first, REVIEWER1);
  await expect(first.getByTestId("work-evidence-text")).toContainText(
    "https://example.com/pr/1",
  );
  await postBondIfAsked(first);
  await first.getByTestId("work-approve").click();
  await expect(claimNext(first)).toContainText("1 of 2 approvals", {
    timeout: 60_000,
  });
  // They already gave their verdict: it is not offered twice.
  await expect(first.getByTestId("work-approve")).toHaveCount(0);

  const second = await context.newPage();
  await openWork(second, REVIEWER2);
  await postBondIfAsked(second);
  await second.getByTestId("work-approve").click();
  await expect(claimNext(second)).toContainText(
    "Enough reviewers approved it",
    {
      timeout: 60_000,
    },
  );

  // ── anyone finishes it ─────────────────────────────────────────────────────
  await second.getByTestId("work-settle").click();
  await expect(claimNext(second)).toContainText(
    "once the challenge window ends",
    { timeout: 60_000 },
  );
  await expect(second.getByTestId("work-claim-status")).toContainText(
    "Approved",
  );

  // ── nothing is payable inside the window, even for the contributor ─────────
  await contributor.reload();
  await contributor.getByRole("tab", { name: "Work" }).click();
  await expect(claimNext(contributor)).toContainText("challenge window");
  await expect(contributor.getByTestId("work-payout")).toHaveCount(0);

  // ── the window passes (the chain's clock, not the browser's) ───────────────
  await rpc("anvil_increaseTime", [700_000]);
  await rpc("anvil_mine", ["0x1"]);
  await contributor.reload();
  await contributor.getByRole("tab", { name: "Work" }).click();
  await expect(claimNext(contributor)).toContainText(
    "can mark it finished now",
  );
  // Only the contributor is offered the payout.
  await second.reload();
  await second.getByRole("tab", { name: "Work" }).click();
  await expect(claimNext(second)).toContainText("can mark it finished now");
  await expect(second.getByTestId("work-payout")).toHaveCount(0);

  await contributor.getByTestId("work-payout").click();
  await expect(claimNext(contributor)).toContainText(
    "Finished; no money was asked for. Shareholders can vote to award Shares",
    { timeout: 60_000 },
  );
  await expect(contributor.getByTestId("work-claim-status")).toContainText(
    "Finished",
  );
  await expect(contributor.getByTestId("work-claim-paid")).toContainText(
    "No money was asked for.",
    { timeout: 30_000 },
  );
  // The award is the DAO's vote: the page sends the member to the Decisions tab to open it.
  await expect(contributor.getByTestId("work-award-help")).toContainText(
    "Awarding Shares is a decision the DAO votes on",
  );
  await expect(contributor.getByTestId("work-failure")).toHaveCount(0);

  // Link a relay task to the real claim. The save is a signed reference update, never another EVM operation.
  const linker = await context.newPage();
  const taskRelay = createMockRelay();
  taskRelay.seed(record);
  taskRelay.seed({
    id: "a".repeat(64),
    kind: 44011,
    pubkey: FOUNDER,
    created_at: 100,
    tags: [["d", "linked-docs"]],
    content: JSON.stringify({ title: "Write the docs", status: "done" }),
    sig: "sig",
  });
  await taskRelay.install(linker);
  await installAnvilWallet(linker, CONTRIBUTOR, { rpcUrl: ANVIL_URL });
  await linker.addInitScript(
    ([nsec, rpcUrl]) => {
      localStorage.setItem("buzz.identity.nsec", nsec);
      localStorage.setItem("buzz.launchpad.rpc", rpcUrl);
    },
    [NSEC, ANVIL_URL],
  );
  await linker.goto(`/c/127.0.0.1:4173?view=work&work=${FOUNDER}:linked-docs`);
  const delivery = linker.getByTestId("task-delivery");
  await expect(delivery).toBeVisible();
  await delivery
    .getByTestId("task-delivery-project")
    .selectOption(`37001:${FOUNDER}:nebula-work`);
  const paidOption = delivery
    .getByTestId("task-delivery-claim")
    .locator("option")
    .filter({ hasText: "Finished" });
  await expect(paidOption).toHaveCount(1, { timeout: 30_000 });
  const claimRef = await paidOption.getAttribute("value");
  if (!claimRef) throw new Error("The real paid claim had no reference");
  await delivery.getByTestId("task-delivery-claim").selectOption(claimRef);
  await delivery
    .getByTestId("task-delivery-output")
    .fill("https://example.com/pr/1");
  const beforeLink = await rpc("eth_blockNumber");
  await delivery.getByTestId("task-delivery-save").click();
  await expect(delivery).toContainText("No payment was sent");
  expect(await rpc("eth_blockNumber")).toBe(beforeLink);
  const saved = taskRelay.events.filter((e) => e.kind === 44011).at(-1);
  expect(JSON.parse(saved?.content ?? "{}").delivery.claim.id).toBe(
    claimRef.split(":")[1],
  );
  await delivery.getByRole("link", { name: "Open project claim" }).click();
  await expect(linker.getByTestId("work-claim-status")).toContainText(
    "Finished",
    {
      timeout: 30_000,
    },
  );
  await expect(
    linker.locator(`[id="claim-${claimRef.replace(":", "-")}"]`),
  ).toBeFocused();

  // ── a reviewer who is done takes their bond back: ask, wait out the days, take it ─────────────
  if (REVIEWER_BOND !== "") {
    await first.reload();
    await first.getByRole("tab", { name: "Work" }).click();
    const back = first.getByTestId("work-bond-return");
    await expect(back).toContainText(`Your bond here: ${REVIEWER_BOND}`, {
      timeout: 30_000,
    });
    // Someone who is not on the panel is offered nothing to take back.
    await expect(stranger.getByTestId("work-bond-return")).toHaveCount(0);
    await first.getByTestId("work-unbond").click();
    await expect(first.getByTestId("work-unbond-pending")).toContainText(
      "on its way back",
      { timeout: 60_000 },
    );
    // It stopped counting at once, and cannot be taken yet.
    await expect(first.getByTestId("work-unbond")).toHaveCount(0);
    await expect(first.getByTestId("work-withdraw-bond")).toHaveCount(0);
    await rpc("anvil_increaseTime", [15 * 86_400]);
    await rpc("anvil_mine", ["0x1"]);
    await first.reload();
    await first.getByRole("tab", { name: "Work" }).click();
    await expect(first.getByTestId("work-unbond-pending")).toContainText(
      "you can take it now",
      { timeout: 30_000 },
    );
    await first.getByTestId("work-withdraw-bond").click();
    await expect(first.getByTestId("work-bond-return")).toHaveCount(0, {
      timeout: 60_000,
    });
    await expect(first.getByTestId("work-failure")).toHaveCount(0);
  }
  if (process.env.E2E_SHOTS) {
    await contributor
      .getByTestId("work-tab")
      .screenshot({ path: `${process.env.E2E_SHOTS}/work.png` });
  }
});
