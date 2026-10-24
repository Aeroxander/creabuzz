import AxeBuilder from "@axe-core/playwright";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

import { type Browser, type Page, test } from "@playwright/test";
import { generateSecretKey } from "nostr-tools/pure";

import { installKeyWallet, walletFromKey } from "../helpers/key-wallet";
import { checksumAddress } from "../../src/features/identity/lib/wallet-proof";
import { waitForAnimations } from "../helpers/animations";

/**
 * Every screen of the web app, with the screen audit's world behind it (`scripts/web-screen-audit.sh` builds the world
 * with `audit-world.spec.ts`, then runs this). Each stop is opened as one person, at desktop and at phone width, and
 * saved into E2E_SHOTS as `<stop>-<width>.png`, with the words on the screen in `<stop>-<width>.txt` and one line per
 * capture in `index.ndjson` (words, accessibility findings, sideways scroll, anything that could not be opened).
 *
 * Not a test: nothing here fails on what the screens say. A stop that cannot be opened is still captured as it is, with
 * the reason in the index.
 */

const FIXTURE = process.env.E2E_AUDIT_FIXTURE ?? "";
const SHOTS = process.env.E2E_SHOTS ?? "";
const ONLY = process.env.ONLY ?? "";

test.skip(
  !FIXTURE || !SHOTS,
  "set E2E_AUDIT_FIXTURE and E2E_SHOTS (scripts/web-screen-audit.sh does)",
);

interface Person {
  key: string;
  pubkey: string;
  wallet?: string | null;
  walletKey?: string | null;
}
interface World {
  host: string;
  anvil: string;
  projectPath: string;
  boards: { supporters: string; room: string };
  posts: Record<string, string>;
  cast: Record<string, Person>;
  social: Record<string, Person>;
}
const world: World | null = FIXTURE
  ? (JSON.parse(readFileSync(FIXTURE, "utf8")) as World)
  : null;

/** Who a stop is seen as: nobody, a brand-new account, or someone in the world. */
type Who =
  | "visitor"
  | "newbie"
  | "frida"
  | "rui"
  | "cora"
  | "nia"
  | "mo"
  | "dev";

interface Stop {
  name: string;
  who: Who;
  path: string;
  /** What to press after the page loads, to reach the state the stop is about. */
  open?: (page: Page) => Promise<void>;
  /** Also captured in the dark theme. */
  dark?: boolean;
}

const W = world as World;
const project = (tab?: string) =>
  world ? `${W.projectPath}${tab ? `&tab=${tab}` : ""}` : "/";
const board = (post?: string) =>
  world
    ? `/b/${W.boards.supporters}${post ? `?post=${W.posts[post]}` : ""}`
    : "/";
const community = (query = "") => `/c/localhost:3199${query}`;

const click = (testId: string) => async (page: Page) => {
  await page.getByTestId(testId).first().click();
};
const tab = (name: string) => async (page: Page) => {
  await page.getByRole("tab", { name, exact: true }).click();
};
const steps =
  (...actions: ((page: Page) => Promise<void>)[]) =>
  async (page: Page) => {
    for (const action of actions) {
      await action(page);
      await page.waitForTimeout(400);
    }
  };
const roleButton = (name: string | RegExp) => async (page: Page) => {
  await page.getByRole("button", { name }).first().click();
};
const decision = (kind: string) =>
  steps(
    tab("Decisions"),
    click("decision-new"),
    click(`decision-kind-${kind}`),
  );

const STOPS: Stop[] = [
  // ── Arriving, signed out ──────────────────────────────────────────────────────────────────────────
  { name: "a01-home-visitor", who: "visitor", path: "/", dark: true },
  { name: "a02-explore-visitor", who: "visitor", path: "/social/explore" },
  {
    name: "a03-search-visitor",
    who: "visitor",
    path: "/social/search?q=creaton",
  },
  { name: "a04-hashtag-visitor", who: "visitor", path: "/social/tag/creaton" },
  {
    name: "a05-post-visitor",
    who: "visitor",
    path: world ? `/social/post/${W.posts.invitation}` : "/",
  },
  {
    name: "a06-profile-visitor",
    who: "visitor",
    path: world ? `/u/${W.cast.frida.pubkey}` : "/",
  },
  { name: "a07-board-visitor", who: "visitor", path: board() },
  { name: "a08-thread-visitor", who: "visitor", path: board("stuck") },
  { name: "a09-communities-visitor", who: "visitor", path: "/c" },
  { name: "a10-community-visitor", who: "visitor", path: community() },
  { name: "a11-start-visitor", who: "visitor", path: "/start", dark: true },
  { name: "a12-project-visitor", who: "visitor", path: project(), dark: true },
  { name: "a13-project-work-visitor", who: "visitor", path: project("work") },
  {
    name: "a14-project-contributions-visitor",
    who: "visitor",
    path: project("contributions"),
  },
  { name: "a15-discover-visitor", who: "visitor", path: "/discover" },
  { name: "a16-not-found", who: "visitor", path: "/no-such-page" },
  {
    name: "a17-invite-bad-link",
    who: "visitor",
    path: "/invite/not-a-real-code",
  },
  // ── Signing up and the account ─────────────────────────────────────────────────────────────────────
  {
    name: "b01-signup",
    who: "visitor",
    path: "/",
    open: click("create-identity-cta"),
  },
  {
    name: "b02-signup-name",
    who: "visitor",
    path: "/",
    open: steps(click("create-identity-cta"), async (page) => {
      await page.getByTestId("onboarding-name").fill("Sam");
    }),
  },
  { name: "b03-home-first-run", who: "newbie", path: "/", dark: true },
  {
    name: "b04-profile-menu",
    who: "newbie",
    path: "/",
    open: click("user-chip"),
  },
  {
    name: "b05-recovery-key",
    who: "newbie",
    path: "/",
    open: steps(click("user-chip"), roleButton(/recovery key/i)),
  },
  {
    name: "b10-signin",
    who: "visitor",
    path: "/",
    open: steps(click("create-identity-cta"), click("onboarding-signin")),
  },
  {
    name: "b11-signout",
    who: "nia",
    path: "/",
    open: steps(click("user-chip"), roleButton("Sign out")),
  },
  {
    name: "b06-own-profile-new",
    who: "newbie",
    path: "/u/me",
  },
  {
    name: "b07-edit-profile",
    who: "nia",
    path: world ? `/u/${W.cast.nia.pubkey}` : "/",
    open: click("profile-edit"),
  },
  {
    name: "b08-own-profile-wallet",
    who: "nia",
    path: world ? `/u/${W.cast.nia.pubkey}` : "/",
  },
  {
    name: "b09-link-wallet-dialog",
    who: "mo",
    path: world ? `/u/${W.cast.mo.pubkey}` : "/",
    open: roleButton("Connect payment wallet"),
  },
  // ── Home and the social side ───────────────────────────────────────────────────────────────────────
  { name: "c01-home-member", who: "nia", path: "/", dark: true },
  { name: "c02-home-following", who: "nia", path: "/?tab=following" },
  { name: "c03-home-boards", who: "nia", path: "/?tab=boards" },
  { name: "c04-home-projects", who: "nia", path: "/?tab=projects" },
  {
    name: "c05-home-composer",
    who: "nia",
    path: "/",
    open: async (page) => {
      await page.getByRole("textbox").first().click();
      await page
        .getByRole("textbox")
        .first()
        .fill("Has anyone tried the plain guide yet?");
    },
  },
  { name: "c06-home-founder", who: "frida", path: "/" },
  { name: "c07-home-reviewer", who: "rui", path: "/" },
  {
    name: "c08-post-report",
    who: "nia",
    path: world ? `/social/post/${W.posts.invitation}` : "/",
    open: click("social-report"),
  },
  {
    name: "c09-post-quote",
    who: "nia",
    path: world ? `/social/post/${W.posts.invitation}` : "/",
    open: steps(click("social-repost"), click("social-quote")),
  },
  { name: "c10-notifications", who: "frida", path: "/social/notifications" },
  { name: "c11-messages", who: "dev", path: "/social/messages" },
  {
    name: "c12-new-message",
    who: "dev",
    path: "/social/messages",
    open: click("social-new-message-button"),
  },
  {
    name: "c13-conversation",
    who: "dev",
    path: world ? `/social/messages/${W.social.alice.pubkey}` : "/",
  },
  { name: "c14-bookmarks", who: "nia", path: "/social/bookmarks" },
  {
    name: "c15-other-profile",
    who: "nia",
    path: world ? `/u/${W.cast.cora.pubkey}` : "/",
  },
  {
    name: "c16-mute-report-person",
    who: "nia",
    path: world ? `/u/${W.social.carol.pubkey}` : "/",
    open: click("profile-report"),
  },
  // ── Boards ─────────────────────────────────────────────────────────────────────────────────────────
  { name: "d01-board-member", who: "nia", path: board() },
  {
    name: "d02-board-new-post",
    who: "nia",
    path: board(),
    open: click("board-new-post"),
  },
  { name: "d03-thread-member", who: "nia", path: board("stuck") },
  { name: "d04-thread-locked", who: "nia", path: board("locked") },
  {
    name: "d05-board-moderation-owner",
    who: "frida",
    path: board(),
    open: click("board-moderation-toggle"),
  },
  {
    name: "d06-board-moderation-moderator",
    who: "mo",
    path: board(),
    open: click("board-moderation-toggle"),
  },
  {
    name: "d07-moderate-menu",
    who: "mo",
    path: board("spam"),
    open: roleButton("Moderate"),
  },
  {
    name: "d08-remove-dialog",
    who: "mo",
    path: board("spam"),
    open: steps(roleButton("Moderate"), async (page) => {
      await page
        .getByRole("menuitem", { name: /remove/i })
        .first()
        .click();
    }),
  },
  {
    name: "d09-mute-dialog",
    who: "mo",
    path: board("spam"),
    open: steps(roleButton("Moderate"), async (page) => {
      await page.getByRole("menuitem", { name: /mute/i }).first().click();
    }),
  },
  {
    name: "d10-start-board",
    who: "nia",
    path: "/?tab=boards",
    open: click("board-directory-start"),
  },
  // ── Communities ────────────────────────────────────────────────────────────────────────────────────
  { name: "e01-community-member", who: "nia", path: community(), dark: true },
  {
    name: "e02-community-room",
    who: "nia",
    path: community(),
    open: click("channel-general"),
  },
  {
    name: "e03-community-private-room",
    who: "rui",
    path: community(),
    open: steps(click("channel-founders-room"), click("room-people-toggle")),
  },
  {
    name: "e04-community-messages",
    who: "dev",
    path: community(),
    open: click("dms-toggle"),
  },
  {
    name: "e05-community-search",
    who: "nia",
    path: community(),
    open: async (page) => {
      await page.getByTestId("search-input").fill("creaton");
    },
  },
  {
    name: "e06-community-board",
    who: "nia",
    path: community(),
    open: click("board-nav-supporters"),
  },
  {
    name: "e07-community-setup",
    who: "dev",
    path: community(),
    open: click("start-project-toggle"),
  },
  {
    name: "e08-community-people",
    who: "dev",
    path: community("?view=org"),
  },
  {
    name: "e11-new-room",
    who: "dev",
    path: community(),
    open: click("new-channel"),
  },
  {
    name: "e12-moderation-queue",
    who: "dev",
    path: community(),
    open: click("moderation-toggle"),
  },
  {
    name: "e13-create-community",
    who: "nia",
    path: "/c",
    open: click("create-community"),
  },
  // ── Starting a contributor project ─────────────────────────────────────────────────────────────────
  { name: "f01-start-member", who: "nia", path: "/start" },
  {
    name: "f02-contributor-no-wallet",
    who: "newbie",
    path: "/start/contributor",
  },
  { name: "f03-contributor-form", who: "cora", path: "/start/contributor" },
  {
    name: "f04-contributor-form-filled",
    who: "cora",
    path: "/start/contributor",
    open: async (page) => {
      await page.getByTestId("contributor-name").fill("Garden Commons");
      await page
        .getByTestId("contributor-pitch")
        .fill("Shared tools and a rota for the Elm Street garden.");
      await page.getByTestId("contributor-project-name").fill("rota");
      await page
        .getByTestId("contributor-project-check")
        .fill("A rota for the next three months, posted on the board.");
    },
  },
  {
    name: "f05-contributor-form-problem",
    who: "cora",
    path: "/start/contributor",
    open: async (page) => {
      await page.getByTestId("contributor-name").fill("Garden Commons");
      await page.getByTestId("contributor-founder-shares").fill("999999999");
      await page.getByTestId("contributor-submit").click();
    },
  },
  // ── A contributor project, as each person meets it ─────────────────────────────────────────────────
  { name: "g01-project-overview-member", who: "nia", path: project() },
  { name: "g02-project-work-member", who: "nia", path: project("work") },
  {
    name: "g03-submit-work-form",
    who: "nia",
    path: project("work"),
    open: async (page) => {
      await page
        .locator('[data-testid="way-to-help"][data-area="phone-review"]')
        .getByTestId("way-to-help-submit")
        .click();
    },
  },
  {
    name: "g04-submit-work-problem",
    who: "nia",
    path: project("work"),
    open: async (page) => {
      await page
        .locator('[data-testid="way-to-help"][data-area="phone-review"]')
        .getByTestId("way-to-help-submit")
        .click();
      await page.getByTestId("work-claim-submit").click();
    },
  },
  {
    name: "g05-suggest-work",
    who: "nia",
    path: project("work"),
    open: click("suggest-work"),
  },
  {
    name: "g06-project-decisions-member",
    who: "nia",
    path: project("decisions"),
  },
  {
    name: "g07-project-contributions",
    who: "nia",
    path: project("contributions"),
  },
  { name: "g08-project-record", who: "nia", path: project("record") },
  { name: "g09-project-treasury", who: "nia", path: project("treasury") },
  { name: "g10-project-people", who: "nia", path: project("agents") },
  { name: "g11-project-discussion", who: "nia", path: project("discussion") },
  { name: "g12-project-updates", who: "nia", path: project("updates") },
  { name: "g13-project-overview-founder", who: "frida", path: project() },
  { name: "g14-project-work-founder", who: "frida", path: project("work") },
  {
    name: "g15-project-decisions-founder",
    who: "frida",
    path: project("decisions"),
  },
  { name: "g16-project-manage", who: "frida", path: project("manage") },
  {
    name: "g17-post-update",
    who: "frida",
    path: project(),
    open: roleButton("Post update"),
  },
  {
    name: "g18-new-decision",
    who: "frida",
    path: project("decisions"),
    open: click("decision-new"),
  },
  ...[
    "budget",
    "project",
    "award",
    "pay",
    "freeze",
    "unwind",
    "slash",
    "close",
    "trading",
  ]
    .map(
      (kind, index): Stop => ({
        name: `g${String(19 + index).padStart(2, "0")}-decision-${kind}`,
        who: "frida",
        path: project("decisions"),
        open: decision(kind),
      }),
      // A contributor project offers no money decisions (D108).
    )
    .filter((stop) => !/-(pay|unwind|slash)$/.test(stop.name)),
  { name: "g28-project-work-reviewer", who: "rui", path: project("work") },
  { name: "g29-project-overview-reviewer", who: "rui", path: project() },
  { name: "g30-project-work-contributor", who: "cora", path: project("work") },
  { name: "g31-portfolio-contributor", who: "cora", path: "/portfolio" },
  { name: "g32-portfolio-founder", who: "frida", path: "/portfolio" },
  // ── Discover, the projects board and the sale path ─────────────────────────────────────────────────
  { name: "h01-discover", who: "nia", path: "/discover" },
  { name: "h02-projects-board", who: "nia", path: "/projects" },
  {
    name: "h03-pitch-dialog",
    who: "nia",
    path: "/projects",
    open: roleButton(/pitch a project/i),
  },
  { name: "h04-launchpad", who: "nia", path: "/launchpad" },
  {
    name: "h05-launch-detail",
    who: "nia",
    path: "/launchpad",
    open: async (page) => {
      await page.getByText("Nebula").first().click();
    },
  },
  {
    name: "h06-sale-wizard",
    who: "frida",
    path: "/launchpad",
    open: roleButton("Set up a sale"),
  },
  {
    name: "h07-sale-wizard-next",
    who: "frida",
    path: "/launchpad",
    open: steps(roleButton("Set up a sale"), async (page) => {
      const step = page.getByTestId("wizard-step-token");
      await step
        .getByRole("textbox", { name: "Name", exact: true })
        .fill("Garden Fund");
      await step.getByLabel("Symbol").fill("GRDN");
      await page
        .getByRole("button", { name: /^continue$/i })
        .first()
        .click();
    }),
  },
  { name: "h08-idea-dialog", who: "frida", path: "/launchpad?start=idea" },
  { name: "h09-sandbox", who: "nia", path: "/launchpad/nebula-sandbox" },
  { name: "h10-markets", who: "nia", path: "/markets" },
  // ── The rest a person can reach ────────────────────────────────────────────────────────────────────
  { name: "i01-repos", who: "nia", path: "/repos" },
  { name: "i02-wiki", who: "dev", path: community("?view=wiki") },
  { name: "i03-ai-helpers", who: "dev", path: community("?view=fleet") },
  { name: "i04-work-board", who: "dev", path: community("?view=work") },
  { name: "i05-link-device", who: "nia", path: "/link-device" },
  { name: "i06-identity-demo", who: "visitor", path: "/identity-demo" },
];

function personFor(who: Who): Person | null {
  if (!world || who === "visitor") return null;
  if (who === "newbie") {
    const key = Array.from(generateSecretKey(), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
    return { key, pubkey: "" };
  }
  if (who === "dev") return W.social.dev;
  return W.cast[who];
}

async function openAs(
  browser: Browser,
  who: Who,
  width: "desktop" | "phone",
  dark: boolean,
): Promise<Page> {
  const phone = width === "phone";
  const context = await browser.newContext({
    viewport: phone
      ? { width: 390, height: 844 }
      : { width: 1280, height: 800 },
    hasTouch: phone,
    isMobile: phone,
    colorScheme: dark ? "dark" : "light",
  });
  context.setDefaultTimeout(15_000);
  const page = await context.newPage();
  const person = personFor(who);
  if (person?.walletKey && world) {
    const wallet = walletFromKey(person.walletKey);
    await installKeyWallet(page, wallet, {
      rpcUrl: W.anvil,
      display: checksumAddress(wallet.address),
    });
  }
  await page.addInitScript(
    ([key, rpcUrl, newbie]) => {
      if (key && !window.localStorage.getItem("buzz.identity.nsec")) {
        window.localStorage.setItem("buzz.identity.nsec", key);
      }
      if (key && !newbie)
        window.localStorage.setItem("buzz.identity.backedUp", "1");
      window.localStorage.setItem("buzz.launchpad.rpc", rpcUrl);
    },
    [person?.key ?? "", world?.anvil ?? "", who === "newbie"] as const,
  );
  return page;
}

async function capture(
  page: Page,
  stop: Stop,
  variant: string,
  problem: string,
) {
  await page.waitForTimeout(1500);
  await waitForAnimations(page).catch(() => undefined);
  const base = `${SHOTS}/${stop.name}-${variant}`;
  await page.screenshot({ path: `${base}.png`, fullPage: true });
  const text = await page.evaluate(() => document.body.innerText);
  writeFileSync(`${base}.txt`, text);
  const axe = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze()
    .catch(() => null);
  const blocking = (axe?.violations ?? [])
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => ({
      id: v.id,
      help: v.help,
      targets: v.nodes.slice(0, 3).map((n) => n.target.join(" ")),
    }));
  const sideways = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  appendFileSync(
    `${SHOTS}/index.ndjson`,
    `${JSON.stringify({
      stop: stop.name,
      variant,
      who: stop.who,
      path: stop.path,
      url: page.url(),
      words: text.split(/\s+/).filter(Boolean).length,
      accessibility: blocking,
      sideways,
      problem,
    })}\n`,
  );
}

for (const stop of STOPS) {
  if (ONLY && !stop.name.includes(ONLY)) continue;
  test(stop.name, async ({ browser }) => {
    test.setTimeout(120_000);
    const variants: ["desktop" | "phone", boolean][] = [
      ["desktop", false],
      ["phone", false],
      ...(stop.dark ? ([["desktop", true]] as ["desktop", boolean][]) : []),
    ];
    for (const [width, dark] of variants) {
      const page = await openAs(browser, stop.who, width, dark);
      const path = stop.path;
      let problem = "";
      try {
        await page.goto(path);
        await page.waitForTimeout(1500);
        // Loading placeholders and "Reading …" lines gone, or fifteen seconds: a screen is judged as it reads once loaded.
        await page
          .waitForFunction(
            () =>
              !document.querySelector(".animate-pulse") &&
              !/(^|\n)Reading [^\n]*…/.test(document.body.innerText),
            null,
            {
              timeout: 15_000,
            },
          )
          .catch(() => undefined);
        // On a phone a community's rooms and panels sit behind the channel list.
        if (
          width === "phone" &&
          stop.name.startsWith("e") &&
          (await page.getByTestId("open-channel-list").isVisible())
        ) {
          await page.getByTestId("open-channel-list").click();
          await page.waitForTimeout(400);
        }
        if (stop.open) await stop.open(page);
      } catch (error) {
        problem =
          error instanceof Error ? error.message.split("\n")[0] : String(error);
      }
      await capture(page, stop, `${width}${dark ? "-dark" : ""}`, problem);
      await page.context().close();
    }
  });
}
