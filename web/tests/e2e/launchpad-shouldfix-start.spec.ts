import { expect, type Page, test } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";

import { createMockRelay, matches } from "./mock-relay";

/**
 * The contributor-project audit's start-area fixes (D144), against a stubbed server and a stubbed chain.
 *
 * - A project link whose read fails (signed out on an invite-only server, a passkey not unlocked this session) says
 *   what happened, offers the sign-in and Try again, and never says the project is not there. "Not found" is said only
 *   after a read that worked found nothing.
 * - A project removed from the list and published again afterwards shows (a removal hides only what came before it).
 * - The Start page offers the passkey unlock before anything is sent, says who the reviewers named are, and says when
 *   every reviewer must agree, with a one-press way to let any one decide.
 *
 * Making a project needs a contributor kit this build does not name, so a new project's id (never a removed one's) is
 * pinned in `src/features/start/lib/contributor-gate.test.mjs`, on the function the Start page calls.
 */

const NSEC = "6".repeat(64);
const ME = getPublicKey(Uint8Array.from(Buffer.from(NSEC, "hex")));
const PREVIEW = new RegExp(`127\\.0\\.0\\.1:${process.env.E2E_PORT ?? "4173"}`);
const INVITE_ONLY = "restricted: not a relay member";

function projectRecord(createdAt = 100, name = "Docs Commons") {
  return {
    id: `${createdAt.toString(16)}`.padStart(64, "a"),
    pubkey: ME,
    created_at: createdAt,
    kind: 37001,
    tags: [
      ["d", "docs-commons"],
      ["name", name],
      ["t", "dao-launchpad"],
      ["admission", "community"],
      ["chain", "31337"],
    ],
    content: JSON.stringify({
      pitch: "Open docs for everyone, written by the people who use them.",
      stage: "graduated",
      funding: {
        stance: "not-raising",
        seeking: ["contributors"],
        path: "contributors",
      },
    }),
    sig: "sig",
  };
}

/** A chain that knows only its id and height: enough for the pages to load, nothing that would make a project. */
async function installChain(page: Page) {
  await page.addInitScript(() => {
    window.localStorage.setItem(
      "buzz.launchpad.rpc",
      `${window.location.origin}/test-rpc`,
    );
  });
  await page.route("**/test-rpc", async (route) => {
    const { id, method } = JSON.parse(route.request().postData() ?? "{}") as {
      id: number;
      method: string;
    };
    const reply = (body: Record<string, unknown>) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ jsonrpc: "2.0", id, ...body }),
      });
    if (method === "eth_chainId") return reply({ result: "0x7a69" });
    if (method === "eth_blockNumber") return reply({ result: "0x20" });
    if (method === "eth_getLogs") return reply({ result: [] });
    return reply({ error: { code: -32000, message: "not stubbed" } });
  });
}

/**
 * An invite-only server, as the real one behaves: it challenges every socket and refuses the login of anyone not on
 * its list (`restricted: not a relay member`), until `letIn` is called; then it serves `events`.
 */
async function installInviteOnlyServer(page: Page, events: object[]) {
  const state = { refusing: true };
  await page.route("**/info", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/nostr+json",
      body: JSON.stringify({ name: "Mock server" }),
    }),
  );
  await page.route("**/communities", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ communities: [] }),
    }),
  );
  await page.routeWebSocket(PREVIEW, (ws) => {
    ws.send(JSON.stringify(["AUTH", "challenge"]));
    ws.onMessage((message) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(message));
      } catch {
        return;
      }
      if (!Array.isArray(parsed)) return;
      if (parsed[0] === "AUTH") {
        const id = (parsed[1] as { id?: string }).id ?? "";
        ws.send(
          JSON.stringify(
            state.refusing
              ? ["OK", id, false, INVITE_ONLY]
              : ["OK", id, true, ""],
          ),
        );
        return;
      }
      if (parsed[0] === "EVENT") {
        const id = (parsed[1] as { id?: string }).id ?? "";
        ws.send(JSON.stringify(["OK", id, !state.refusing, ""]));
        return;
      }
      if (parsed[0] === "REQ") {
        const [, subId, ...filters] = parsed as [
          string,
          string,
          ...Record<string, unknown>[],
        ];
        if (state.refusing) {
          ws.send(JSON.stringify(["CLOSED", subId, INVITE_ONLY]));
          return;
        }
        for (const event of events as Parameters<typeof matches>[1][]) {
          if (filters.some((filter) => matches(filter, event)))
            ws.send(JSON.stringify(["EVENT", subId, event]));
        }
        ws.send(JSON.stringify(["EOSE", subId]));
      }
    });
  });
  return {
    letIn: () => {
      state.refusing = false;
    },
  };
}

/** A registered passkey with nothing unlocked this session (as `signing-recovery.spec.ts` seeds it). */
function seedLockedPasskey(page: Page) {
  return page.addInitScript(() => {
    window.localStorage.setItem("buzz.passkey.credentialId", "cred-1");
    window.localStorage.setItem("buzz.passkey.salt", "c2FsdA");
    window.localStorage.setItem("buzz.passkey.pubkey", "e".repeat(64));
    window.localStorage.setItem("buzz.passkey.mode", "prf");
    window.localStorage.removeItem("buzz.identity.nsec");
  });
}

test("a project link the server refuses to read says so and offers Try again, never 'not found'", async ({
  page,
}) => {
  await installChain(page);
  const server = await installInviteOnlyServer(page, [projectRecord()]);
  await page.goto(`/launchpad/docs-commons?author=${ME}`);

  const panel = page.getByTestId("launch-load-error");
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await expect(panel).toHaveAttribute("data-outcome", "answered");
  await expect(page.getByTestId("launch-load-error-description")).toContainText(
    "invite-only",
  );
  // Signed out on this browser: it says so, and where to sign in.
  await expect(page.getByTestId("launch-load-signed-out")).toBeVisible();
  // The account menu is at the top on a wide screen and in the bottom bar on a phone: the words name it, not a place.
  await expect(page.getByTestId("launch-load-signed-out")).toContainText(
    "sign in from your account menu",
  );
  await expect(page.getByTestId("launch-not-found")).toHaveCount(0);
  await expect(page.getByText(/not found/i)).toHaveCount(0);

  // Once the server lets this browser in (an invite opened, a sign-in), Try again shows the project.
  server.letIn();
  await page.getByTestId("launch-load-error-retry").click();
  await expect(page.getByTestId("launch-hero")).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByTestId("launch-load-error")).toHaveCount(0);
});

test("a locked passkey on a project link is offered its sign-in, never told the project is gone", async ({
  page,
}) => {
  const relay = createMockRelay({ requireAuth: true });
  relay.seed(projectRecord());
  await seedLockedPasskey(page);
  await relay.install(page);
  await installChain(page);
  await page.goto(`/launchpad/docs-commons?author=${ME}&tab=work`);

  const panel = page.getByTestId("launch-load-error");
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await expect(panel).toHaveAttribute("data-outcome", "auth-required");
  await expect(panel.getByTestId("sign-recovery-action")).toHaveText(
    "Sign in with passkey",
  );
  await expect(page.getByTestId("launch-load-error-retry")).toBeVisible();
  await expect(page.getByText(/not found/i)).toHaveCount(0);
});

test("'not found' is said only after a read that worked, and a project published again after its removal shows", async ({
  page,
}) => {
  const relay = createMockRelay();
  // Taken off the list at 200, then published again at 300 under the same id: the removal hides only what came before.
  relay.seed(projectRecord(100, "Docs Commons (practice)"));
  relay.seed({
    id: "d".repeat(64),
    pubkey: ME,
    created_at: 200,
    kind: 5,
    tags: [["a", `37001:${ME}:docs-commons`]],
    content: "",
    sig: "sig",
  });
  relay.seed(projectRecord(300, "Docs Commons"));
  await relay.install(page);
  await installChain(page);

  await page.goto(`/launchpad/docs-commons?author=${ME}`);
  await expect(page.getByTestId("launch-hero")).toContainText("Docs Commons", {
    timeout: 30_000,
  });
  await expect(page.getByTestId("launch-hero")).not.toContainText("practice");

  await page.goto(`/launchpad/no-such-project?author=${ME}`);
  await expect(page.getByTestId("launch-not-found")).toContainText(
    "This project wasn't found.",
    { timeout: 30_000 },
  );
  await expect(page.getByTestId("launch-load-error")).toHaveCount(0);
});

test("a locked passkey is asked to unlock on the Start page, before anything is sent", async ({
  page,
}) => {
  const relay = createMockRelay();
  await seedLockedPasskey(page);
  await relay.install(page);
  await installChain(page);
  await page.goto("/start/contributor");

  const unlock = page.getByTestId("contributor-unlock");
  await expect(unlock).toBeVisible({ timeout: 30_000 });
  await expect(unlock.getByTestId("contributor-unlock-message")).toContainText(
    "Unlock your passkey first",
  );
  await expect(unlock.getByTestId("contributor-unlock-action")).toHaveText(
    "Sign in with passkey",
  );
  await expect(page.getByTestId("contributor-submit")).toBeDisabled();
  // Nothing was sent anywhere: no record, no transaction.
  expect(relay.events.filter((event) => event.kind === 37001)).toHaveLength(0);
});

test("a project set up earlier is not carried on while the passkey is locked: it asks to unlock first", async ({
  page,
}) => {
  const relay = createMockRelay();
  await seedLockedPasskey(page);
  // Kept in this browser from an earlier visit, before its DAO was made.
  await page.addInitScript(() => {
    const me = "e".repeat(64);
    window.localStorage.setItem(
      `creaton.contributor-start.${me}`,
      JSON.stringify({
        version: 3,
        author: me,
        launchId: "docs-commons",
        salt: `0x${"5a".repeat(32)}`,
        chainId: 31337,
        kit: `0x${"c1".repeat(20)}`,
        expectedSummoner: null,
        founder: `0x${"f0".repeat(20)}`,
        currency: `0x${"cc".repeat(20)}`,
        draft: {
          name: "Docs Commons",
          pitch: "Docs for everyone",
          symbol: "DOCS",
          founderShares: "100",
          budgetShares: "1000",
          projectCap: "100",
          reviewers: "",
          quorum: "",
          projects: [{ name: "Guides", check: "A guide", shares: "100" }],
        },
        dao: null,
        shares: null,
        createTx: null,
        recorded: false,
      }),
    );
  });
  await relay.install(page);
  await installChain(page);
  await page.goto("/start/contributor");

  await expect(page.getByTestId("contributor-run")).toBeVisible({
    timeout: 30_000,
  });
  const unlock = page.getByTestId("contributor-resume-unlock");
  await expect(unlock).toBeVisible();
  await expect(
    unlock.getByTestId("contributor-resume-unlock-message"),
  ).toContainText("Unlock your passkey first");
  await expect(page.getByTestId("contributor-resume")).toBeDisabled();
  expect(relay.events.filter((event) => event.kind === 37001)).toHaveLength(0);
});

test("the Start page says who the reviewers are, when all must agree, and one press lets more than half decide", async ({
  page,
}) => {
  const relay = createMockRelay();
  await relay.install(page);
  await installChain(page);
  await page.addInitScript((nsec) => {
    window.localStorage.setItem("buzz.identity.nsec", nsec);
    window.localStorage.setItem("buzz.identity.backedUp", "1");
  }, NSEC);
  await page.goto("/start/contributor");

  // Nobody here has linked an account to a name: it says what to ask of the reviewers, with a way to read again.
  await expect(page.getByTestId("contributor-people-none")).toContainText(
    "Show your name with this account",
    { timeout: 30_000 },
  );
  await expect(page.getByTestId("contributor-unlock")).toHaveCount(0);

  await page
    .getByTestId("contributor-reviewers")
    .fill(`0x${"71".repeat(20)}\n0x${"72".repeat(20)}`);
  const picked = page.getByTestId("contributor-reviewer-picked");
  await expect(picked).toHaveCount(2);
  await expect(picked.first()).toHaveAttribute("data-linked", "no");
  await expect(picked.first()).toContainText("Not linked to anyone here");
  await expect(page.getByTestId("contributor-quorum-said")).toHaveText(
    "Both must agree: two approvals approve it, two turn-downs turn it down. If they split, nothing is decided.",
  );
  // With two, more than half is both: only another reviewer helps, so no shortcut is offered.
  await expect(page.getByTestId("contributor-quorum-all")).toContainText(
    "If they split, or one doesn't answer, that piece of work stays stuck until its deadline passes. Name another reviewer.",
  );
  await expect(page.getByTestId("contributor-quorum-majority")).toHaveCount(0);
  await page
    .getByTestId("contributor-reviewers")
    .fill(`0x${"71".repeat(20)}\n0x${"72".repeat(20)}\n0x${"73".repeat(20)}`);
  await page.getByTestId("contributor-quorum").fill("3");
  await expect(page.getByTestId("contributor-quorum-said")).toHaveText(
    "All 3 must agree: 3 approvals approve it, 3 turn-downs turn it down. If they split, nothing is decided.",
  );
  await page.getByTestId("contributor-quorum-majority").click();
  await expect(page.getByTestId("contributor-quorum")).toHaveValue("");
  await expect(page.getByTestId("contributor-quorum-all")).toHaveCount(0);
  await expect(page.getByTestId("contributor-quorum-said")).toHaveText(
    "2 of these 3 decide: 2 approvals approve it, 2 turn-downs turn it down.",
  );
  // And the founder is asked how they know them (funding review D1); the form refuses a new project without it.
  await expect(page.getByTestId("contributor-reviewer-ties")).toBeVisible();
});
