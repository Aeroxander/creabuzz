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
  ];
}

function seedOrgEvents(page: Page) {
  return page.evaluate((events) => {
    const seed = (
      window as Window & {
        __BUZZ_E2E_SEED_MOCK_ORG_EVENTS__?: (events: unknown[]) => void;
      }
    ).__BUZZ_E2E_SEED_MOCK_ORG_EVENTS__;
    if (!seed) throw new Error("org seed helper is not installed");
    seed(events);
  }, buildOrgEvents());
}

async function openOrgView(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("app-sidebar")).toBeVisible();
  await seedOrgEvents(page);
  await page.getByTestId("open-org-view").click();
  await expect(page.getByText("Delegations")).toBeVisible();
  await waitForAnimations(page);
}

test.describe("org UI screenshots", () => {
  test("chart tab: grant chain, budgets with consumption, onchain chips", async ({
    page,
  }) => {
    await installMockBridge(page);
    await openOrgView(page);
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
    // Onchain chips on the root node and the budget card.
    await expect(page.getByText("Base · 0x123456…5678")).toBeVisible();
    await expect(page.getByText("Base · 0xabcdef…abcd")).toBeVisible();
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
});
