/**
 * Screenshot evidence for the org UI (Phase 2 + Phase 3): grant chain viewer,
 * budget consumption, onchain chips, and the contribution records table.
 * Seeds org kinds into the mock relay via __BUZZ_E2E_SEED_MOCK_ORG_EVENTS__.
 */
import { expect, test, type Page } from "@playwright/test";

import { TEST_IDENTITIES, installMockBridge } from "../helpers/bridge";
import { waitForAnimations } from "../helpers/animations";

const SHOTS = "test-results/org-screenshots";

const TYLER = TEST_IDENTITIES.tyler.pubkey;
const NOW = Math.floor(Date.now() / 1000);

function orgEvent(
  id: string,
  kind: number,
  dtag: string,
  content: unknown,
  extraTags: string[][] = [],
) {
  return {
    id,
    pubkey: TYLER,
    created_at: NOW - 3600,
    kind,
    tags: [["d", dtag], ...extraTags],
    content: JSON.stringify(content),
    sig: "mock-sig",
  };
}

function wikiEvent(
  id: string,
  d: string,
  created_at: number,
  content: string,
  extraTags: string[][] = [],
) {
  return {
    id,
    pubkey: TYLER,
    created_at,
    kind: 44002,
    tags: [["d", d], ...extraTags],
    content,
    sig: "mock-sig",
  };
}

const STANDUP_FRONT_MATTER = [
  "---",
  "slug: default/standup",
  "agwiki-cursor: 1750000000",
  "model: glm-5.3-flash",
  "generated-at: 1750000000",
  "---",
  "",
].join("\n");

function buildOrgEvents(): unknown[] {
  const hex = (prefix: string) => `${prefix}${"0".repeat(64 - prefix.length)}`;
  const agent = hex("cefe0001");
  const subject = hex("be11e0da");

  return [
    orgEvent("org-node-founder", 37010, "founder", {
      v: 1,
      name: "Founder",
      kind: "role",
      holders: [
        "e5ebc6cdb579be112e336cc319b5989b4bb6af11786ea90dbe52b5f08d741b34",
      ],
      agentSeats: [],
      scope: {
        readBelow: true,
        assignBelow: true,
        canGrant: ["read", "task", "spend:100000"],
      },
      onchain: {
        chain: "eip155:8453",
        dao: "0x1234567890abcdef1234567890abcdef12345678",
        boundAt: NOW - 86_400 * 30,
      },
    }),
    orgEvent("org-node-cto", 37010, "cto", {
      v: 1,
      name: "CTO",
      kind: "role",
      parent: "founder",
      holders: [
        "953d3363262e86b770419834c53d2446409db6d918a57f8f339d495d54ab001f",
      ],
      agentSeats: [],
      scope: {
        readBelow: true,
        assignBelow: true,
        canGrant: ["read", "task", "spend:50000"],
      },
    }),
    orgEvent("org-node-eng", 37010, "eng", {
      v: 1,
      name: "Engineering",
      kind: "team",
      parent: "cto",
      holders: [
        "bb22a5299220cad76ffd46190ccbeede8ab5dc260faa28b6e5a2cb31b9aff260",
      ],
      agentSeats: [agent],
      scope: { readBelow: true, assignBelow: true, canGrant: ["read"] },
    }),
    // Deeper tree so the canvas has a real forest to lay out (7 nodes).
    orgEvent("org-node-platform", 37010, "platform", {
      v: 1,
      name: "Platform",
      kind: "team",
      parent: "eng",
      holders: [],
      agentSeats: [],
      scope: { readBelow: true, assignBelow: false, canGrant: [] },
    }),
    orgEvent("org-node-sre", 37010, "sre", {
      v: 1,
      name: "SRE",
      kind: "role",
      parent: "eng",
      holders: [hex("5be12007")],
      agentSeats: [],
      scope: { readBelow: false, assignBelow: false, canGrant: [] },
    }),
    orgEvent("org-node-design", 37010, "design", {
      v: 1,
      name: "Design",
      kind: "team",
      parent: "founder",
      holders: [hex("0dd5e55")],
      agentSeats: [],
      scope: { readBelow: true, assignBelow: true, canGrant: ["read"] },
    }),
    orgEvent("org-node-ops-agent", 37010, "ops-agent", {
      v: 1,
      name: "Ops Agent",
      kind: "agent_seat",
      parent: "eng",
      holders: [],
      agentSeats: [hex("a6e7b00d")],
      scope: { readBelow: false, assignBelow: false, canGrant: [] },
    }),
    // Root grant from standing, two attenuated children, one violation.
    orgEvent("org-grant-root", 37011, "grant-root", {
      v: 1,
      issuer:
        "953d3363262e86b770419834c53d2446409db6d918a57f8f339d495d54ab001f",
      grantee: agent,
      via: "cto",
      verbs: ["read", "spend:50000"],
      revoked: false,
    }),
    orgEvent("org-grant-eng", 37011, "grant-eng", {
      v: 1,
      issuer: agent,
      grantee:
        "bb22a5299220cad76ffd46190ccbeede8ab5dc260faa28b6e5a2cb31b9aff260",
      via: "eng",
      verbs: ["read:#eng", "spend:20000"],
      parentGrant: "grant-root",
      revoked: false,
    }),
    orgEvent("org-grant-wide", 37011, "grant-wide", {
      v: 1,
      issuer: agent,
      grantee: hex("deadd00d"),
      via: "eng",
      verbs: ["read"],
      parentGrant: "grant-eng",
      expires: NOW + 86_400 * 7,
      revoked: false,
    }),
    // Revocation/expiry history for the curtain shelf (P2 item 11): a
    // revoked child under an active parent, and an expired unrevoked grant.
    orgEvent("org-grant-revoked", 37011, "grant-revoked", {
      v: 1,
      issuer: agent,
      grantee: hex("ca11c34e"),
      via: "eng",
      verbs: ["read:#eng"],
      parentGrant: "grant-eng",
      revoked: true,
    }),
    orgEvent("org-grant-expired", 37011, "grant-expired", {
      v: 1,
      issuer: agent,
      grantee: hex("e8891e5"),
      via: "ops-agent",
      verbs: ["read"],
      expires: NOW - 100,
      revoked: false,
    }),
    orgEvent("org-budget-agent", 37012, "budget-agent", {
      v: 1,
      subject,
      window: "month",
      limits: { runs: 50, spend: { amount: 2500, unit: "usd-cents" } },
      onExceed: "require-approval",
      onchain: {
        chain: "eip155:8453",
        contract: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
        subject,
      },
    }),
    orgEvent("org-budget-eng", 37012, "budget-eng", {
      v: 1,
      subject:
        "bb22a5299220cad76ffd46190ccbeede8ab5dc260faa28b6e5a2cb31b9aff260",
      window: "week",
      limits: { runs: 20, tasks: { create: 10 } },
      onExceed: "require-approval",
    }),
    // 32 turns this month against a 50-run ceiling → amber bar.
    ...Array.from({ length: 32 }, (_, i) => ({
      id: `metric-${i}`,
      pubkey: agent,
      created_at: NOW - i * 3_600 - 60,
      kind: 44200,
      tags: [["p", subject]],
      content: "{}",
      sig: "mock-sig",
    })),
    // Dashboard seeds: agent liveness (kind:44010), an over-budget run
    // ceiling (32 of 30 → 107% → blocking banner), an expired grant still
    // parenting an active one, an approval request, and a spend receipt.
    // 44010 capability announcements are authored by the agent itself —
    // the liveness derivation keys on the author, so these carry the seat
    // pubkeys, not the local viewer's key.
    {
      id: "agent-cap-eng-live",
      pubkey: agent,
      created_at: NOW - 60, // live
      kind: 44010,
      tags: [["d", "eng"]],
      content: JSON.stringify({ v: 1, name: "Engineering Agent" }),
      sig: "mock-sig",
    },
    {
      id: "agent-cap-ops-gone",
      pubkey: hex("a6e7b00d"),
      created_at: NOW - 2 * 3_600, // gone
      kind: 44010,
      tags: [["d", "ops"]],
      content: JSON.stringify({ v: 1, name: "Ops Agent" }),
      sig: "mock-sig",
    },
    orgEvent("org-budget-agent-hot", 37012, "budget-agent-hot", {
      v: 1,
      subject: agent,
      window: "month",
      limits: { runs: 30 },
      onExceed: "require-approval",
    }),
    orgEvent("org-grant-under-expired", 37011, "grant-under-expired", {
      v: 1,
      issuer: agent,
      grantee: hex("feedd00d"),
      via: "eng",
      verbs: ["read:#eng"],
      parentGrant: "grant-expired",
      expires: NOW + 3_600,
      revoked: false,
    }),
    // Newest activity sorts to the top of the capped feed — distinct recent
    // timestamps so they survive the 12-row cut.
    {
      id: "approval-req-overrun",
      pubkey: TYLER,
      created_at: NOW - 5,
      kind: 46010,
      tags: [
        ["d", "abc".padEnd(64, "1")],
        ["p", agent],
      ],
      content: JSON.stringify({
        type: "budget-exceeded",
        subject: agent,
        counterType: "runs",
        window: "month",
        limit: 30,
      }),
      sig: "mock-sig",
    },
    {
      id: "receipt-spend-1",
      pubkey: TYLER,
      created_at: NOW - 10,
      kind: 37014,
      tags: [
        ["d", "spend-1"],
        ["e", "org-grant-root"],
      ],
      content: JSON.stringify({
        v: 1,
        subject: agent,
        amount: 2500,
        unit: "usd-cents",
        window: "week",
      }),
      sig: "mock-sig",
    },
    // 32 turns this month against the hot budget's 30-run ceiling → 107%
    // → the "blocking" over-budget banner.
    ...Array.from({ length: 32 }, (_, i) => ({
      id: `metric-hot-${i}`,
      pubkey: agent,
      created_at: NOW - i * 3_600 - 60,
      kind: 44200,
      tags: [["p", agent]],
      content: "{}",
      sig: "mock-sig",
    })),
    orgEvent("org-cr-build", 37013, "cr-build", {
      v: 1,
      action: "Shipped the org grant chain viewer",
      dimensions: { build: 0.9, review: 0.4 },
      humanVsAi: { human: 0.6, ai: 0.4 },
      evidence: ["evt-evidence-1"],
      informedBy: ["cr-prior"],
      reviewStatus: "accepted",
      appealHistory: [],
    }),
    orgEvent("org-cr-triage", 37013, "cr-triage", {
      v: 1,
      action: "Triaged 14 inbound bug reports",
      dimensions: { ops: 0.7 },
      humanVsAi: { human: 0.2, ai: 0.8 },
      evidence: [],
      informedBy: [],
      reviewStatus: "pending",
      appealHistory: [],
    }),
    orgEvent("org-cr-deploy", 37013, "cr-deploy", {
      v: 1,
      action: "Deployed the staging relay",
      dimensions: { ops: 0.8, build: 0.3 },
      humanVsAi: { human: 0.5, ai: 0.5 },
      evidence: ["evt-deploy-9"],
      informedBy: [],
      reviewStatus: "rejected",
      appealHistory: [{ status: "rejected", at: NOW - 7200 }],
    }),
    orgEvent("org-cr-docs", 37013, "cr-docs", {
      v: 1,
      action: "Documented the NIP-ORG review flow",
      dimensions: { teach: 0.6 },
      humanVsAi: { human: 0.8, ai: 0.2 },
      evidence: [],
      informedBy: [],
      reviewStatus: "appealed",
      appealHistory: [{ status: "appealed", at: NOW - 500 }],
    }),
    // Agent wiki (kind:44002): two standup revisions — the older one must
    // lose read-side LWW — plus a second page for the sheet view.
    wikiEvent(
      "wiki-standup-v1",
      "default/standup",
      NOW - 2 * 3_600,
      `${STANDUP_FRONT_MATTER}# Standup (stale revision)\n\nThis older body must never render.`,
      [["model", "glm-5.3-flash"]],
    ),
    wikiEvent(
      "wiki-standup-v2",
      "default/standup",
      NOW - 600,
      `${STANDUP_FRONT_MATTER}# Standup\n\n## Shipped\n\n- Grant chain viewer with attenuation checks\n- Budget consumption bars\n\n## Next\n\nDistill the research backlog.`,
      [
        ["model", "glm-5.3-flash"],
        ["cost_tokens", "4200"],
      ],
    ),
    wikiEvent(
      "wiki-research-index",
      "default/projects/research/index",
      NOW - 1_800,
      [
        "---",
        "slug: default/projects/research/index",
        "---",
        "",
        "# Research index",
        "",
        "Open questions and findings, distilled from done tasks.",
      ].join("\n"),
      [
        ["model", "glm-5.3-flash"],
        ["sources", `${"ab".repeat(32)},${"cd".repeat(32)}`],
      ],
    ),
  ];
}

function teamEvent(
  id: string,
  kind: number,
  dtag: string,
  content: unknown,
  created_at: number,
) {
  return {
    id,
    pubkey: TYLER,
    created_at,
    kind,
    tags: [["d", dtag]],
    content: typeof content === "string" ? content : JSON.stringify(content),
    sig: "mock-sig",
  };
}

/**
 * Teams (SAT kinds 44020-44022) seeds for the org Teams tab: one strategy
 * root + its reflection revision (lineage chip), one run with four turns
 * across two phases, and the final answer in the run head.
 */
function buildTeamEvents(): unknown[] {
  const STRATEGY = {
    v: 1,
    name: "Mechanistic step audit",
    description:
      "AIME-2024 bank strategy from arXiv 2609.22682: every reasoning step is audited by independent solvers before the certificate.",
    teamworkPrompt:
      "Treat arithmetic, algebraic transformations, case splits, and counting steps as audit targets before accepting a final answer.",
    roles: {
      "agent-0": "Independent solver and step auditor.",
      "agent-1": "Independent solver and step auditor.",
      "agent-2": "Consensus challenger.",
    },
    steps: [
      {
        participants: ["agent-0", "agent-1", "agent-2"],
        rounds: 1,
        flow: "local",
        prompt: "Audit the reasoning chains step by step.",
      },
    ],
    finalWriter: "agent-2",
  };
  const RUN_ID = "sat-smoke-2-1750000000";
  return [
    teamEvent("team-strategy-root", 44020, "sat-smoke-2", STRATEGY, NOW - 3600),
    teamEvent(
      "team-strategy-rev1",
      44020,
      "sat-smoke-2-rev1",
      {
        ...STRATEGY,
        name: "Mechanistic step audit (revised)",
        parentStrategy: "sat-smoke-2",
      },
      NOW - 3000,
    ),
    teamEvent(
      "team-run-1",
      44021,
      RUN_ID,
      {
        v: 1,
        strategyId: "sat-smoke-2",
        problem: "Prove whether 2025 is prime, and factor it if it is not.",
        transcript: [],
        finalAnswer:
          "## Certificate\n\n2025 is composite: 2025 = 5² × 3⁴. Divisible by 5 (last digit 5) and by 9 (digit sum 9).\n\nNo prime factor exceeds √2025 ≈ 45.",
        totalTokens: 1732,
        model: "deepseek-v4-flash-0731",
        status: "complete",
      },
      NOW - 600,
    ),
    teamEvent(
      "team-turn-1",
      44022,
      `${RUN_ID}/1/agent-0`,
      "# Independent audit\n\n2025 ends in 5, so 5 divides it. 2025 = 5 × 405.",
      NOW - 580,
    ),
    teamEvent(
      "team-turn-2",
      44022,
      `${RUN_ID}/1/agent-1`,
      "# Independent audit\n\n405 = 5 × 81, so 2025 = 5² × 81.",
      NOW - 540,
    ),
    teamEvent(
      "team-turn-3",
      44022,
      `${RUN_ID}/2/agent-0`,
      "# Check\n\n81 = 3⁴, so the certificate should read 5² × 3⁴ — not 5² × 9.",
      NOW - 500,
    ),
    teamEvent(
      "team-turn-4",
      44022,
      `${RUN_ID}/2/agent-2`,
      "# Consensus\n\nBoth audits agree; I draft the certificate as 2025 = 5² × 3⁴.",
      NOW - 460,
    ),
  ];
}

function seedOrgEvents(page: Page) {
  return page.evaluate(
    (events) => {
      const seed = (
        window as Window & {
          __BUZZ_E2E_SEED_MOCK_ORG_EVENTS__?: (events: unknown[]) => void;
        }
      ).__BUZZ_E2E_SEED_MOCK_ORG_EVENTS__;
      if (!seed) throw new Error("org seed helper is not installed");
      seed(events);
    },
    [...buildOrgEvents(), ...buildTeamEvents()],
  );
}

async function openTeamsTab(page: Page) {
  await page.getByTestId("org-tab-teams").click();
  await expect(page.getByTestId("org-teams-view")).toBeVisible();
  await waitForAnimations(page);
}

async function openOrgView(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("app-sidebar")).toBeVisible();
  await seedOrgEvents(page);
  await page.getByTestId("open-org-view").click();
  // Dashboard is the default org tab (its empty state renders when nothing
  // is seeded, so assert the tab, not a dashboard child).
  await expect(page.getByTestId("org-tab-dashboard")).toHaveAttribute(
    "data-state",
    "active",
  );
  await waitForAnimations(page);
}

/** The Dashboard is the default org tab; chart-owned specs switch to it. */
async function openChartTab(page: Page) {
  await page.getByTestId("org-tab-chart").click();
  await expect(page.getByText("Delegations")).toBeVisible();
  await waitForAnimations(page);
}

test.describe("org UI screenshots", () => {
  test("org canvas: tree layout, fit-to-screen, selection, density", async ({
    page,
  }) => {
    await installMockBridge(page);
    await openOrgView(page);
    await openChartTab(page);
    const viewport = page.getByTestId("org-canvas-viewport");
    await expect(viewport).toBeVisible();
    // All 7 seeded nodes are on the canvas (list fallback stays in the
    // collapsed "Node list" disclosure, so only canvas cards carry
    // data-org-card).
    const cards = page.locator("[data-org-card]");
    await expect(cards).toHaveCount(7);
    // Fit-on-mount put every node inside the viewport bounds.
    const vpBox = await viewport.boundingBox();
    if (!vpBox) throw new Error("canvas viewport has no bounding box");
    for (const dtag of [
      "founder",
      "cto",
      "eng",
      "platform",
      "design",
      "ops-agent",
      "sre",
    ]) {
      const box = await page
        .getByTestId(`org-canvas-node-${dtag}`)
        .boundingBox();
      if (!box) throw new Error(`canvas node ${dtag} not laid out`);
      expect(box.x, dtag).toBeGreaterThanOrEqual(vpBox.x - 2);
      expect(box.y, dtag).toBeGreaterThanOrEqual(vpBox.y - 2);
      expect(box.x + box.width, dtag).toBeLessThanOrEqual(
        vpBox.x + vpBox.width + 2,
      );
      expect(box.y + box.height, dtag).toBeLessThanOrEqual(
        vpBox.y + vpBox.height + 2,
      );
    }
    // Selecting a node rings it and opens the per-node drill-in: Engineering
    // has two delegations through it and one budget over its occupant.
    await page.getByTestId("org-canvas-node-eng").click();
    const panel = page.getByTestId("org-node-selection");
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("Delegations through this node (3)");
    await expect(panel).toContainText("Budgets covering its occupants (2)");
    await waitForAnimations(page);
    await viewport.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/org-canvas.png` });
    // Compact density shrinks the cards.
    await page.getByTestId("org-density-compact").click();
    const compactBox = await page
      .getByTestId("org-canvas-node-eng")
      .boundingBox();
    if (!compactBox) throw new Error("compact card not laid out");
    expect(compactBox.width).toBeLessThan(200);
    // Fit-to-screen button re-fits after the density switch.
    await page.getByTestId("org-density-comfortable").click();
    await page.getByRole("button", { name: "Fit chart to screen" }).click();
    await expect(page.getByTestId("org-canvas-node-founder")).toBeVisible();
  });

  test("chart tab: grant chain, budgets with consumption, onchain chips", async ({
    page,
  }) => {
    await installMockBridge(page);
    await openOrgView(page);
    await openChartTab(page);
    // Grant chain viewer: three rows with the attenuated chain and one
    // violation marker (sr-only text is the assertion surface).
    await expect(page.getByText("Delegations")).toBeVisible();
    await expect(page.getByText("grant-wide", { exact: false })).toHaveCount(0);
    await expect(page.getByText("spend:50000")).toBeVisible();
    await expect(page.getByText("spend:20000")).toBeVisible();
    await expect(page.getByText("Attenuation violation: read")).toBeAttached();
    await expect(page.getByText("Attenuation valid").first()).toBeAttached();
    await expect(page.getByText(/expires/).first()).toBeVisible();
    // Budget consumption: 32 of 50 turns this month.
    await expect(page.getByText("32 / 50 runs used")).toBeVisible();
    await expect(page.getByText("0 / 20 runs used")).toBeVisible();
    // Onchain bindings on the root canvas node (corner indicator since the
    // visual redesign) and the budget card (full chip).
    await expect(page.getByTestId("org-canvas-onchain-founder")).toBeVisible();
    await expect(page.getByText("Base · 0xabcdef…abcd").first()).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/org-grants.png`, fullPage: false });
  });

  test("contributions tab: table with filters", async ({ page }) => {
    await installMockBridge(page);
    await openOrgView(page);
    await page.getByTestId("org-tab-contributions").click();
    await expect(page.getByTestId("contribution-row").first()).toBeVisible();
    await waitForAnimations(page);
    await page.screenshot({ path: `${SHOTS}/org-contributions.png` });
  });

  test("contributions tab: batch draft of missing records", async ({
    page,
  }) => {
    await installMockBridge(page);
    await openOrgView(page);
    await page.getByTestId("org-tab-contributions").click();
    await expect(page.getByTestId("contribution-row").first()).toBeVisible();
    // The mocked Tauri command returns a structured batch result (2 ok, 1
    // skip) so the affordance renders its inline summary without a real
    // classifier/relay round trip.
    await page.getByTestId("org-classify-all-done").click();
    await expect(page.getByTestId("org-classify-batch-result")).toBeVisible();
    await expect(
      page.getByText("Drafted 2/2, skipped 1, failed 0."),
    ).toBeVisible();
    await waitForAnimations(page);
    await page.screenshot({
      path: `${SHOTS}/org-contributions-batch-draft.png`,
    });
  });

  test("contribution detail sheet with review actions", async ({ page }) => {
    await installMockBridge(page);
    await openOrgView(page);
    await page.getByTestId("org-tab-contributions").click();
    await expect(page.getByTestId("contribution-row").first()).toBeVisible();
    await page.getByTestId("contribution-row").first().click();
    await expect(page.getByRole("button", { name: "Accept" })).toBeVisible();
    await waitForAnimations(page);
    await page.screenshot({ path: `${SHOTS}/org-contribution-detail.png` });
  });

  test("grant drawer: identities, entailment, parent chain, expiry", async ({
    page,
  }) => {
    await installMockBridge(page);
    await openOrgView(page);
    await openChartTab(page);
    // grant-wide: attenuated verb (violation), parent chain, future expiry.
    await page.getByRole("button", { name: /^Open grant read$/ }).click();
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText("Grant grant-wide")).toBeVisible();
    await expect(sheet.getByText("Parent chain")).toBeVisible();
    await expect(
      sheet.getByText("violation", { exact: false }).first(),
    ).toBeVisible();
    await expect(sheet.getByText(/Expires/).first()).toBeVisible();
    await expect(sheet.getByText("Issuer")).toBeVisible();
    await expect(sheet.getByText("Grantee")).toBeVisible();
    await expect(
      sheet.getByRole("button", { name: "Revoke grant" }),
    ).toBeVisible();
    await waitForAnimations(page);
    await page.screenshot({ path: `${SHOTS}/org-grant-drawer.png` });
  });

  test("revocation curtain: revoked + expired grants stay visible", async ({
    page,
  }) => {
    await installMockBridge(page);
    await openOrgView(page);
    await openChartTab(page);
    // Collapsed shelf shows the count badge; expanding reveals history rows.
    const toggle = page.getByTestId("org-curtain-toggle");
    await expect(toggle).toBeVisible();
    await expect(page.getByTestId("org-curtain-count")).toHaveText("2");
    await toggle.click();
    await expect(page.getByTestId("org-curtain-row")).toHaveCount(2);
    await expect(page.getByTestId("org-curtain-row").first()).toContainText(
      "revoked",
    );
    await expect(page.getByTestId("org-curtain-row").nth(1)).toContainText(
      "expired",
    );
    await waitForAnimations(page);
    await page.screenshot({ path: `${SHOTS}/org-curtain.png` });
    // History rows stay openable: the expired grant's drawer shows its end.
    await page
      .getByTestId("org-curtain-row")
      .nth(1)
      .getByRole("button")
      .click();
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();
    await expect(
      sheet.getByText("expired", { exact: false }).first(),
    ).toBeVisible();
    await expect(
      sheet.getByRole("button", { name: "Revoke grant" }),
    ).toHaveCount(0);
    await waitForAnimations(page);
    await page.screenshot({ path: `${SHOTS}/org-curtain-expired-drawer.png` });
  });

  test("dashboard tab: banners, live agents, metrics, activity feed", async ({
    page,
  }) => {
    await installMockBridge(page);
    await openOrgView(page);
    // Blocking banners first: over-budget agent (32/30 → 107%) and the
    // expired grant still parenting an active one.
    await expect(
      page.getByTestId("org-banner-budget-budget-agent-hot"),
    ).toBeVisible();
    await expect(
      page.getByTestId("org-banner-budget-budget-agent-hot"),
    ).toContainText("hit 107% of its month runs budget");
    await expect(
      page.getByTestId("org-banner-expired-parent-grants"),
    ).toBeVisible();
    await expect(page.getByText("Raise the budget")).toBeVisible();
    await expect(page.getByText("Review grants")).toBeVisible();
    // Live agents: one live, one gone (grayed).
    await expect(page.getByText("Live agents — 1 of 2 live")).toBeVisible();
    await expect(page.getByTestId("org-agent-liveness-live")).toBeVisible();
    await expect(page.getByTestId("org-agent-liveness-gone")).toBeVisible();
    await expect(page.getByTestId("org-agent-liveness-live")).toHaveText(
      "Live",
    );
    // The gone row is grayed out.
    await expect(
      page.locator("[data-live-agent]").filter({ hasText: "Gone" }),
    ).toBeVisible();
    // Metric row reuses the Chart-tab numbers.
    await expect(page.getByTestId("org-metric-nodes")).toBeVisible();
    await expect(page.getByTestId("org-metric-grants")).toBeVisible();
    await expect(page.getByTestId("org-metric-budgets")).toBeVisible();
    // Activity feed: grants, budgets, receipts, approvals (never raw JSON).
    const rows = page.getByTestId("org-activity-row");
    await expect(rows.first()).toBeVisible();
    await expect(rows).toHaveCount(12); // capped at ACTIVITY_ROW_LIMIT
    await expect(
      page.getByText("Spend recorded: 2500 usd-cents"),
    ).toBeVisible();
    await expect(
      page.getByText("Budget approval requested:", { exact: false }),
    ).toBeVisible();
    await waitForAnimations(page);
    await page.screenshot({ path: `${SHOTS}/org-dashboard.png` });
  });

  test("wizard auto-opens on an empty org chart", async ({ page }) => {
    await installMockBridge(page);
    await page.goto("/");
    await expect(page.getByTestId("app-sidebar")).toBeVisible();
    // No org events seeded: the chart is empty, the wizard offers itself.
    await page.getByTestId("open-org-view").click();
    const wizard = page.getByRole("dialog");
    await expect(wizard.getByText("Create your org")).toBeVisible();
    await expect(wizard.getByText("Step 1")).toBeVisible();
    await expect(
      wizard.getByRole("heading", { name: "Name the org root" }),
    ).toBeVisible();
    await waitForAnimations(page);
    await page.screenshot({ path: `${SHOTS}/org-wizard-empty.png` });
  });

  test("audit tab: attributed structural changes + verify modal", async ({
    page,
  }) => {
    await installMockBridge(page);
    await openOrgView(page);
    await page.getByTestId("org-tab-audit").click();
    await expect(page.getByTestId("org-audit-view")).toBeVisible();
    await expect(page.getByTestId("org-audit-row").first()).toBeVisible();
    // The verify modal re-checks presence/recency of the same events.
    await page.getByTestId("org-audit-verify").click();
    await expect(page.getByTestId("org-audit-verify-modal")).toBeVisible();
    await waitForAnimations(page);
    await page.screenshot({ path: `${SHOTS}/org-audit.png` });
  });

  test("ragequit: hint without binding, confirm dialog with binding", async ({
    page,
  }) => {
    await installMockBridge(page);
    await openOrgView(page);
    await page.getByTestId("org-tab-chart").click();
    // The seeded root carries content.onchain, so the exit affordance
    // renders inside the root node's actions menu (the mock EVM value
    // layer reports configured). The trigger is hover-revealed, so
    // force-click it, then pick "Exit (ragequit)…" from the menu.
    // The actions menu lives in the accessible node list, collapsed under
    // a disclosure in canvas mode.
    await page.getByText("Node list").click();
    const menuTrigger = page
      .getByRole("button", { name: "Node actions for Founder" })
      .first();
    await menuTrigger.click({ force: true, timeout: 5000 });
    await page.getByTestId("org-ragequit-open").click({ timeout: 5000 });
    await expect(page.getByTestId("org-ragequit-dialog")).toBeVisible();
    await waitForAnimations(page);
    await page.screenshot({ path: `${SHOTS}/org-ragequit.png` });
  });

  test("wizard walk: real publish, skippable steps, review, finish on canvas", async ({
    page,
  }) => {
    await installMockBridge(page);
    await page.goto("/");
    await expect(page.getByTestId("app-sidebar")).toBeVisible();
    await page.getByTestId("open-org-view").click();
    const wizard = page.getByRole("dialog");
    await expect(wizard.getByText("Create your org")).toBeVisible();

    // Step 1 publishes the root (kind:37010) through the mock relay.
    await wizard.getByLabel("Root name").fill("Acme");
    await wizard.getByRole("button", { name: "Create root" }).click();
    await expect(
      wizard.getByRole("heading", { name: "Add a role or agent seat" }),
    ).toBeVisible();

    // Steps 2-4 are skippable; the strip counts through the gaps.
    await wizard.getByRole("button", { name: "Skip step" }).click();
    await expect(
      wizard.getByRole("heading", { name: "First grant" }),
    ).toBeVisible();
    await wizard.getByRole("button", { name: "Skip step" }).click();
    await expect(
      wizard.getByRole("heading", { name: "First budget" }),
    ).toBeVisible();
    await wizard.getByRole("button", { name: "Skip step" }).click();
    await expect(wizard.getByRole("heading", { name: "Review" })).toBeVisible();
    await expect(wizard.getByText("skipped", { exact: true })).toHaveCount(3);
    await expect(
      wizard.getByText("acme", { exact: false }).first(),
    ).toBeVisible();
    await waitForAnimations(page);
    await page.screenshot({ path: `${SHOTS}/org-wizard-review.png` });

    // Finish lands on the fitted canvas with the wizard closed.
    await wizard.getByRole("button", { name: "Finish & view org" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByTestId("org-canvas-node-acme")).toBeVisible();
  });

  test("agent wiki section: standup LWW, provenance, page sheet", async ({
    page,
  }) => {
    await installMockBridge(page);
    await openOrgView(page);
    // The standup card renders the newest revision's markdown body — the
    // stale revision must never appear (read-side LWW, newest per d).
    const standup = page.getByTestId("org-wiki-standup");
    await expect(standup).toBeVisible();
    await expect(standup).toContainText("Grant chain viewer");
    await expect(page.getByTestId("org-wiki-standup-body")).not.toContainText(
      "stale revision",
    );
    // Front matter is data, not prose: the YAML block never renders.
    await expect(standup).not.toContainText("agwiki-cursor");
    // Provenance line: relative time + model tag (never raw JSON).
    const provenance = page.getByTestId("org-wiki-standup-provenance");
    await expect(provenance).toContainText("by glm-5.3-flash");
    await expect(provenance).toContainText("ago");
    // The other page lists and opens its full markdown in a sheet.
    const row = page.getByTestId("org-wiki-page-row");
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("default/projects/research/index");
    await row.click();
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText("Research index");
    await expect(sheet).toContainText(
      "Open questions and findings, distilled from done tasks.",
    );
    await waitForAnimations(page);
    await page.screenshot({ path: `${SHOTS}/org-wiki.png` });
  });

  test("teams tab: strategy bank with lineage, model, and run list", async ({
    page,
  }) => {
    await installMockBridge(page);
    await openOrgView(page);
    await openTeamsTab(page);
    // Bank: the root and its reflection revision fold to two heads; the
    // root row carries the `rev1 of sat-smoke-2` lineage chip.
    await expect(page.getByTestId("org-bank-row")).toHaveCount(2);
    await expect(page.getByTestId("org-bank-row").first()).toContainText(
      "Mechanistic step audit (revised)",
    );
    await expect(
      page.getByText("rev1 of sat-smoke-2", { exact: true }).first(),
    ).toBeVisible();
    await expect(page.getByTestId("org-bank-row").first()).toContainText(
      "1 phase",
    );
    // Runs: one row with strategy name, status pill, token total.
    await expect(page.getByTestId("org-run-row")).toHaveCount(1);
    const runRow = page.getByTestId("org-run-row").first();
    await expect(runRow).toContainText("Mechanistic step audit");
    await expect(runRow).toContainText("1,732 tok");
    await expect(page.getByTestId("org-run-status")).toHaveText("complete");
    await expect(runRow).toContainText("Prove whether 2025 is prime");
    await waitForAnimations(page);
    await page.screenshot({ path: `${SHOTS}/teams-tab.png` });
  });

  test("teams run detail: transcript grouped by phase, final answer, reflect", async ({
    page,
  }) => {
    await installMockBridge(page);
    await openOrgView(page);
    await openTeamsTab(page);
    await page.getByTestId("org-run-row").first().click();
    const sheet = page.getByTestId("org-run-sheet");
    await expect(sheet).toBeVisible();
    // Four turns grouped into two phase sections.
    await expect(page.getByTestId("org-run-sheet-phase")).toHaveCount(2);
    await expect(page.getByTestId("org-run-turn")).toHaveCount(4);
    await expect(sheet).toContainText("Phase 1 · 2 turns");
    await expect(sheet).toContainText("Phase 2 · 2 turns");
    await expect(sheet).toContainText("Independent audit");
    // Final answer highlighted with the token total.
    const finalAnswer = page.getByTestId("org-run-final-answer");
    await expect(finalAnswer).toContainText("Certificate");
    await expect(finalAnswer).toContainText("1,732 tokens total");
    await expect(sheet).toContainText("deepseek-v4-flash-0731");
    await waitForAnimations(page);
    await page.screenshot({ path: `${SHOTS}/team-run-detail-sheet.png` });
    // Reflect: confirm, then the revised strategy summary lands inline.
    await page.getByTestId("org-reflect").click();
    await expect(page.getByTestId("org-reflect-confirm")).toBeVisible();
    await page.getByRole("button", { name: "Confirm reflection" }).click();
    await expect(page.getByTestId("org-reflect-result")).toBeVisible();
    await expect(page.getByTestId("org-reflect-result")).toContainText(
      "Published sat-smoke-2-rev1",
    );
    await expect(page.getByTestId("org-reflect-result")).toContainText(
      "Mock reflected strategy",
    );
    await waitForAnimations(page);
    await page.screenshot({ path: `${SHOTS}/team-run-reflect-result.png` });
  });

  test("teams run dialog: strategy picker, problem, org node bind", async ({
    page,
  }) => {
    await installMockBridge(page);
    await openOrgView(page);
    await openTeamsTab(page);
    await page.getByTestId("org-open-run-dialog").click();
    const dialog = page.getByTestId("org-run-dialog");
    await expect(dialog).toBeVisible();
    // The dialog's description states the atomic-publish contract.
    await expect(dialog).toContainText(
      "Publishes the run head only after every turn persisted",
    );
    // Select a strategy through the picker.
    await page
      .getByRole("button", { name: /select choose a strategy/i })
      .click();
    await page
      .getByRole("option", { name: /Mechanistic step audit/ })
      .first()
      .click();
    await expect(dialog).toContainText("Mechanistic step audit");
    // Fill the problem + bind the org node picker to the eng node.
    await page
      .getByTestId("org-run-problem")
      .fill("Prove whether 2025 is prime.");
    await page
      .getByRole("button", { name: /bind seats to an org node/i })
      .click();
    await page
      .getByRole("option", { name: /Engineering/ })
      .first()
      .click();
    await expect(dialog).toContainText("Engineering");
    await waitForAnimations(page);
    await page.screenshot({ path: `${SHOTS}/team-run-dialog.png` });
  });

  test("every org screenshot is byte-distinct", async () => {
    const fs = await import("node:fs");
    const crypto = await import("node:crypto");
    const files = fs
      .readdirSync(SHOTS)
      .filter((file) => file.endsWith(".png"))
      .sort();
    expect(files.length).toBeGreaterThan(0);
    const hashes = files.map((file) =>
      crypto
        .createHash("sha256")
        .update(fs.readFileSync(`${SHOTS}/${file}`))
        .digest("hex"),
    );
    expect(new Set(hashes).size, "screenshots must be byte-distinct").toBe(
      hashes.length,
    );
  });
});
