import AxeBuilder from "@axe-core/playwright";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

import { type Browser, type Page, expect, test } from "@playwright/test";
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
 * Nothing here fails on what the screens say. It fails when a stop does not reach the state it is named for (its
 * `open` step throws, or what it `shows` is not visible): the picture is still saved, with the reason in the index, but
 * a screenshot of some other screen must not pass for the stop. In the hosted (contributor-only) build, E2E_CONTRIBUTOR_
 * ONLY=1, a capture first checks that no sale can be reached, and stops about the sale path check that they are absent
 * or lead elsewhere instead of being photographed. `scripts/screen-audit-unique.mjs` then fails the run on two equal
 * pictures, unless one is a redirect or a stop declared `sameAs` the other.
 */

const FIXTURE = process.env.E2E_AUDIT_FIXTURE ?? "";
const SHOTS = process.env.E2E_SHOTS ?? "";
/**
 * Which stops to capture: names containing the text, or, with a leading `^`, starting with it; several, split by commas
 * (`ONLY=^j` is the weekly loop's stops, `ONLY=g01,g02` two others). Empty: every stop.
 */
const ONLY = (process.env.ONLY ?? "").split(",").filter(Boolean);
const wanted = (name: string) =>
  ONLY.length === 0 ||
  ONLY.some((part) =>
    part.startsWith("^") ? name.startsWith(part.slice(1)) : name.includes(part),
  );
/** The capture is of the hosted build (`VITE_CONTRIBUTOR_ONLY=1`): `web-screen-audit.sh` sets it for the mvp modes. */
const CONTRIBUTOR_ONLY = process.env.E2E_CONTRIBUTOR_ONLY === "1";

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
/** The people and projects of the weekly loop (`audit-world.spec.ts`, "the weekly loop's world"). */
interface LoopWorld {
  people: Record<"ines" | "hugo" | "tess" | "pia" | "ravi", Person>;
  /** Each project's page address, `/launchpad/<id>?author=<founder>`. */
  projects: Record<"ines" | "pia" | "ravi", string>;
  help: { photos: string; guide: string };
}
interface World {
  host: string;
  anvil: string;
  loop?: LoopWorld;
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
  | "dev"
  | "ines"
  | "hugo"
  | "tess"
  | "pia"
  | "ravi";

interface Stop {
  name: string;
  who: Who;
  path: string;
  /** What to press after the page loads, to reach the state the stop is about. `width` is the one being captured. */
  open?: (page: Page, at: { width: "desktop" | "phone" }) => Promise<void>;
  /** Also captured in the dark theme. */
  dark?: boolean;
  /** A selector that must be visible once `open` is done, or the stop fails: the state the stop is about was reached. */
  shows?: string;
  /** A test id photographed on its own (with its words) instead of the whole page, for a form inside a long page. */
  subject?: string;
  /** Another stop this one is meant to look exactly like (a tab the page shows as another), so equal pictures pass. */
  sameAs?: string;
  /**
   * In the hosted (contributor-only) build: the state must not be reachable (`absent` checks that, and nothing is
   * captured), or the page must send you elsewhere (`redirect`, checked, and nothing is captured), or it is reached
   * another way (`open`, `shows`, `sameAs` replace the stop's own).
   */
  hosted?: {
    absent?: (page: Page) => Promise<void>;
    redirect?: RegExp;
    open?: (page: Page, at: { width: "desktop" | "phone" }) => Promise<void>;
    shows?: string;
    sameAs?: string;
  };
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
const tid = (testId: string) => `[data-testid="${testId}"]`;
/** Press the one visible copy of a control: a header and a phone tab bar can both carry the same test id. */
const clickVisible = (testId: string) => async (page: Page) => {
  await page.locator(`[data-testid="${testId}"]:visible`).first().click();
};
// Sign-up lives in the header on a wide screen; a phone's bar has only Sign in, so there it is the button under Home's
// "Create your account to follow the ones you care about."
const openSignUp = async (page: Page) => {
  const header = page.locator('[data-testid="create-identity-cta"]:visible');
  if ((await header.count()) > 0) await header.first().click();
  else await page.getByTestId("record-feed-create-account").click();
};
// The kinds are cards on a wide screen and one list on a phone (DecisionComposer.tsx).
const pickKind = (kind: string) => async (page: Page) => {
  const select = page.getByTestId("decision-kind-select");
  if (await select.isVisible()) await select.selectOption(kind);
  else await page.getByTestId(`decision-kind-${kind}`).click();
};
const decision = (kind: string) =>
  steps(tab("Decisions"), click("decision-new"), pickKind(kind));
/** In the hosted build there is no sale to set up: the button that would open the wizard is not there. */
const noSaleWizard = async (page: Page) => {
  await expect(page.getByRole("button", { name: "Set up a sale" })).toHaveCount(
    0,
  );
  await expect(page.getByTestId("wizard-step-token")).toHaveCount(0);
};

// ── The weekly loop: Start, a project's first week and its weekly update, Work, Home, Discover and the public scorecard.
// The people and projects are the loop world's (`audit-world.spec.ts`); a stop that makes something (a project, an update,
// a confirmed task) is last, so what it adds is not on the screens before it.
const L = world?.loop;
const loopProject = (who: "ines" | "pia" | "ravi") =>
  L ? L.projects[who] : "/";
/** The project's public scorecard address: its id and the first sixteen letters of its founder's key. */
const scorecardPath = (who: "ines" | "pia" | "ravi") => {
  if (!L) return "/";
  const [path, query] = L.projects[who].split("?");
  const id = path.split("/").pop();
  const author = new URLSearchParams(query).get("author") ?? "";
  return `/p/${id}-${author.slice(0, 16)}`;
};
/** A second, invite-only server (`web-screen-audit.sh`): only members read or post. */
const INVITE_SERVER = process.env.E2E_INVITE_SERVER ?? "";
const taskIn = (page: Page, helper: string, text: string) =>
  page
    .getByTestId("project-tasks")
    .getByTestId("task")
    .filter({ hasText: helper })
    .filter({ hasText: text });
/** Fill Start's three answers and press the button, as a person new to Creaton would. */
const quickStartAnswers =
  (input: { name: string; goal: string; how: string; category?: string }) =>
  async (page: Page) => {
    const form = page.getByTestId("quick-start");
    await form.getByLabel("Project name").fill(input.name);
    await form.getByLabel("The goal").fill(input.goal);
    await form.getByLabel("How we'll know").fill(input.how);
    if (input.category)
      await form
        .getByTestId(
          `quick-category-${input.category.toLowerCase().replace(/\W+/g, "-")}`,
        )
        .click();
  };
const pressStart = async (page: Page) => {
  await page
    .getByTestId("quick-start")
    .getByRole("button", { name: "Start the project" })
    .click();
};

const LOOP_STOPS: Stop[] = L
  ? [
      // ── Signed out ─────────────────────────────────────────────────────────────────────────────────
      ...(INVITE_SERVER
        ? [
            {
              name: "j01-project-link-invite-only",
              who: "visitor",
              path: `${INVITE_SERVER}${scorecardPath("ines")}`,
              shows: "main",
            } satisfies Stop,
          ]
        : []),
      {
        name: "j02-scorecard-visitor",
        who: "visitor",
        path: scorecardPath("ines"),
        shows: tid("scorecard"),
        dark: true,
      },
      {
        name: "j03-scorecard-new-project",
        who: "visitor",
        path: scorecardPath("pia"),
        shows: tid("scorecard"),
      },
      { name: "j04-work-visitor", who: "visitor", path: "/work" },
      {
        name: "j05-work-agents-filter",
        who: "visitor",
        path: "/work",
        open: click("work-agents-only"),
      },
      // Discover opens on Most reliable, so this is the same picture as the visitor's first look (a15).
      {
        name: "j06-discover-reliable",
        who: "visitor",
        path: "/discover",
        sameAs: "a15-discover-visitor",
      },
      {
        name: "j07-discover-ai-chip",
        who: "visitor",
        path: "/discover",
        open: click("category-ai-agent-or-tool"),
      },
      {
        name: "j08-discover-help-tab",
        who: "visitor",
        path: "/discover",
        open: click("project-board-tab-help"),
      },
      // ── A new account on Start, before it presses anything ─────────────────────────────────────────────
      { name: "j10-start-new-account", who: "newbie", path: "/start" },
      {
        name: "j11-start-ai-chip",
        who: "newbie",
        path: "/start",
        open: click("quick-category-ai-agent-or-tool"),
        shows: tid("quick-ai"),
      },
      {
        name: "j12-start-answers-filled",
        who: "newbie",
        path: "/start",
        open: quickStartAnswers({
          name: "Bread Club",
          goal: "Twelve neighbours bake with a shared sourdough starter",
          how: "Each of the twelve posts a photo of a loaf by the end of June",
        }),
      },
      // ── Home: what a quiet server shows ────────────────────────────────────────────────────────────────
      { name: "j20-home-helper", who: "hugo", path: "/", dark: true },
      { name: "j21-home-new-account", who: "newbie", path: "/" },
      {
        name: "j22-home-updates-tab",
        who: "hugo",
        path: "/?tab=updates",
      },
      // ── A founder: the record, the update dialog, Your projects ────────────────────────────────────────
      {
        name: "j30-project-founder-record",
        who: "ines",
        path: loopProject("ines"),
        dark: true,
      },
      {
        name: "j31-update-dialog",
        who: "ines",
        path: loopProject("ines"),
        open: roleButton("Post this week's update"),
        shows: '[role="dialog"]',
      },
      {
        name: "j32-update-draft-from-record",
        who: "ines",
        path: loopProject("ines"),
        open: steps(
          roleButton("Post this week's update"),
          click("update-draft-button"),
        ),
        shows: tid("update-draft"),
        subject: "update-draft",
      },
      { name: "j33-portfolio-founder", who: "ines", path: "/portfolio" },
      {
        name: "j34-project-fresh-from-start",
        who: "pia",
        path: `${loopProject("pia")}&started=1`,
        shows: tid("started-card"),
        dark: true,
      },
      {
        name: "j35-project-new-set-up-more",
        who: "pia",
        path: `${loopProject("pia")}&started=1`,
        open: click("set-up-more"),
      },
      {
        name: "j36-project-as-visitor",
        who: "visitor",
        path: loopProject("ines"),
      },
      // ── A helper: Work, a task with its finish line, a hand-in with numbers, accepted work ─────────────
      { name: "j40-work-helper", who: "hugo", path: "/work", dark: true },
      {
        name: "j41-project-tasks-helper",
        who: "hugo",
        path: loopProject("ines"),
        shows: tid("project-tasks"),
        subject: "project-tasks",
      },
      {
        name: "j42-hand-in-with-numbers",
        who: "hugo",
        path: loopProject("ines"),
        open: async (page) => {
          const row = taskIn(page, "Hugo Lang", L.help.guide);
          await row.getByRole("button", { name: "Hand in work" }).click();
          const form = row.getByRole("form", { name: "Hand in work" });
          await form
            .getByLabel("What you did")
            .fill(
              "Read the guide twice and marked every line that needs a picture.",
            );
          await form.getByTestId("hand-in-add-result").click();
          await form.getByTestId("hand-in-result-name").fill("lines marked");
          await form.getByTestId("hand-in-result-value").fill("14");
          await form.getByTestId("hand-in-result-unit").fill("lines");
        },
        shows: tid("hand-in-result"),
        subject: "project-tasks",
      },
      {
        name: "j43-accepted-work-on-record",
        who: "hugo",
        path: loopProject("ines"),
        shows: tid("record-work-accepted"),
        subject: "project-record",
      },
      {
        name: "j44-helper-profile-record",
        who: "visitor",
        path: `/u/${L.people.hugo.pubkey}`,
        open: tab("Record"),
        shows: tid("track-record"),
      },
      // ── Makes things: each one adds a record, so they are last ─────────────────────────────────────────
      {
        name: "j50-start-pressed",
        who: "newbie",
        path: "/start",
        open: steps(
          quickStartAnswers({
            name: "Bread Club",
            goal: "Twelve neighbours bake with a shared sourdough starter",
            how: "Each of the twelve posts a photo of a loaf by the end of June",
          }),
          pressStart,
        ),
        shows: tid("started-card"),
      },
      {
        name: "j51-update-posted",
        who: "ravi",
        path: loopProject("ravi"),
        open: async (page) => {
          await page
            .getByRole("button", { name: "Post this week's update" })
            .first()
            .click();
          const dialog = page.getByRole("dialog", {
            name: "Post this week's update",
          });
          await dialog.getByLabel("Title").fill("Week one");
          await dialog
            .getByLabel("What happened this week")
            .fill(
              "The helper now drafts replies to the ten most common emails.",
            );
          await dialog
            .getByLabel("What's next")
            .fill(
              "- Draft replies for the next ten\n- Ask the team to rate every draft",
            );
          await dialog.getByRole("button", { name: "Publish update" }).click();
        },
        shows: tid("update-posted"),
      },
      {
        name: "j52-accepted-share",
        who: "ines",
        path: loopProject("ines"),
        // Two checks are waiting; each width confirms its own, so each photograph sees the share picture of a piece of
        // work accepted a moment ago.
        open: async (page, { width }) => {
          const row = taskIn(
            page,
            "Tess Brandt",
            width === "desktop" ? L.help.guide : L.help.photos,
          );
          await row.getByRole("button", { name: "Confirm it's done" }).click();
          await row
            .getByTestId("task-confirm-box")
            .getByRole("button", { name: "Yes, confirm" })
            .click();
        },
        shows: tid("task-share"),
      },
    ]
  : [];

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
    open: openSignUp,
    shows: tid("onboarding-dialog"),
  },
  {
    name: "b02-signup-name",
    who: "visitor",
    path: "/",
    open: steps(openSignUp, async (page) => {
      await page.getByTestId("onboarding-name").fill("Sam");
    }),
    shows: tid("onboarding-dialog"),
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
    open: clickVisible("sign-in-cta"),
    shows: tid("onboarding-signin-form"),
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
    // The hosted build starts projects on Start, so the community's own "Set up community" is not offered.
    hosted: {
      absent: async (page) => {
        await expect(page.getByTestId("start-project-toggle")).toHaveCount(0);
      },
    },
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
    shows: tid("work-claim-evidence"),
    subject: "work-file-claim",
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
    shows: tid("work-claim-evidence"),
    subject: "work-file-claim",
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
  // A contributor project's record is its contributions, so this tab opens Contributions.
  {
    name: "g08-project-record",
    who: "nia",
    path: project("record"),
    sameAs: "g07-project-contributions",
  },
  { name: "g09-project-treasury", who: "nia", path: project("treasury") },
  // A contributor project shows its people on the overview, so this tab opens the overview.
  {
    name: "g10-project-people",
    who: "nia",
    path: project("agents"),
    sameAs: "g01-project-overview-member",
  },
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
    open: roleButton("Post this week's update"),
  },
  {
    name: "g18-new-decision",
    who: "frida",
    path: project("decisions"),
    open: click("decision-new"),
    shows: '[data-testid="decision-new"][aria-expanded="true"]',
    subject: "decision-composer",
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
        shows: '[data-testid="decision-new"][aria-expanded="true"]',
        subject: "decision-composer",
        // The composer opens on the work budget, so choosing it again is the same picture as opening it.
        ...(kind === "budget" ? { sameAs: "g18-new-decision" } : {}),
      }),
      // A contributor project offers no money decisions (D108).
    )
    .filter((stop) => !/-(pay|unwind|slash)$/.test(stop.name))
    // The hosted build offers no trading decision, and its Funds tab no Trading card: Shares are never put up for sale there.
    .filter((stop) => !(CONTRIBUTOR_ONLY && stop.name.endsWith("-trading"))),
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
    // Pitches with seats are not offered in the hosted build: new Shares come only from reviewed work.
    hosted: {
      absent: async (page) => {
        await expect(
          page.getByRole("button", { name: /pitch a project/i }),
        ).toHaveCount(0);
      },
    },
  },
  {
    name: "h04-launchpad",
    who: "nia",
    path: "/launchpad",
    // The hosted build lists its projects on Discover alone, so this second list (named for sales) leads there.
    hosted: { redirect: /\/discover$/ },
  },
  {
    name: "h05-launch-detail",
    who: "nia",
    path: "/launchpad",
    open: async (page) => {
      await page.getByText("Nebula").first().click();
    },
    // The hosted world has no sale to open; the list's way into a project is the Creaton project itself.
    hosted: {
      open: async (page) => {
        await page
          .locator("main")
          .locator('a[href*="/launchpad/"]')
          .filter({ hasText: "Creaton" })
          .first()
          .click();
      },
      shows: '[role="tab"]',
      sameAs: "g01-project-overview-member",
    },
  },
  {
    name: "h06-sale-wizard",
    who: "frida",
    path: "/launchpad",
    open: roleButton("Set up a sale"),
    hosted: { absent: noSaleWizard },
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
    hosted: { absent: noSaleWizard },
  },
  { name: "h08-idea-dialog", who: "frida", path: "/launchpad?start=idea" },
  {
    name: "h09-sandbox",
    who: "nia",
    path: "/launchpad/nebula-sandbox",
    hosted: { redirect: /\/(launchpad|discover)$/ },
  },
  // ── The rest a person can reach ────────────────────────────────────────────────────────────────────
  { name: "i01-repos", who: "nia", path: "/repos" },
  { name: "i02-wiki", who: "dev", path: community("?view=wiki") },
  { name: "i03-ai-helpers", who: "dev", path: community("?view=fleet") },
  { name: "i04-work-board", who: "dev", path: community("?view=work") },
  { name: "i05-link-device", who: "nia", path: "/link-device" },
  { name: "i06-identity-demo", who: "visitor", path: "/identity-demo" },
  ...LOOP_STOPS,
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
  if (
    who === "ines" ||
    who === "hugo" ||
    who === "tess" ||
    who === "pia" ||
    who === "ravi"
  )
    return W.loop?.people[who] ?? null;
  return W.cast[who];
}

/** The version of the terms the server serves now, read once: signed-in people in the world have agreed to it. */
let servedTerms: Promise<string> | null = null;
const servedTermsVersion = () =>
  (servedTerms ??= fetch(`http://${W.host}/api/join-policy`)
    .then((r) => r.json() as Promise<{ policy?: { version?: string } }>)
    .then((body) => body.policy?.version ?? "")
    .catch(() => ""));

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
  const terms = person ? await servedTermsVersion() : "";
  await page.addInitScript(
    ([key, rpcUrl, newbie, version]) => {
      if (key && !window.localStorage.getItem("buzz.identity.nsec")) {
        window.localStorage.setItem("buzz.identity.nsec", key);
      }
      if (key && !newbie)
        window.localStorage.setItem("buzz.identity.backedUp", "1");
      window.localStorage.setItem("buzz.launchpad.rpc", rpcUrl);
      // Someone who signed up agreed to the terms then; a browser made here from a bare key says so for them.
      if (key && version)
        window.localStorage.setItem(
          "creaton.joinPolicy.accepted",
          JSON.stringify({ version, at: Date.now() }),
        );
    },
    [person?.key ?? "", world?.anvil ?? "", who === "newbie", terms] as const,
  );
  return page;
}

/** Whether the page ended somewhere other than the address the stop opened (a route that sends you elsewhere). */
function redirected(page: Page, path: string): boolean {
  const asked = new URL(path, page.url());
  return new URL(page.url()).pathname !== asked.pathname;
}

/** One line in the index for a stop that is checked instead of captured (hosted absences and redirects). */
function recordChecked(
  stop: Stop,
  variant: string,
  url: string,
  check: string,
) {
  appendFileSync(
    `${SHOTS}/index.ndjson`,
    `${JSON.stringify({ stop: stop.name, variant, who: stop.who, path: stop.path, url, checked: check })}\n`,
  );
}

/** The tallest picture a stop saves, in pixels: a longer page is cut there (its words are still all saved). */
const MAX_PICTURE_HEIGHT = 5000;

async function capture(
  page: Page,
  stop: Stop,
  variant: string,
  problem: string,
  sameAs: string | undefined,
) {
  await page.waitForTimeout(1500);
  await waitForAnimations(page).catch(() => undefined);
  const base = `${SHOTS}/${stop.name}-${variant}`;
  // The app scrolls inside its own panes, so a "full page" picture is only the window. The window is made as tall as
  // the longest pane (up to a limit) for the picture, so what is below the fold is photographed too.
  // An open dialog is photographed in the window it opens in: a taller window would only move it to the middle.
  const original = page.viewportSize();
  const extra = await page.evaluate(() => {
    if (document.querySelector('[role="dialog"]')) return 0;
    let longest = 0;
    for (const el of document.querySelectorAll<HTMLElement>("*")) {
      const overflow = getComputedStyle(el).overflowY;
      if (overflow !== "auto" && overflow !== "scroll") continue;
      longest = Math.max(longest, el.scrollHeight - el.clientHeight);
    }
    return longest;
  });
  if (original && extra > 40) {
    await page.setViewportSize({
      width: original.width,
      height: Math.min(original.height + extra, MAX_PICTURE_HEIGHT),
    });
    await page.waitForTimeout(500);
  }
  // A form inside a long page is photographed on its own, so the picture is of the form, not of the page above it.
  const subject =
    stop.subject && !problem
      ? page.locator(`[data-testid="${stop.subject}"]:visible`).first()
      : null;
  if (subject && (await subject.count()) > 0) {
    await subject.screenshot({ path: `${base}.png` });
  } else {
    await page.screenshot({ path: `${base}.png`, fullPage: true });
  }
  if (original) await page.setViewportSize(original);
  const text =
    subject && (await subject.count()) > 0
      ? await subject.innerText()
      : await page.evaluate(() => document.body.innerText);
  writeFileSync(`${base}.txt`, text);
  // A scan that could not run is said in the index: no findings must mean none were found, not that none were looked for.
  let axeFailed = "";
  const axe = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze()
    .catch((error: unknown) => {
      axeFailed =
        error instanceof Error ? error.message.split("\n")[0] : "failed";
      return null;
    });
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
      // Read by scripts/screen-audit-unique.mjs: equal pictures pass only for a redirect or a declared look-alike.
      redirected: redirected(page, stop.path),
      ...(sameAs ? { sameAs } : {}),
      words: text.split(/\s+/).filter(Boolean).length,
      accessibility: blocking,
      ...(axeFailed ? { accessibilityScanFailed: axeFailed } : {}),
      sideways,
      problem,
    })}\n`,
  );
}

// The hosted build offers no sale anywhere: Start has no raise steps, the sale wizard does not open (its button is not
// there, and the `?start=sale` address leads to Discover), Discover offers no backing, and the raise sandbox leads
// elsewhere.
test("the contributor-only build shows no sale", async ({ browser }) => {
  test.skip(!CONTRIBUTOR_ONLY, "only for a capture of the hosted build");
  const page = await openAs(browser, "frida", "desktop", false);
  try {
    await page.goto("/start");
    await page.getByText("More ways to start").click();
    await expect(page.getByTestId("start-go-contributor")).toBeVisible();
    await expect(page.getByTestId("start-step-raise")).toHaveCount(0);
    await expect(page.getByTestId("start-step-run")).toHaveCount(0);
    await expect(page.locator("main")).not.toContainText(
      /plan a raise|set up a sale|pretend money|would back/i,
    );

    await page.goto("/launchpad?start=sale");
    // The list of sales leads to Discover in this build (only `?start=idea` stays here, to share an idea), so the
    // address never opens the sale wizard.
    await expect(page).toHaveURL(/\/discover$/);
    await expect(page.getByTestId("discover-start-project")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Set up a sale" }),
    ).toHaveCount(0);
    await expect(page.getByTestId("wizard-step-token")).toHaveCount(0);
    await expect(page.getByTestId("sandbox-entry")).toHaveCount(0);
    await expect(page.getByTestId("launch-chips")).toHaveCount(0);

    await page.goto("/discover");
    await expect(page.getByTestId("discover-start-project")).toBeVisible();
    await expect(page.getByTestId("discover-filter-hiring")).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: /back this launch/i }),
    ).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Markets" })).toHaveCount(0);

    // The names the hosted build gives the way back to the list and a project's card in it: the list is "Projects" in the
    // top bar, so the back link is not "Launchpad" and a card is not "View launch" (those are the sale's words).
    if (W.loop) {
      await page.goto(W.loop.projects.ines);
      const back = page.locator('[data-testid="launch-hero"] a').first();
      await expect(back).toHaveText("Projects");
      await expect(back).toHaveAttribute("href", "/discover");
      await page.goto("/discover");
      await expect(page.getByTestId("discover-launch").first()).toBeVisible();
      await expect(
        page.getByRole("link", { name: /view launch/i }),
      ).toHaveCount(0);
      await expect(
        page
          .getByTestId("discover-launch")
          .getByRole("link", { name: "Open project" })
          .first(),
      ).toBeVisible();
    }

    await page.goto("/launchpad/nebula-sandbox");
    // The list of ideas may itself move under Discover in this build; either way the sandbox is not offered.
    await expect(page).toHaveURL(/\/(launchpad|discover)$/);
  } finally {
    await page.context().close();
  }
});

for (const stop of STOPS) {
  if (!wanted(stop.name)) continue;
  test(stop.name, async ({ browser }) => {
    test.setTimeout(120_000);
    const hosted = CONTRIBUTOR_ONLY ? stop.hosted : undefined;
    const open = hosted?.open ?? stop.open;
    const shows = hosted?.shows ?? stop.shows;
    const sameAs = hosted?.sameAs ?? stop.sameAs;
    const variants: ["desktop" | "phone", boolean][] = [
      ["desktop", false],
      ["phone", false],
      ...(stop.dark ? ([["desktop", true]] as ["desktop", boolean][]) : []),
    ];
    // Every width is captured before the stop fails, so one bad step still leaves the other pictures to read.
    const problems: string[] = [];
    for (const [width, dark] of variants) {
      const variant = `${width}${dark ? "-dark" : ""}`;
      const page = await openAs(browser, stop.who, width, dark);
      const path = stop.path;
      let problem = "";
      let checked = false;
      try {
        await page.goto(path);
        await page.waitForTimeout(1500);
        // Loading placeholders and "Reading …" or "Loading …" lines gone, or fifteen seconds: a screen is judged as it
        // reads once loaded.
        await page
          .waitForFunction(
            () =>
              !document.querySelector(".animate-pulse") &&
              !/(^|\n)(Reading|Loading|Looking for)\b[^\n]*(…|\.\.\.)/.test(
                document.body.innerText,
              ),
            null,
            {
              timeout: 15_000,
            },
          )
          .catch(() => undefined);
        // In the hosted build some stops are checked, not photographed: they must not exist, or must lead elsewhere.
        if (hosted?.redirect) {
          await expect(page).toHaveURL(hosted.redirect);
          recordChecked(stop, variant, page.url(), "redirect");
          checked = true;
        } else if (hosted?.absent) {
          await hosted.absent(page);
          recordChecked(stop, variant, page.url(), "absent");
          checked = true;
        } else {
          // On a phone a community's rooms and panels sit behind the channel list.
          if (
            width === "phone" &&
            stop.name.startsWith("e") &&
            (await page.getByTestId("open-channel-list").isVisible())
          ) {
            await page.getByTestId("open-channel-list").click();
            await page.waitForTimeout(400);
          }
          if (open) await open(page, { width });
          if (shows) {
            await expect(
              page.locator(`${shows}:visible`).first(),
            ).toBeVisible();
          }
        }
      } catch (error) {
        problem =
          error instanceof Error ? error.message.split("\n")[0] : String(error);
      }
      // A failed check is still photographed, so whoever reads the run sees what was there instead.
      if (!checked) await capture(page, stop, variant, problem, sameAs);
      if (problem) problems.push(`${variant}: ${problem}`);
      await page.context().close();
    }
    // A stop whose state could not be reached fails: its picture would show some other screen and pass for this one.
    expect(problems, `${stop.name} did not reach its state`).toEqual([]);
  });
}
