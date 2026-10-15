import { expect, test, type Page } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";
import { installAnvilWallet } from "../helpers/anvil-wallet";

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
  await expect(claimNext(filer)).toContainText("Waiting for a project manager");

  // ── the manager takes the claim on ─────────────────────────────────────────
  const manager = await context.newPage();
  await openWork(manager, MANAGER);
  await expect(manager.getByTestId("work-share-budget")).toContainText(
    "40 of 100",
  );
  await expect(manager.getByTestId("work-projects")).toContainText("docs");
  await expect(manager.getByTestId("work-claims")).toContainText("write-docs");
  await expect(claimNext(manager)).toContainText(
    "Waiting for a project manager",
  );
  await expect(manager.getByTestId("work-claim-status")).toContainText(
    "asks to be recognised, not paid",
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

  // ── two reviewers approve ──────────────────────────────────────────────────
  const first = await context.newPage();
  await openWork(first, REVIEWER1);
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
  await rpc("anvil_increaseTime", [260_000]);
  await rpc("anvil_mine", ["0x1"]);
  await contributor.reload();
  await contributor.getByRole("tab", { name: "Work" }).click();
  await expect(claimNext(contributor)).toContainText("can take it now");
  // Only the contributor is offered the payout.
  await second.reload();
  await second.getByRole("tab", { name: "Work" }).click();
  await expect(claimNext(second)).toContainText("can take it now");
  await expect(second.getByTestId("work-payout")).toHaveCount(0);

  await contributor.getByTestId("work-payout").click();
  await expect(claimNext(contributor)).toContainText(
    "The DAO can vote to award Shares",
    { timeout: 60_000 },
  );
  await expect(contributor.getByTestId("work-claim-status")).toContainText(
    "Paid",
  );
  // The award is the DAO's vote: the page sends the member to the Decisions tab to open it.
  await expect(contributor.getByTestId("work-award-help")).toContainText(
    "Awarding Shares is a decision the DAO votes on",
  );
  await expect(contributor.getByTestId("work-failure")).toHaveCount(0);
  if (process.env.E2E_SHOTS) {
    await contributor
      .getByTestId("work-tab")
      .screenshot({ path: `${process.env.E2E_SHOTS}/work.png` });
  }
});
