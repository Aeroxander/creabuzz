import { expect, test } from "@playwright/test";
import { wizardToPublish } from "../helpers/wizard";
import { getPublicKey } from "nostr-tools/pure";

/**
 * The founder is a real identity this time: the Manage tab is founder-only, so a
 * made-up pubkey meant it never rendered. The seed is the fixed test key.
 */
const FOUNDER_NSEC = "22".repeat(32);
const FOUNDER = getPublicKey(
  Uint8Array.from(FOUNDER_NSEC.match(/.{2}/g) ?? [], (byte) =>
    Number.parseInt(byte, 16),
  ),
);

function record(auction?: string) {
  return {
    id: "record-1",
    pubkey: FOUNDER,
    created_at: 100,
    kind: 37001,
    tags: [
      ["d", "nebula"],
      ["name", "Nebula DAO"],
      ["t", "dao-launchpad"],
      ["admission", "curated"],
      ["chain", "11155111"],
      ...(auction ? [["auction", auction]] : []),
    ],
    content: JSON.stringify({
      pitch: "To the stars.",
      // Circle's USDC on Sepolia (the fixture's chain): amounts read as USDC.
      currency: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
      stage: servedStage,
      // A deployable price grid: the form validates these against the auction
      // contract, so a fixture with half of them leaves Save disabled.
      floorPrice: "792281625140000",
      tickSpacing: "79228162514",
      requiredRaised: "299999999998",
      budget: "50000000000",
      vesting: {
        cliffBlocks: 3110400,
        tranches: [
          { multiple: 2, percent: 20 },
          { multiple: 4, percent: 20 },
          { multiple: 8, percent: 20 },
          { multiple: 16, percent: 20 },
          { multiple: 32, percent: 20 },
        ],
        twapWindow: null,
      },
      tokenPlan: {
        mode: "mint",
        name: "Nebula Token",
        symbol: "NBL",
        supply: "200000000",
      },
    }),
    sig: "sig",
  };
}

function scoreRoot() {
  return {
    id: "score-root-1",
    pubkey: FOUNDER,
    created_at: 300,
    kind: 37006,
    tags: [["d", "trustgraphs.output.nostr-member.v1:12"]],
    content: JSON.stringify({
      program: "trustgraphs.output.nostr-member.v1",
      root: `0x${"11".repeat(32)}`,
      epoch: "12",
      anchorBlock: 500,
      indexerUrl: "https://idx.example.com",
    }),
    sig: "sig",
  };
}

function update() {
  return {
    id: "update-1",
    pubkey: FOUNDER,
    created_at: 200,
    kind: 47003,
    tags: [["a", `37001:${FOUNDER}:nebula`]],
    content: JSON.stringify({ title: "Ship it", body: "We shipped." }),
    sig: "sig",
  };
}

/** Events the page published, so a test can assert what a save wrote. */
const published: Array<{ kind: number; content: string; tags: string[][] }> =
  [];

/** Auction address served to the directory; empty = no auction linked. */
let servedAuction = "";
/** Stage served for the fixture record (defaults to the wizard's live). */
let servedStage = "live";
/**
 * Milestone mirrors (kind 47005) served for the detail page. Empty by
 * default, so every existing test still sees a launch with no recorded
 * outcomes; a track-record test seeds it before navigating.
 */
let servedMilestones: unknown[] = [];

async function mockRelay(page: import("@playwright/test").Page) {
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
        // Acknowledge writes, as a relay does: without an OK the publish path
        // waits for its timeout, so a save test would prove nothing.
        const event = parsed[1] as {
          id: string;
          content: string;
          tags: string[][];
        };
        // Keep the whole signed event: a replayed launch needs its author
        // (a real relay always serves `pubkey`).
        published.push({
          ...(event as Record<string, unknown>),
          kind: Number((event as { kind?: number }).kind ?? 0),
          content: String(event.content ?? ""),
          tags: event.tags ?? [],
        });
        ws.send(JSON.stringify(["OK", event.id, true, ""]));
        return;
      }
      if (parsed[0] !== "REQ") return;
      const [, subId, filter] = parsed as [
        string,
        string,
        { kinds?: number[] },
      ];
      const kinds: number[] = filter.kinds ?? [];
      if (kinds.includes(37001)) {
        ws.send(JSON.stringify(["EVENT", subId, record(servedAuction)]));
        // The page re-queries after publishing a new launch; a real relay
        // would serve it back. Mirror the writes the page made, so the
        // directory reflects what was just created. The fixture keeps its
        // `d = nebula` identity (published edits of it are not replayed), and
        // each launch appears once.
        const seen: string[] = [];
        for (const e of published) {
          if (e.kind !== 37001) continue;
          const dTag = e.tags.find(([k]) => k === "d")?.[1];
          if (!dTag || dTag === "nebula") continue;
          if (seen.includes(dTag)) continue;
          seen.push(dTag);
          ws.send(
            JSON.stringify(["EVENT", subId, { ...e, id: `${e.id}-${dTag}` }]),
          );
        }
      }
      if (kinds.includes(47003))
        ws.send(JSON.stringify(["EVENT", subId, update()]));
      if (kinds.includes(47005)) {
        for (const receipt of servedMilestones) {
          ws.send(JSON.stringify(["EVENT", subId, receipt]));
        }
      }
      if (kinds.includes(37006)) {
        ws.send(JSON.stringify(["EVENT", subId, scoreRoot()]));
      }
      ws.send(JSON.stringify(["EOSE", subId]));
    });
  });
}

test.beforeEach(async ({ page }) => {
  servedMilestones = [];
  await mockRelay(page);
  await page.addInitScript(
    ([nsec]) => window.localStorage.setItem("buzz.identity.nsec", nsec),
    [FOUNDER_NSEC],
  );
  await page.goto("/launchpad");
});

test("directory renders launches from the relay", async ({ page }) => {
  await expect(page.getByRole("heading", { name: "Launchpad" })).toBeVisible();
  await expect(page.getByText("Nebula DAO")).toBeVisible();
  await expect(page.getByText("To the stars.")).toBeVisible();
});

test("detail shows overview and updates", async ({ page }) => {
  await page.getByText("Nebula DAO").click();
  await expect(page).toHaveURL(/\/launchpad\/nebula/);
  await expect(page.getByText("Raise terms")).toBeVisible();
  await page.getByRole("tab", { name: /Updates/ }).click();
  await expect(page.getByText("We shipped.")).toBeVisible();
});

test("a production build shows no fabricated funding figures", async ({
  page,
}) => {
  // The preview fixture is development-only. This build (and CI) is a
  // production build, so an unlinked or unreachable auction must report "no
  // chain data" rather than a plausible raise percentage.
  await page.getByText("Nebula DAO").click();
  await expect(page).toHaveURL(/\/launchpad\/nebula/);
  await expect(page.getByTestId("launch-progress-source")).toHaveText(
    "No chain data",
  );
  await expect(page.getByTestId("launch-progress-unavailable")).toContainText(
    "No auction contract is linked",
  );
  await expect(page.getByText("Preview data")).toBeHidden();
});

test("the create form refuses parameters the auction contract would reject", async ({
  page,
}) => {
  // The constructor's reverts happen after the founder has written the terms, so
  // the form has to catch them. The defaults this app shipped could not be
  // deployed at all: floor 1e6 is below the contract's minimum.
  await page.getByRole("button", { name: "Set up a sale" }).first().click();
  // Name and slug first: the form is invalid without them, which would make the
  // enabled/disabled assertion below prove nothing.
  await page.getByTestId("launch-advanced").locator("> summary").click();
  await page.getByLabel("Launch id").fill("nebula-two");
  await page
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Nebula Two");

  await expect(page.getByTestId("launch-param-issues")).toBeHidden();
  await wizardToPublish(page);
  await expect(
    page.getByRole("button", { name: /Publish launch/ }),
  ).toBeEnabled();

  // A floor below MIN_FLOOR_PRICE, on top of a spacing that does not divide it.
  await page.getByTestId("launch-advanced-sale").locator("summary").click();
  await page.getByLabel("Floor price").fill("1000000");
  await page.getByLabel("Tick spacing").fill("100");
  const issues = page.getByTestId("launch-param-issues");
  await expect(issues).toBeVisible();
  await expect(issues).toContainText("floorPrice");
  await wizardToPublish(page);
  await expect(
    page.getByRole("button", { name: /Publish launch/ }),
  ).toBeDisabled();
});

test("recommended terms fill in deployable numbers", async ({ page }) => {
  await page.getByRole("button", { name: "Set up a sale" }).first().click();
  await page.getByTestId("launch-advanced").locator("> summary").click();
  await page.getByLabel("Launch id").fill("nebula-three");
  await page
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Nebula Three");
  await page.getByLabel("Floor price").fill("1000000");
  await page.getByTestId("launch-recommended-terms").click();

  await expect(page.getByTestId("launch-param-issues")).toBeHidden();
  const floor = await page.getByLabel("Floor price").inputValue();
  const spacing = await page.getByLabel("Tick spacing").inputValue();
  // On the grid and above the contract minimum, without the reader checking by
  // hand: the two numbers the contract is strictest about.
  expect(BigInt(floor)).toBeGreaterThanOrEqual((1n << 32n) + 1n);
  expect(BigInt(floor) % BigInt(spacing)).toBe(0n);
  await wizardToPublish(page);
  await expect(
    page.getByRole("button", { name: /Publish launch/ }),
  ).toBeEnabled();
});

test("editing the terms keeps the token plan and the price grid", async ({
  page,
}) => {
  // "Edit terms" reset `tickSpacing` to "" and dropped `tokenPlan` on every save,
  // so terms the founder had set disappeared — and because the Mint panel is
  // gated on `tokenPlan`, it could never come back. The mint fields were also
  // never seeded from the record, which left "Save changes" disabled with no
  // explanation the moment the dialog opened.
  await page.getByText("Nebula DAO").click();
  await expect(page).toHaveURL(/\/launchpad\/nebula/);
  await page.getByRole("tab", { name: /Manage/ }).click();

  published.length = 0;
  await page.getByRole("button", { name: "Edit terms" }).click();
  // The mint fields are seeded, so the dialog is saveable without retyping them.
  await expect(page.getByLabel("Token name")).toHaveValue("Nebula Token");
  await expect(
    page.getByRole("button", { name: /Save changes/ }),
  ).toBeEnabled();

  await page.getByRole("button", { name: /Save changes/ }).click();
  await expect(page.getByText("Launch updated.")).toBeVisible({
    timeout: 15_000,
  });

  const saved = published[published.length - 1];
  expect(saved, "a launch record must have been published").toBeTruthy();
  const content = JSON.parse(saved.content);
  expect(
    content.tokenPlan,
    "the mint handoff must survive an edit",
  ).toBeTruthy();
  expect(
    content.tickSpacing,
    "the price grid must survive an edit",
  ).toBeTruthy();
});

test("the raise terms are money a buyer can read", async ({ page }) => {
  // Every figure used to be raw atomic units: `1000000000 / 1000000000` is not
  // something anyone can act on, and the settle-either-way terms were absent.
  await page.getByText("Nebula DAO").click();
  await expect(page).toHaveURL(/\/launchpad\/nebula/);

  await expect(page.getByText("Graduation threshold")).toBeVisible();
  await expect(page.getByText("300,000 USDC").first()).toBeVisible();
  await expect(page.getByText("None set", { exact: false })).toHaveCount(0);
  await expect(page.getByText("$0.01 per token")).toBeVisible();

  // The two outcomes, before the money moves.
  const settlement = page.getByTestId("launch-settlement-terms");
  await expect(settlement).toContainText("If the threshold is met");
  await expect(settlement).toContainText("If the threshold is missed");
  await expect(settlement).toContainText("refundable in full");
});

test("the founder sees what is still missing before deploying", async ({
  page,
}) => {
  // The gaps that block a deployment were only discoverable by a reverting
  // constructor. The fixture has terms and a token plan but no auction, treasury
  // or channel.
  await page.getByText("Nebula DAO").click();
  await page.getByRole("tab", { name: /Manage/ }).click();

  const readiness = page.getByTestId("launch-readiness");
  await expect(readiness).toBeVisible({ timeout: 15_000 });
  await expect(readiness).toContainText("4 steps still open");
  await expect(readiness).toContainText("Sale parameters");
  await expect(readiness).toContainText("Auction contract");
  await expect(readiness).toContainText(
    "link it, so bids have somewhere to go",
  );

  // The sale parameters are valid, so that line carries no hint.
  const parameters = readiness.locator("li", { hasText: "Sale parameters" });
  await expect(parameters).not.toContainText("Floor price on the tick grid");
});

test("the buyer sees what the rest of the supply implies", async ({ page }) => {
  // A launch page that only shows the sale price hides the figure that decides
  // whether the sale is worth bidding on.
  await page.getByText("Nebula DAO").click();
  await expect(page).toHaveURL(/\/launchpad\/nebula/);

  const tokenomics = page.getByTestId("launch-tokenomics");
  await expect(tokenomics).toBeVisible({ timeout: 15_000 });
  // 200M tokens sold is 20% of a billion; at a cent each that is a 10M valuation.
  await expect(tokenomics).toContainText("Sale");
  await expect(tokenomics).toContainText("20%");
  // Whole tokens, not a fraction of one.
  await expect(tokenomics).toContainText("200,000,000 tokens");
  // The snapped floor is a hair under a cent, so the valuation is a hair under
  // 10M: the point is that it is shown at all, as money.
  await expect(tokenomics).toContainText(/9,999,000|10,000,000/);
  await expect(tokenomics).toContainText("Valuation at the floor");
  await expect(tokenomics).toContainText("$1,000 buys about");
  await expect(tokenomics).toContainText("you pay that, not your maximum");
});

test("an allocation that does not add up blocks the launch", async ({
  page,
}) => {
  // 110% allocated is a token someone cannot have. The split sits on the first
  // step, so the step itself refuses to continue until it adds up.
  await page.getByRole("button", { name: "Set up a sale" }).first().click();
  await page
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Nebula Four");
  await page.getByTestId("launch-advanced").locator("> summary").click();
  await page.getByLabel("Launch id").fill("nebula-four");
  const sale = page.getByTestId("launch-allocation-sale");
  await sale.fill("30");
  await expect(page.getByTestId("launch-allocation-issue")).toContainText(
    "110%",
  );
  await expect(page.getByTestId("launch-allocation-total")).toContainText(
    "110%",
  );
  await expect(page.getByTestId("wizard-continue")).toBeDisabled();

  await page.getByTestId("launch-allocation-standard").click();
  await expect(page.getByTestId("launch-allocation-issue")).toHaveCount(0);
  await expect(page.getByTestId("launch-allocation-total")).toContainText(
    "100%",
  );
  await wizardToPublish(page);
  await expect(
    page.getByRole("button", { name: /Publish launch/ }),
  ).toBeEnabled();
});

test("a bid sends onchain before the mirror is allowed", async ({ page }) => {
  // A linked auction makes the dialog a real bid composer: no auction, no send.
  servedAuction = "0x5555555555555555555555555555555555555555";
  // Fake wallet: eth_requestAccounts returns an account; eth_sendTransaction
  // returns a deterministic hash. The app must treat the hash as authoritative
  // for the mirror, and must NOT mirror before a hash exists.
  // beforeEach already navigated, and init scripts only run at the next
  // navigation: register the wallet here, then reload so it is present when
  // the dialog reads `window.ethereum`.
  await page.addInitScript(() => {
    const hash = `0x${"ab".repeat(32)}`;
    Object.defineProperty(window, "ethereum", {
      configurable: true,
      value: {
        request: async ({ method }) => {
          if (method === "eth_requestAccounts") {
            return ["0x1111111111111111111111111111111111111111"];
          }
          if (method === "eth_sendTransaction") {
            return hash;
          }
          throw new Error(`unexpected wallet method ${method}`);
        },
      },
    });
  });
  await page.reload();
  await page.getByText("Nebula DAO").click();
  await expect(page).toHaveURL(/\/launchpad\/nebula/);
  await page.getByRole("button", { name: "Back this launch" }).click();

  // The mirror is disabled until a tx hash exists.
  await expect(page.getByTestId("bid-record")).toBeDisabled();
  // Plain USDC amounts: a 1,000 USDC budget, at most 5 USDC a token.
  await page.getByTestId("bid-budget").fill("1000");
  await page.getByTestId("bid-max-price").fill("5");

  // The send button is enabled for a valid composed bid on a linked auction.
  await expect(page.getByTestId("bid-send")).toBeEnabled();
  await page.getByTestId("bid-send").click();

  // Sending the bid records it: no second click. The 47002 carries the wallet
  // hash — a mirror with no tx would claim a bid that never landed.
  await expect
    .poll(() => published.find((e) => e.kind === 47002))
    .toEqual(
      expect.objectContaining({
        kind: 47002,
        content: expect.stringContaining(`0x${"ab".repeat(32)}`),
      }),
    );
});

test("the monthly budget is a visible commitment", async ({ page }) => {
  // A budget on the record is priced by investors at bid time: it must be on
  // the treasury plan as a commitment, labelled as such.
  await page.getByText("Nebula DAO").click();
  await expect(page).toHaveURL(/\/launchpad\/nebula/);
  await page.getByRole("tab", { name: /Treasury/ }).click();
  await expect(page.getByTestId("launch-treasury-plan")).toContainText(
    "Monthly budget",
  );
  // 50,000,000,000 base units at 6 decimals = 50,000 USDC.
  await expect(page.getByTestId("launch-treasury-plan")).toContainText(
    "50,000 USDC",
  );
});

test("an oversized monthly budget warns but never blocks", async ({ page }) => {
  // MetaDAO's discipline: monthly budget above a sixth of the threshold is a
  // drain risk. It is a warning — the founder keeps their freedom.
  await page.getByRole("button", { name: "Set up a sale" }).first().click();
  await page
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Nebula Five");
  await page.getByTestId("launch-advanced").locator("> summary").click();
  await page.getByLabel("Launch id").fill("nebula-five");
  await page.getByTestId("launch-advanced-sale").locator("summary").click();
  await page.getByTestId("launch-budget").fill("1000000000000");
  await expect(page.getByTestId("launch-param-issues")).toContainText(
    "Monthly budget",
  );
  // Warned, not blocked: publish stays enabled.
  await wizardToPublish(page);
  await expect(
    page.getByRole("button", { name: /Publish launch/ }),
  ).toBeEnabled();
});

test("founder commitments appear on the readiness list", async ({ page }) => {
  // The fixture record has no long pitch, no cadence, no bound channel: the
  // readiness list must say so, because numeric validity alone does not
  // qualify a founder.
  await page.getByText("Nebula DAO").click();
  await expect(page).toHaveURL(/\/launchpad\/nebula/);
  await page.getByRole("tab", { name: /Manage/ }).click();
  const readiness = page.getByTestId("launch-readiness");
  await expect(readiness).toBeVisible({ timeout: 15_000 });
  await expect(readiness).toContainText("Founder commitments");
  const commitments = readiness.locator("li", {
    hasText: "Founder commitments",
  });
  await expect(commitments).not.toContainText("✓");
});

test("a founder can commit the longer story on create", async ({ page }) => {
  await page.getByRole("button", { name: "Set up a sale" }).first().click();
  await page
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Nebula Six");
  await page.getByTestId("launch-advanced").locator("> summary").click();
  await page.getByLabel("Launch id").fill("nebula-six");
  await page.getByTestId("launch-advanced-founder").locator("summary").click();
  await page
    .getByTestId("launch-long-pitch")
    .fill(
      "Built the relay core; three researchers; the thesis fails if usage stalls.",
    );
  await page
    .getByTestId("launch-ip-list")
    .fill("https://github.com/example/repo\nhttps://docs.example.com/");
  await wizardToPublish(page);
  await page.getByTestId("launch-update-cadence").fill("monthly with KPIs");
  // Publish carries the commitments. Scope to this launch: `published` is
  // shared across the file, so an earlier test's 37001 is still in it.
  await page.getByRole("button", { name: /Publish launch/ }).click();
  await expect
    .poll(() =>
      published.find(
        (e) =>
          e.kind === 37001 &&
          e.tags.some(([k, v]) => k === "d" && v === "nebula-six"),
      ),
    )
    .toEqual(
      expect.objectContaining({
        content: expect.stringContaining("the thesis fails if usage stalls"),
      }),
    );
});

test("a published score root is shown as a community data plane", async ({
  page,
}) => {
  // The card proves the client reads score roots as plain Nostr data and
  // renders the provenance honestly — program, epoch, anchored block. It does
  // not claim a member's score (that needs a leaf proof, surfaced elsewhere).
  await page.getByText("Nebula DAO").click();
  await expect(page).toHaveURL(/\/launchpad\/nebula/);
  await expect(page.getByTestId("launch-score-roots")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTestId("launch-score-roots")).toContainText(
    "trustgraphs.output.nostr-member.v1",
  );
  await expect(page.getByTestId("launch-score-roots")).toContainText("12");
  await expect(page.getByTestId("launch-score-roots")).toContainText(
    "Anchored at block 500",
  );
  await expect(page.getByTestId("launch-score-roots")).toContainText(
    "Scores are proven against this root",
  );
});

test("a failed launch can be relaunched under the same record", async ({
  page,
}) => {
  // A failed raise keeps its identity: the founder republishes the same `d`
  // with a fresh stage and cleared chain links, so the community and its
  // history stay. This is the paper's "problems outlive teams" made real on
  // the record layer.
  servedStage = "failed";
  try {
    await page.getByText("Nebula DAO").click();
    await expect(page).toHaveURL(/\/launchpad\/nebula/);
    await page.getByRole("tab", { name: /Manage/ }).click();
    const relaunch = page.getByTestId("launch-relaunch");
    await expect(relaunch).toBeVisible({ timeout: 15_000 });
    await relaunch.click();
    // The dialog explains the record identity is preserved.
    await expect(page.getByTestId("launch-relaunch-note")).toContainText(
      "same launch record",
    );
    // In edit mode the button says "Save changes"; publishing reissues the
    // record with stage draft and the auction link cleared.
    await page.getByRole("button", { name: /Save changes/ }).click();
    await expect
      .poll(() =>
        // The file shares `published` across tests — an earlier test already
        // republished nebula, so scan from the newest event.
        [...published]
          .reverse()
          .find(
            (e) =>
              e.kind === 37001 &&
              e.tags.some(([k, v]) => k === "d" && v === "nebula"),
          ),
      )
      .toEqual(
        expect.objectContaining({
          content: expect.stringContaining('"stage":"draft"'),
        }),
      );
  } finally {
    servedStage = "live";
  }
});

test("the exit path is a one-click proposal on the treasury", async ({
  page,
}) => {
  // The credible threat of taking money back disciplines the treasury. The
  // treasury tab must surface it as a real action, not marketing copy.
  await page.getByText("Nebula DAO").click();
  await expect(page).toHaveURL(/\/launchpad\/nebula/);
  await page.getByRole("tab", { name: /Treasury/ }).click();
  const exit = page.getByTestId("treasury-return");
  await expect(exit).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("propose-return")).toBeDisabled();
  await page
    .getByTestId("return-title")
    .fill("Return the remaining treasury pro-rata");
  await page.getByTestId("propose-return").click();
  await expect
    .poll(() => published.find((e) => e.kind === 47004))
    .toEqual(
      expect.objectContaining({
        content: expect.stringContaining("return-capital"),
      }),
    );
});

test("performance vesting is validated and published", async ({ page }) => {
  await page.getByRole("button", { name: "Set up a sale" }).first().click();
  await page
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Nebula Seven");
  await page.getByTestId("launch-advanced").locator("> summary").click();
  await page.getByLabel("Launch id").fill("nebula-seven");
  // A tranche at 1x warns (raise price is not performance); descending plus a
  // bad sum blocks.
  await page.getByTestId("launch-advanced-vesting").locator("summary").click();
  const vesting = page.getByTestId("launch-vesting");
  await expect(vesting).toBeVisible();
  await page.getByTestId("launch-tranches").fill("4:50\n2:50");
  await expect(page.getByTestId("launch-vesting-issue")).toContainText(
    "ascending",
  );
  // A valid ladder publishes with the record.
  await page
    .getByTestId("launch-tranches")
    .fill("2:20\n4:20\n8:20\n16:20\n32:20");
  await wizardToPublish(page);
  await expect(page.getByTestId("launch-vesting-issue")).toBeHidden();
  await page.getByRole("button", { name: /Publish launch/ }).click();
  await expect
    .poll(() =>
      published.find(
        (e) =>
          e.kind === 37001 &&
          e.tags.some(([k, v]) => k === "d" && v === "nebula-seven"),
      ),
    )
    .toEqual(
      expect.objectContaining({
        content: expect.stringContaining('"tranches"'),
      }),
    );
});

test("the liquidity minimum is shown before a thin pool ships", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Set up a sale" }).first().click();
  await page
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Nebula Eight");
  await page.getByTestId("launch-advanced").locator("> summary").click();
  await page.getByLabel("Launch id").fill("nebula-eight");
  // Standard allocation: 20% sale, 15% liquidity = 15% of the raise at the
  // floor, above the 4% minimum for a 20%-of-raise pool.
  await expect(page.getByTestId("launch-lp-minimum")).toContainText(
    "15% of the floor raise",
  );
  // Crank liquidity down to 2%: the hint flips to a warning.
  const liquidityInput = page
    .getByTestId("launch-allocation")
    .locator('input[type="number"]')
    .nth(3);
  await liquidityInput.fill("2");
  await expect(page.getByTestId("launch-lp-minimum")).toContainText("thin");
});

test("an agent-run launch is badged and attested", async ({ page }) => {
  // C4: agents are first-class participants. A launch created with the
  // "as agent" toggle is authored by the browser agent key, carries the
  // self-describing `agent` tag and a NIP-OA `auth` attestation, and is
  // badged "Agent-run" in the directory and detail.
  await page.getByRole("button", { name: "Set up a sale" }).first().click();
  await page
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Nebula Nine");
  await page.getByTestId("launch-advanced").locator("> summary").click();
  await page.getByLabel("Launch id").fill("nebula-nine");
  // The toggle moved behind the Advanced disclosure — the shared prelude
  // opened it the way a reader would; reach the checkbox inside.
  await wizardToPublish(page);
  await page.getByTestId("launch-as-agent").check();
  await page.getByRole("button", { name: /Publish launch/ }).click();
  await expect
    .poll(() =>
      [...published]
        .reverse()
        .find(
          (e) =>
            e.kind === 37001 &&
            e.tags.some(([k, v]) => k === "d" && v === "nebula-nine"),
        ),
    )
    .toEqual(
      expect.objectContaining({
        tags: expect.arrayContaining([
          expect.arrayContaining(["agent"]),
          expect.arrayContaining(["auth"]),
        ]),
      }),
    );
  // The directory badges it.
  await expect(page.getByTestId("launch-agent-badge").first()).toBeVisible();
});

test("the trust page states each commitment and its real proof state", async ({
  page,
}) => {
  // The record is a promise; the chain is the ledger. Each address is checked
  // for deployed code, and an unreadable check must say so — never render a
  // fabricated "verified". Served auction is set explicitly so this test is
  // self-contained (not dependent on an earlier test's side effect).
  servedAuction = "0x5555555555555555555555555555555555555555";
  // Make the chain proof hermetic: abort the RPC read so the check is
  // genuinely "no reachable RPC" regardless of whatever node happens to be
  // listening on the default endpoint (a local anvil/hardhat would otherwise
  // answer "0x" and flip the row to a reachable "no code" state). The point
  // stands either way: a check that cannot confirm a deployment must never
  // render as a pass.
  await page.route(/127\.0\.0\.1:8545/, (route) => route.abort());
  await page.getByText("Nebula DAO").click();
  await expect(page).toHaveURL(/\/launchpad\/nebula/);
  const card = page.getByTestId("launch-commitments");
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card).toContainText("Proven commitments");
  // Token/treasury are not linked in the fixture: those rows say so.
  await expect(card).toContainText("Token contract");
  await expect(card).toContainText("not set");
  // Record-borne commitments report what the record actually carries.
  await expect(card).toContainText("Monthly budget");
  await expect(card).toContainText("Vesting package");
  await expect(card).toContainText("5 tranches from 2x");
  // The point of the card: a check that cannot be made never renders as a
  // pass. With no reachable RPC the auction row must be an honest failure
  // state — "unreadable" — never "deployed" or "verified". Any honest
  // non-pass state is acceptable (unreachable → "unreadable", no link →
  // "not set", a reachable chain reporting an empty account → "no code at
  // this address"); only a fabricated pass is not.
  const auctionRow = card
    .locator("div", { hasText: "Auction contract" })
    .last();
  await expect(auctionRow).toContainText(/unreadable|not set|no code/);
  await expect(auctionRow).not.toContainText("deployed");
  await expect(auctionRow).not.toContainText("verified");
});

test("milestone claims and verdicts mirror to the feed with a closed vocabulary", async ({
  page,
}) => {
  await page.getByText("Nebula DAO").click();
  await expect(page).toHaveURL(/\/launchpad\/nebula/);
  await page.getByRole("tab", { name: /Manage/ }).click();
  await page
    .getByTestId("launch-advanced-milestones")
    .locator("summary")
    .click();
  const panel = page.getByTestId("launch-milestones");
  await expect(panel).toBeVisible({ timeout: 15_000 });
  // A receipt must name the settlement tx the relay requires (mirrors are
  // refused without one), so the Record claim / Verdict controls stay
  // disabled until the founder supplies a well-formed evidence hash and tx.
  // A bad evidence hash is therefore refused before mirroring: the button
  // never enables, so no invalid mirror can reach the relay.
  await page.getByTestId("claim-id").fill("milestone-1");
  await page.getByTestId("milestone-tx").fill(`0x${"cd".repeat(32)}`);
  await page.getByTestId("evidence-hash").fill("not-hex");
  await expect(page.getByTestId("record-claim")).toBeDisabled();
  // A valid claim mirrors with kind=claim.
  await page.getByTestId("evidence-hash").fill("ab".repeat(32));
  await expect(page.getByTestId("record-claim")).toBeEnabled();
  await page.getByTestId("record-claim").click();
  await expect
    .poll(() =>
      published.find(
        (e) =>
          e.kind === 47005 &&
          String(e.tags.find(([k]) => k === "kind")?.[1]) === "claim",
      ),
    )
    .toEqual(
      expect.objectContaining({
        content: expect.stringContaining('"table":"claim"'),
      }),
    );
  // A verdict mirrors with kind=verdict using the closed approve|reject
  // vocabulary (a word, not a boolean).
  await page.getByTestId("verdict-approve").click();
  await expect
    .poll(() =>
      published.find(
        (e) =>
          e.kind === 47005 &&
          String(e.tags.find(([k]) => k === "kind")?.[1]) === "verdict",
      ),
    )
    .toEqual(
      expect.objectContaining({
        content: expect.stringContaining('"verdict":"approve"'),
      }),
    );
});

const MILESTONE_TX = `0x${"ef".repeat(32)}`;

/** One claim + its approve verdict, shaped exactly as the producers write them. */
function milestoneMirrors() {
  const coord = `37001:${FOUNDER}:nebula`;
  return [
    {
      id: "mirror-claim-1",
      pubkey: FOUNDER,
      created_at: 410,
      kind: 47005,
      tags: [
        ["a", coord],
        ["kind", "claim"],
        ["claim", "milestone-1"],
        ["evidence", "ab".repeat(32)],
        ["tx", MILESTONE_TX],
      ],
      content: JSON.stringify({
        table: "claim",
        claim: "milestone-1",
        evidenceHash: "ab".repeat(32),
      }),
      sig: "sig",
    },
    {
      id: "mirror-verdict-1",
      pubkey: FOUNDER,
      created_at: 420,
      kind: 47005,
      tags: [
        ["a", coord],
        ["kind", "verdict"],
        ["claim", "milestone-1"],
        ["tx", MILESTONE_TX],
      ],
      content: JSON.stringify({
        table: "verdict",
        claim: "milestone-1",
        verdict: "approve",
      }),
      sig: "sig",
    },
  ];
}

test("the track record says what was recorded — or that nothing was", async ({
  page,
}) => {
  await page.getByText("Nebula DAO").click();
  await expect(page).toHaveURL(/\/launchpad\/nebula/);
  const card = page.getByTestId("launch-track-record");
  await expect(card).toBeVisible({ timeout: 15_000 });
  // No 47005 mirrors for this launch: the honest empty copy, and no
  // zero-filled outcome history rendered next to it.
  await expect(card).toContainText("No verdicts or receipts yet.");
  await expect(card).not.toContainText("Milestones approved");
  // The community query resolves with zero 37013 records — an empty ledger,
  // never the "unavailable" notice that a *failed* read must show instead.
  await expect(card).toContainText("No contribution records yet.");
  await expect(
    page.getByTestId("track-record-contributions-unavailable"),
  ).toHaveCount(0);
});

test("a recorded verdict renders a timeline bound to its claim and derivation", async ({
  page,
}) => {
  servedMilestones = milestoneMirrors();
  await page.getByText("Nebula DAO").click();
  await expect(page).toHaveURL(/\/launchpad\/nebula/);
  const card = page.getByTestId("launch-track-record");
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card).not.toContainText("No verdicts or receipts yet.");
  // The breakdown cites its inputs — the source line the tests bind.
  await expect(card).toContainText(
    "kind 47005 · tag kind=verdict · verdict=approve",
  );
  const approvedValue = card
    .locator("dt", { hasText: "Milestones approved" })
    .locator("xpath=../dd");
  // One approve verdict on the page means one in the count beside it.
  await expect(approvedValue).toHaveText("1");
  // The timeline pairs the verdict with its claim by milestone id and keeps
  // the settlement tx the mirror names.
  const milestone = card.getByTestId("track-record-milestone");
  await expect(milestone).toHaveCount(1);
  await expect(milestone).toContainText("milestone-1");
  await expect(milestone).toContainText("approve");
  await expect(milestone).toContainText("settled on-chain");
  await expect(milestone).toContainText("efef");
});

test("the sandbox walks a full raise, clearly badged as simulated", async ({
  page,
}) => {
  // The launchpad has no real content; the sandbox makes the flow visible —
  // and it must say it is simulated, not present fake chain data as live.
  await expect(page.getByTestId("sandbox-entry")).toBeVisible();
  await page.getByTestId("sandbox-entry").click();
  await expect(page).toHaveURL(/\/launchpad\/nebula-sandbox/);
  // Terms render from the deterministic record.
  await expect(page.getByText("Nebula Sandbox")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText("Raise terms")).toBeVisible();
  // The raise is alive and honest: Simulated, never "No chain data".
  await expect(page.getByTestId("launch-progress-source")).toHaveText(
    "Simulated",
  );
  await expect(page.getByText("Proven commitments")).toBeVisible();
  // No fabricated chain addresses.
  await expect(page.getByText("Auction contract")).toBeVisible();
});

const SEPOLIA_USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";

/** The sale step's body (the stepper reuses the test id on a span). */
const saleStep = (page: import("@playwright/test").Page) =>
  page.locator('div[data-testid="wizard-step-sale"]');

/** New launch -> token step filled -> on the sale step. */
async function toSaleStep(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "Set up a sale" }).first().click();
  const token = page.getByTestId("wizard-step-token");
  await token
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Currency Test");
  await token.getByLabel("Symbol").fill("CUR");
  await token.getByLabel(/supply/i).fill("1000000");
  await page.getByTestId("wizard-continue").click();
  await expect(saleStep(page)).toBeVisible();
}

test("a new sale defaults to USDC and can switch to ETH and back", async ({
  page,
}) => {
  await toSaleStep(page);
  const choice = page.getByTestId("sale-currency");
  await expect(choice.getByRole("radio")).toHaveCount(2);
  await expect(choice.getByRole("radio", { name: /USDC/ })).toBeChecked();
  await expect(page.getByLabel("Price per token (USDC)")).toHaveValue("0.01");
  await expect(page.getByTestId("sale-eth-note")).toHaveCount(0);

  // ETH: units, label, starting price and the "no dollar conversion" note follow.
  await page.getByTestId("sale-currency-eth").click();
  await expect(choice.getByRole("radio", { name: /ETH/ })).toBeChecked();
  await expect(page.getByLabel("Price per token (ETH)")).toHaveValue(
    "0.000004",
  );
  await expect(page.getByTestId("sale-eth-note")).toContainText(
    "Nothing is converted from dollars",
  );
  await expect(saleStep(page)).toContainText("0.000004 ETH a token");

  // Back to USDC: the dollar starting point returns, not ETH-sized numbers.
  await page.getByTestId("sale-currency-usdc").click();
  await expect(page.getByLabel("Price per token (USDC)")).toHaveValue("0.01");
  await expect(saleStep(page)).toContainText("$0.01 a token");
});

/** From wherever the wizard is (past the token step) on to the Publish step. */
async function continueToPublish(page: import("@playwright/test").Page) {
  const publish = page.getByRole("button", { name: /Publish launch/ });
  for (let i = 0; i < 6 && !(await publish.isVisible()); i++) {
    const next = page.getByTestId("wizard-continue");
    if (await next.isDisabled()) {
      await page.getByRole("button", { name: "Product project" }).click();
    } else {
      await next.click();
    }
  }
  await expect(publish).toBeVisible();
}

test("the chosen currency is what gets published", async ({ page }) => {
  test.setTimeout(90_000);
  published.length = 0;
  await toSaleStep(page);
  await page.getByTestId("sale-currency-eth").click();
  await continueToPublish(page);
  await page.getByRole("button", { name: /Publish launch/ }).click();
  await expect.poll(() => published.find((e) => e.kind === 37001)).toBeTruthy();
  const eth = JSON.parse(
    published.find((e) => e.kind === 37001)?.content ?? "{}",
  );
  // ETH is the native coin: no token address is published.
  expect(eth.currency ?? "").toBe("");
  // ...and the floor is priced in ETH's 18 decimals, not USDC's 6.
  expect(BigInt(eth.floorPrice) > 10n ** 20n).toBe(true);

  published.length = 0;
  await page.getByRole("button", { name: "Set up a sale" }).first().click();
  await toSaleStepFromOpenDialog(page);
  await continueToPublish(page);
  await page.getByRole("button", { name: /Publish launch/ }).click();
  await expect.poll(() => published.find((e) => e.kind === 37001)).toBeTruthy();
  const usdc = JSON.parse(
    published.find((e) => e.kind === 37001)?.content ?? "{}",
  );
  expect(usdc.currency).toBe(SEPOLIA_USDC.toLowerCase());
});

async function toSaleStepFromOpenDialog(page: import("@playwright/test").Page) {
  const token = page.getByTestId("wizard-step-token");
  await token
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Currency Two");
  await token.getByLabel("Symbol").fill("CU2");
  await token.getByLabel(/supply/i).fill("1000000");
  await page.getByTestId("wizard-continue").click();
}
