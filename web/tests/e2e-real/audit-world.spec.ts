import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

import {
  expect as baseExpect,
  type Browser,
  type Page,
  test,
} from "@playwright/test";
import { finalizeEvent } from "nostr-tools/pure";

import { installKeyWallet, walletFromKey } from "../helpers/key-wallet";
import { checksumAddress } from "../../src/features/identity/lib/wallet-proof";
import { CAST, pubkeyOfCast } from "./audit-people.mjs";
import {
  keyFromHex,
  PEOPLE,
  post,
  pubkeyOf,
  publishSigned,
} from "./social-helpers.mjs";

/**
 * The screen audit's world (`scripts/web-screen-audit.sh`), built the way people would build it, on a real server and
 * a real chain: the Creaton contributor project from `docs/v3-review/CREATON-EXAMPLE-PROJECT.md` started on the Start
 * page, one piece of work submitted, reviewed, finished and awarded by vote, another waiting for review, a newcomer's
 * suggestion put to a vote that is still open, and a supporters board with rules, a moderator, a pinned and a locked
 * thread, replies and a report. Records nobody would make by hand in a page (profiles, the boards' setup) are
 * published directly, signed by the person they belong to. Writes `E2E_AUDIT_FIXTURE` for `screen-audit.spec.ts`.
 *
 * Not a test of the product: the contributor journeys check these steps. It stops only when the world cannot be built.
 */

const RELAY = "ws://localhost:3199";
const ANVIL_URL = process.env.E2E_ANVIL_URL ?? "";
const FIXTURE = process.env.E2E_AUDIT_FIXTURE ?? "";

test.skip(
  !ANVIL_URL || !FIXTURE,
  "set E2E_ANVIL_URL and E2E_AUDIT_FIXTURE (scripts/web-screen-audit.sh does)",
);

type Who = keyof typeof CAST;

/** Every step waits up to a minute: chain reads and server round trips, several people at once. */
const expect = baseExpect.configure({ timeout: 60_000 });

async function rpc(method: string, params: unknown[] = []): Promise<unknown> {
  const response = await fetch(ANVIL_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await response.json()) as { result?: unknown; error?: unknown };
  if (body.error) throw new Error(JSON.stringify(body.error));
  return body.result;
}

/** Let time pass on the chain, the way waiting would. */
async function pass(seconds: number) {
  await rpc("anvil_increaseTime", [seconds]);
  await rpc("anvil_mine", ["0x1"]);
}

function sql(query: string) {
  const db = process.env.DATABASE_URL;
  if (!db) throw new Error("DATABASE_URL is not set");
  execFileSync("psql", [db, "-v", "ON_ERROR_STOP=1", "-qc", query]);
}

interface Signed {
  id: string;
  pubkey: string;
}

/** Sign `template` as `who` and publish it to the real server. */
async function publishAs(
  who: Who,
  template: { kind: number; tags: string[][]; content: string },
): Promise<Signed> {
  const event = finalizeEvent(
    { created_at: Math.floor(Date.now() / 1000), ...template },
    keyFromHex(CAST[who].key),
  );
  const result = await publishSigned(CAST[who].key, event, RELAY);
  if (!result.accepted) {
    throw new Error(
      `${who}'s kind ${template.kind} was refused: ${result.reason}`,
    );
  }
  return event;
}

/** A browser of their own, signed in as `who`, their wallet one of Anvil's accounts. */
async function as(browser: Browser, who: Who, path: string): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  context.setDefaultTimeout(60_000);
  const page = await context.newPage();
  const person = CAST[who];
  if (person.walletKey) {
    const wallet = walletFromKey(person.walletKey);
    await installKeyWallet(page, wallet, {
      rpcUrl: ANVIL_URL,
      display: checksumAddress(wallet.address),
    });
  }
  await page.addInitScript(
    ([key, rpcUrl]) => {
      // Only the first load: the app stores the key wrapped once it has read it.
      if (!window.localStorage.getItem("buzz.identity.nsec")) {
        window.localStorage.setItem("buzz.identity.nsec", key);
      }
      window.localStorage.setItem("buzz.identity.backedUp", "1");
      window.localStorage.setItem("buzz.launchpad.rpc", rpcUrl);
    },
    [person.key, ANVIL_URL],
  );
  await page.goto(path);
  return page;
}

async function linkWallet(page: Page, who: Who) {
  await page.goto(`/u/${pubkeyOfCast(who)}`);
  await page
    .getByRole("button", { name: "Connect payment wallet", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Connect payment wallet" });
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "Connect wallet" }).click();
  await expect(page.getByTestId("payment-wallet-address")).toHaveText(
    new RegExp(CAST[who].wallet ?? "", "i"),
  );
}

const claimCard = (page: Page, name: string) =>
  page.getByTestId("work-claim").filter({ hasText: name });

async function openTab(page: Page, path: string, tab: string) {
  await page.goto(path);
  await page.getByRole("tab", { name: tab }).click();
}

async function submitFromWaysToHelp(
  page: Page,
  area: string,
  name: string,
  evidence: string,
) {
  const way = page.locator(`[data-testid="way-to-help"][data-area="${area}"]`);
  await expect(way.getByTestId("way-to-help-words")).toBeVisible();
  await way.getByTestId("way-to-help-submit").click();
  await page.getByTestId("work-claim-name").fill(name);
  await page.getByTestId("work-claim-evidence").fill(evidence);
  await page.getByTestId("work-claim-submit").click();
  await expect(page.getByTestId("work-claim-filed")).toBeVisible({
    timeout: 90_000,
  });
}

/** Back the newest decision, let its review pass, start its wait, let that pass, and run it. */
async function carryOut(page: Page, path: string) {
  const card = () => page.getByTestId("decision-card").first();
  await expect(card().getByTestId("decision-status")).toHaveText(
    "Collecting support",
  );
  await card().getByTestId("decision-vote-for").click();
  // "Backing 0" until the vote is recorded.
  await expect(card().getByTestId("decision-support")).toContainText(
    /Backing [1-9]/,
  );
  await pass(90_000);
  await openTab(page, path, "Decisions");
  await expect(card().getByTestId("decision-status")).toHaveText("Approved");
  await card().getByTestId("decision-start-wait").click();
  await expect(card().getByTestId("decision-status")).toHaveText(
    "Waiting to take effect",
  );
  await pass(90_000);
  await openTab(page, path, "Decisions");
  await expect(card().getByTestId("decision-status")).toHaveText(
    "Ready to take effect",
  );
  await card().getByTestId("decision-run").click();
  await expect(card().getByTestId("decision-status")).toHaveText("Done");
}

const AREAS = [
  {
    name: "first-hour-notes",
    shares: "10000",
    check:
      "A written account of your first hour on Creaton (signing up, finding this project, submitting this work), naming each place you got stuck or unsure, posted on the supporters board.",
  },
  {
    name: "plain-guide",
    shares: "15000",
    check:
      "A one-page guide in plain words to how work becomes Shares here (submit, review, the 7-day window, the award vote), posted on the supporters board, that both reviewers find accurate.",
  },
  {
    name: "phone-review",
    shares: "15000",
    check:
      "Screenshots of Start, Work and Contributions on a phone, each with what is hard to read or tap and a suggested change, posted on the supporters board.",
  },
  {
    name: "bug-report",
    shares: "10000",
    check:
      "A bug found by using Creaton, with the steps to reproduce it, what you expected and what happened, posted on the supporters board and reproduced by a reviewer.",
  },
];

test("the screen audit's world", async ({ browser }) => {
  test.setTimeout(20 * 60_000);

  // ── People: members of the server's community, with profiles and a few follows ─────────────────────
  for (const who of Object.keys(CAST) as Who[]) {
    sql(`INSERT INTO relay_members (community_id, pubkey, role, added_by)
           SELECT id, '${pubkeyOfCast(who)}', 'member', 'seed' FROM communities
           WHERE lower(host) = 'localhost:3199' ON CONFLICT DO NOTHING;`);
    await publishAs(who, {
      kind: 0,
      tags: [],
      content: JSON.stringify({
        name: CAST[who].name,
        display_name: CAST[who].name,
        about: CAST[who].about,
      }),
    });
  }
  const follows = (names: Who[]) =>
    names.map((name) => ["p", pubkeyOfCast(name)]);
  await publishAs("nia", {
    kind: 3,
    tags: follows(["frida", "cora"]),
    content: "",
  });
  await publishAs("cora", { kind: 3, tags: follows(["frida"]), content: "" });

  // ── The supporters board, a private room, and what is on them ─────────────────────────────────────
  const supporters = randomUUID();
  await publishAs("frida", {
    kind: 9007,
    tags: [
      ["h", supporters],
      ["name", "supporters"],
      ["about", "Questions, ideas and finished work for the Creaton project."],
      ["visibility", "open"],
      ["channel_type", "forum"],
    ],
    content: "",
  });
  const room = randomUUID();
  await publishAs("frida", {
    kind: 9007,
    tags: [
      ["h", room],
      ["name", "founders-room"],
      ["visibility", "private"],
      ["channel_type", "stream"],
    ],
    content: "",
  });
  await publishAs("frida", {
    kind: 9000,
    tags: [
      ["h", room],
      ["p", pubkeyOfCast("rui")],
      ["role", "member"],
    ],
    content: "",
  });
  await publishAs("frida", {
    kind: 9,
    tags: [["h", room]],
    content: "Rui, can you take the first review this week?",
  });
  await publishAs("frida", {
    kind: 9051,
    tags: [["h", supporters]],
    content:
      "Be kind, and stay on the topic of Creaton.\nNo selling and no links to sales.\nAsk before posting someone else's work.",
  });
  await publishAs("frida", {
    kind: 9052,
    tags: [
      ["h", supporters],
      ["p", pubkeyOfCast("mo")],
    ],
    content: "",
  });
  const boardPost = (who: Who, title: string, body: string) =>
    publishAs(who, {
      kind: 45001,
      tags: [["h", supporters]],
      content: `# ${title}\n\n${body}`,
    });
  const stuck = await boardPost(
    "frida",
    "Where did you get stuck?",
    "If anything about Creaton confused you, reply here, even with one sentence. If you want Shares for it, the first-hour-notes work area is for exactly this.",
  );
  const next = await boardPost(
    "frida",
    "What should we work on next?",
    "Suggest a piece of work on the Creaton project's Work tab, under Suggested work: what you would do, what finished looks like, and your price.",
  );
  const notes = await boardPost(
    "cora",
    "My first hour on Creaton",
    "Signing up took a minute. I got stuck twice: I did not know what a work area was, and I looked for the Submit button on the Overview instead of the Work tab.",
  );
  const old = await boardPost(
    "frida",
    "Setup checklist (done)",
    "Everything on this list is done. Locked so the replies stay where they are.",
  );
  await publishAs("frida", {
    kind: 9047,
    tags: [
      ["h", supporters],
      ["e", stuck.id],
    ],
    content: "",
  });
  await publishAs("frida", {
    kind: 9045,
    tags: [
      ["h", supporters],
      ["e", old.id],
    ],
    content: "Done, kept for reference.",
  });
  const reply = (who: Who, root: Signed, text: string) =>
    publishAs(who, {
      kind: 45003,
      tags: [
        ["h", supporters],
        ["e", root.id, "", "root"],
        ["p", root.pubkey],
      ],
      content: text,
    });
  await reply("nia", stuck, "I wasn't sure what Shares are for at first.");
  await reply(
    "cora",
    stuck,
    "Same here. Open work made it clear once I found it.",
  );
  const spam = await post(
    "carol",
    {
      kind: 45001,
      tags: [["h", supporters]],
      content: "# Cheap followers\n\nDM me for a price.",
    },
    RELAY,
  );
  await publishAs("cora", {
    kind: 1984,
    tags: [
      ["e", spam.id, "spam"],
      ["p", pubkeyOf("carol")],
    ],
    content: "Selling followers",
  });
  const invitation = await publishAs("frida", {
    kind: 1,
    tags: [["t", "creaton"]],
    content:
      "Help build Creaton. Four pieces of work are open on the Creaton project, and you need no Shares and no crypto experience to do them: notes on your first hour here, a plain guide, a phone review, or a bug you found. Open the project and look under Open work. #creaton",
  });

  // ── Wallets linked, so pages show names instead of addresses ───────────────────────────────────────
  const pages = Object.fromEntries(
    await Promise.all(
      (["frida", "rui", "rae", "cora", "nia"] as Who[]).map(
        async (who) => [who, await as(browser, who, "/")] as const,
      ),
    ),
  ) as Record<"frida" | "rui" | "rae" | "cora" | "nia", Page>;
  await Promise.all(
    (Object.keys(pages) as (keyof typeof pages)[]).map((who) =>
      linkWallet(pages[who], who),
    ),
  );

  // ── The Creaton project, started on the Start page ──────────────────────────────────────────────────
  const frida = pages.frida;
  await frida.goto("/start/contributor");
  await frida.getByTestId("contributor-name").fill("Creaton");
  await frida
    .getByTestId("contributor-pitch")
    .fill(
      "A place to meet, discuss projects, do useful work and earn a say in what a project does.",
    );
  await frida.getByTestId("contributor-symbol").fill("CREA");
  await frida.getByTestId("contributor-founder-shares").fill("100000");
  await frida.getByTestId("contributor-budget-shares").fill("300000");
  await frida.getByTestId("contributor-project-cap").fill("25000");
  await frida
    .getByTestId("contributor-reviewers")
    .fill(`${CAST.rui.wallet}\n${CAST.rae.wallet}`);
  for (const [index, area] of AREAS.entries()) {
    if (index > 0) await frida.getByTestId("contributor-project-add").click();
    const suffix = index === 0 ? "" : `-${index}`;
    await frida
      .getByTestId(`contributor-project-name${suffix}`)
      .fill(area.name);
    await frida
      .getByTestId(`contributor-project-shares-${index}`)
      .fill(area.shares);
    await frida
      .getByTestId(`contributor-project-check${suffix}`)
      .fill(area.check);
  }
  await expect(frida.getByTestId("contributor-gate")).toHaveCount(0, {
    timeout: 30_000,
  });
  await frida.getByTestId("contributor-submit").click();
  await expect(frida.getByTestId("contributor-done")).toBeVisible({
    timeout: 180_000,
  });
  await frida.getByTestId("contributor-open-project").click();
  await expect(frida.getByTestId("contributor-badge")).toBeVisible();
  const project = new URL(frida.url());
  project.searchParams.delete("tab");
  const projectPath = `${project.pathname}${project.search}`;
  const tabPath = (tab: string) =>
    `${projectPath}${project.search ? "&" : "?"}tab=${tab}`;

  await frida.getByRole("button", { name: "Post update" }).click();
  await frida.locator("#update-title").fill("Creaton is open to a first group");
  await frida
    .locator("#update-body")
    .fill(
      "Four pieces of work are open under Open work, and anyone can suggest more. Tell us when something is unclear: that is the most useful thing you can tell us.",
    );
  await frida.getByRole("button", { name: "Publish update" }).click();
  await expect(frida.getByRole("dialog", { name: "Post update" })).toHaveCount(
    0,
    { timeout: 60_000 },
  );

  // ── One piece of work, from submitted to awarded ────────────────────────────────────────────────────
  const cora = pages.cora;
  await cora.goto(tabPath("work"));
  await submitFromWaysToHelp(
    cora,
    "first-hour-notes",
    "first-hour",
    `http://localhost:3199/b/${supporters}?post=${notes.id}`,
  );
  await openTab(frida, projectPath, "Work");
  await claimCard(frida, "first-hour").getByTestId("work-bind").click();
  await expect(
    claimCard(frida, "first-hour").getByTestId("work-claim-next"),
  ).toContainText("0 of 2 approvals");
  for (const who of ["rui", "rae"] as const) {
    await openTab(pages[who], projectPath, "Work");
    await claimCard(pages[who], "first-hour")
      .getByTestId("work-approve")
      .click();
    await expect(
      claimCard(pages[who], "first-hour").getByTestId("work-claim-next"),
    ).not.toContainText("0 of 2 approvals");
  }
  await openTab(frida, projectPath, "Work");
  await claimCard(frida, "first-hour").getByTestId("work-settle").click();
  await expect(
    claimCard(frida, "first-hour").getByTestId("work-claim-status"),
  ).toContainText("Approved");
  await pass(700_000);
  await openTab(cora, projectPath, "Work");
  await claimCard(cora, "first-hour").getByTestId("work-payout").click();
  await expect(
    claimCard(cora, "first-hour").getByTestId("work-claim-status"),
  ).toContainText("Finished");
  await openTab(frida, projectPath, "Decisions");
  await frida.getByTestId("decision-new").click();
  await frida.getByTestId("decision-kind-award").click();
  const select = frida.getByTestId("award-claim");
  await expect(select).toBeVisible();
  const value = await select
    .locator("option", { hasText: "First hour" })
    .getAttribute("value");
  await select.selectOption(value ?? "");
  await frida.getByTestId("award-shares").fill("8000");
  await frida.getByTestId("decision-draft-submit").click();
  await expect(frida.getByTestId("decision-opened")).toBeVisible();
  await carryOut(frida, projectPath);

  // ── Another piece waiting for review ────────────────────────────────────────────────────────────────
  await cora.goto(tabPath("work"));
  await submitFromWaysToHelp(
    cora,
    "plain-guide",
    "plain-guide-draft",
    "https://example.com/creaton-guide",
  );

  // ── A newcomer's suggestion, put to a vote that is still open ───────────────────────────────────────
  const nia = pages.nia;
  await nia.goto(tabPath("work"));
  await nia.getByTestId("suggest-work").click();
  await nia
    .getByTestId("suggest-title")
    .fill("Plant guide for community gardens");
  await nia
    .getByTestId("suggest-body")
    .fill(
      "A short guide for gardens that want to use Creaton to share the work of keeping a garden going.",
    );
  await nia.getByTestId("suggest-name").fill("garden-guide");
  await nia
    .getByTestId("suggest-check")
    .fill(
      "A two-page guide for community gardens, posted on the supporters board, that both reviewers find accurate.",
    );
  await nia.getByTestId("suggest-amount").fill("2");
  await nia.getByTestId("suggest-submit").click();
  await expect(
    nia.locator('[data-testid^="work-proposal-"][data-status]'),
  ).toHaveCount(1);
  await openTab(frida, projectPath, "Work");
  const toSponsor = frida.locator(
    '[data-testid^="work-proposal-"][data-status="suggested"]',
  );
  await expect(toSponsor).toHaveCount(1);
  await toSponsor.getByTestId("work-proposal-sponsor").click();
  await expect(frida.getByTestId("decision-from-suggestion")).toBeVisible();
  await frida.getByTestId("decision-draft-submit").click();
  await expect(frida.getByTestId("decision-opened")).toBeVisible();

  writeFileSync(
    FIXTURE,
    JSON.stringify(
      {
        host: "localhost:3199",
        anvil: ANVIL_URL,
        projectPath,
        boards: { supporters, room },
        posts: {
          stuck: stuck.id,
          next: next.id,
          notes: notes.id,
          locked: old.id,
          spam: spam.id,
          invitation: invitation.id,
        },
        cast: Object.fromEntries(
          (Object.keys(CAST) as Who[]).map((who) => [
            who,
            { ...CAST[who], pubkey: pubkeyOfCast(who) },
          ]),
        ),
        social: Object.fromEntries(
          Object.keys(PEOPLE).map((name) => [
            name,
            {
              key: PEOPLE[name as keyof typeof PEOPLE],
              pubkey: pubkeyOf(name),
            },
          ]),
        ),
      },
      null,
      2,
    ),
  );
});

/**
 * With bounties in the build (`WEB_FEATURES=mvp+forecasts`): money behind a work area and behind a post, and
 * "Will it get done?" forecasts on both, so the capture shows those panels with something in them. Runs on the world
 * the test above made, read back from its fixture.
 */
test("money behind work and a post, with forecasts on both", async ({
  browser,
}) => {
  test.skip(
    process.env.E2E_AUDIT_MONEY !== "1",
    "set E2E_AUDIT_MONEY=1 (WEB_FEATURES=mvp+forecasts does)",
  );
  test.setTimeout(10 * 60_000);
  const world = JSON.parse(readFileSync(FIXTURE, "utf8")) as {
    projectPath: string;
    posts: { invitation: string };
  };
  const area = (page: Page) =>
    // The area's card wherever it is: under Open work while it takes work, under its budget once it does not.
    page.getByTestId("work-tab").locator('[data-area="plain-guide"]');
  const give = async (
    panel: ReturnType<Page["getByTestId"]>,
    percent: string,
    reason: string,
  ) => {
    await panel.getByTestId("forecast-percent").fill(percent);
    await panel.getByTestId("forecast-reason").fill(reason);
    await panel.getByTestId("forecast-submit").click();
    // This person's own forecast, not one already there.
    await expect(panel).toContainText(`Yours: ${percent}%`);
  };

  // Frida puts 50 behind the plain guide.
  const frida = await as(browser, "frida", world.projectPath);
  await openTab(frida, world.projectPath, "Work");
  await area(frida).getByTestId("work-bounty-open").click();
  await area(frida).getByTestId("work-bounty-amount").fill("50");
  await area(frida).getByTestId("work-bounty-submit").click();
  await expect(area(frida).getByTestId("work-bounty-held")).toContainText(
    "50",
    { timeout: 90_000 },
  );
  await frida.context().close();

  // Two people say whether they think it gets done.
  for (const [who, percent, reason] of [
    ["nia", "60", "Two people asked for a plain guide on the board already."],
    ["cora", "75", "Most of it is in my first-hour notes."],
  ] as const) {
    const page = await as(browser, who, world.projectPath);
    await openTab(page, world.projectPath, "Work");
    await give(area(page).getByTestId("forecast-panel"), percent, reason);
    await page.context().close();
  }

  // Rui puts 30 behind the invitation post, for a newcomer's first board post; Mo gives a forecast on it.
  const postPath = `/social/post/${world.posts.invitation}`;
  const rui = await as(browser, "rui", postPath);
  const card = rui.getByTestId("post-bounty");
  await card.getByTestId("post-bounty-open").click();
  await card
    .getByTestId("post-bounty-words-input")
    .fill(
      "A first post on the supporters board by someone who joined this month, saying what they want to build.",
    );
  await card.getByTestId("post-bounty-amount").fill("30");
  await card.getByTestId("post-bounty-submit").click();
  const item = (page: Page) =>
    page.getByTestId("post-bounty").getByTestId("post-bounty-item").first();
  await expect(item(rui).getByTestId("post-bounty-held")).toContainText("30", {
    timeout: 90_000,
  });
  await rui.context().close();
  const mo = await as(browser, "mo", postPath);
  await give(
    item(mo).getByTestId("forecast-panel"),
    "55",
    "New people post when someone asks them directly.",
  );
  await mo.context().close();
});
