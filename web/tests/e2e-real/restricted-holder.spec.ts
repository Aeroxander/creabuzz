import { execFileSync } from "node:child_process";

import { expect, type Browser, type Page, test } from "@playwright/test";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";

import { installAnvilWallet } from "../helpers/anvil-wallet";
import { PORT, createCommunity, unique } from "./community-helpers";
import { keyFromNsec, publishAs } from "./publish.mjs";

/**
 * A holder whose social access is restricted keeps every right their Shares give them (docs/v3-review/
 * HOLDER-ACCESS-MODEL.md), on a REAL server and a REAL chain: `scripts/web-restricted-holder-e2e.sh` boots both, with a
 * DAO the holder has Shares in, a finished piece of work up for an award, and a second award decision opened from the
 * command line.
 *
 * Muted everywhere, the holder still opens the project, reads the evidence of work and votes in the page; only a post is
 * refused, and the refusal says they are muted. Banned, the community turns them away and the server refuses their
 * writes; the documented fallback still works: the command line, given the banned person's own key and the server's
 * address, reads the claim and votes, and `buzz org ragequit` takes half their Shares out of the DAO with their part
 * of the treasury.
 */

const ANVIL_URL = process.env.E2E_ANVIL_URL ?? "";
const DAO = process.env.E2E_DAO ?? "";
const MANDATE = process.env.E2E_MANDATE ?? "";
const SHARES = process.env.E2E_SHARES ?? "";
const CURRENCY = process.env.E2E_CURRENCY ?? "";
const FOUNDER = process.env.E2E_FOUNDER ?? "";
const CONTRIBUTOR = process.env.E2E_CONTRIBUTOR ?? "";
const HOLDER = process.env.E2E_HOLDER ?? "";
const HOLDER_KEY = process.env.E2E_HOLDER_KEY ?? "";
const BUZZ = process.env.E2E_BUZZ ?? "";
const CLI_DECISION = process.env.E2E_CLI_DECISION ?? "";

test.skip(
  !ANVIL_URL || !DAO || !MANDATE || !HOLDER_KEY || !BUZZ || !CLI_DECISION,
  "run by scripts/web-restricted-holder-e2e.sh, which boots the server and the chain and sets E2E_*",
);

test.use({ viewport: { width: 1280, height: 900 } });

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const newNsec = () => hex(generateSecretKey());
const pubkeyOf = (nsec: string) => getPublicKey(keyFromNsec(nsec));
const word = (address: string) =>
  address.slice(2).toLowerCase().padStart(64, "0");

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
const balanceOf = async (token: string, holder: string) =>
  BigInt(
    String(
      await rpc("eth_call", [
        { to: token, data: `0x70a08231${word(holder)}` },
        "latest",
      ]),
    ),
  );

/** A person in a browser of their own: a Nostr key of their own, and a wallet that is one of Anvil's accounts. */
async function person(
  browser: Browser,
  nsec: string,
  wallet: string,
): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  context.setDefaultTimeout(60_000);
  const page = await context.newPage();
  await installAnvilWallet(page, wallet, { rpcUrl: ANVIL_URL });
  await page.addInitScript(
    ([key, rpcUrl]) => {
      if (!window.localStorage.getItem("buzz.identity.nsec")) {
        window.localStorage.setItem("buzz.identity.nsec", key);
      }
      window.localStorage.setItem("buzz.identity.backedUp", "1");
      window.localStorage.setItem("buzz.launchpad.rpc", rpcUrl);
    },
    [nsec, ANVIL_URL],
  );
  return page;
}

/** A moderation command (or any event) the server must accept, as `nsec`, at the community's own address. */
async function publishAccepted(
  nsec: string,
  host: string,
  template: { kind: number; tags: string[][]; content: string },
) {
  const result = (await publishAs(
    nsec,
    { created_at: Math.floor(Date.now() / 1000), ...template },
    `ws://${host}`,
  )) as { accepted: boolean; reason: string };
  expect(
    result.accepted,
    `kind ${template.kind} was refused: ${result.reason}`,
  ).toBe(true);
}

/** The command line as the holder: their wallet's key, their own (banned) Nostr key and this server's address. */
function holderCli(host: string, nsec: string, args: string[]): unknown {
  return JSON.parse(holderCliRaw(host, nsec, args));
}

/**
 * The same, for a command that prints one JSON document per line: `org ragequit` prints its result, then the holder's
 * member view (the desktop app reads both lines).
 */
function holderCliLines(host: string, nsec: string, args: string[]): unknown[] {
  return holderCliRaw(host, nsec, args)
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

function holderCliRaw(host: string, nsec: string, args: string[]): string {
  return execFileSync(BUZZ, args, {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      BUZZ_EVM_RPC_URL: ANVIL_URL,
      BUZZ_SPENDER_KEY: HOLDER_KEY,
      BUZZ_RELAY_URL: `ws://${host}`,
      BUZZ_PRIVATE_KEY: nsec,
    },
  });
}

test("a muted holder still reads the evidence and votes; a banned holder still reads, votes and leaves from the command line", async ({
  browser,
}) => {
  test.setTimeout(600_000);
  const name = unique();
  const host = `${name}.localhost:${PORT}`;
  const ownerNsec = newNsec();
  const owner = pubkeyOf(ownerNsec);
  const holderNsec = newNsec();
  const holderPubkey = pubkeyOf(holderNsec);
  const slug = `restricted-${name}`;
  const projectUrl = (tab: string) =>
    `http://${host}/launchpad/${slug}?author=${owner}&tab=${tab}`;

  await test.step("the founder makes a community and publishes the project in it", async () => {
    const founder = await person(browser, ownerNsec, FOUNDER);
    await createCommunity(founder, name);
    // A contributor project's record, as the Start page publishes one: no sale, Shares earned by work.
    await publishAccepted(ownerNsec, host, {
      kind: 37001,
      tags: [
        ["d", slug],
        ["name", "Docs Commons"],
        ["t", "dao-launchpad"],
        ["admission", "community"],
        ["chain", "31337"],
        ["token", SHARES],
        ["treasury", DAO],
      ],
      content: JSON.stringify({
        pitch: "Open docs, written by the people who use them.",
        stage: "graduated",
        funding: {
          stance: "not-raising",
          seeking: ["contributors"],
          path: "contributors",
        },
        tokenPlan: {
          mode: "dao",
          name: "Docs Commons",
          symbol: "DOCS",
          supply: "100000",
        },
      }),
    });
  });

  const evidence = `https://example.com/pr/${name}`;
  await test.step("a contributor submits a second piece of work from the page, so its evidence is on the server", async () => {
    const contributor = await person(browser, newNsec(), CONTRIBUTOR);
    await contributor.goto(projectUrl("work"));
    await contributor.getByTestId("work-file-open").click({ timeout: 60_000 });
    await contributor.getByTestId("work-claim-name").fill("fix-typos");
    await contributor.getByTestId("work-claim-evidence").fill(evidence);
    await contributor
      .getByTestId("work-claim-met")
      .fill("Checked it against the work area's words");
    await contributor
      .getByTestId("work-claim-check")
      .fill("docs merged and reviewed");
    await contributor.getByTestId("work-claim-submit").click();
    await expect(contributor.getByTestId("work-claim-filed")).toBeVisible({
      timeout: 120_000,
    });
  });

  const holder = await person(browser, holderNsec, HOLDER);

  await test.step("muted everywhere, the holder reads the project and the evidence and votes; a post is refused", async () => {
    await publishAccepted(ownerNsec, host, {
      kind: 9042,
      tags: [
        ["p", holderPubkey],
        ["expiration", String(Math.floor(Date.now() / 1000) + 3600)],
        ["reason", "Cooling off"],
      ],
      content: "",
    });
    await holder.goto(projectUrl("work"));
    await expect(
      holder
        .getByTestId("work-evidence-text")
        .filter({ hasText: evidence })
        .first(),
    ).toBeVisible({ timeout: 60_000 });

    await holder.getByRole("tab", { name: "Decisions" }).click();
    const award = holder.getByTestId("decision-card").filter({
      has: holder
        .getByTestId("decision-title")
        .filter({ hasText: "Award 20 Shares" }),
    });
    await award.getByTestId("decision-vote-for").click({ timeout: 60_000 });
    await expect(award.getByTestId("decision-support")).toContainText(
      /Backing [1-9]/,
      { timeout: 120_000 },
    );

    await holder.goto(`http://${host}/social`);
    await holder
      .getByTestId("social-composer-input")
      .fill(`Still here ${name}`);
    await holder.getByTestId("social-composer-submit").click();
    await expect(holder.getByTestId("social-composer-problem")).toContainText(
      "You are muted everywhere in this community",
      { timeout: 30_000 },
    );
  });

  await test.step("banned, the community turns them away and the server refuses their writes", async () => {
    await publishAccepted(ownerNsec, host, {
      kind: 9040,
      tags: [
        ["p", holderPubkey],
        ["reason", "Threats in chat"],
      ],
      content: "",
    });
    await holder.goto(`http://${host}/c/${host}`);
    await expect(holder.getByTestId("community-banned")).toBeVisible({
      timeout: 60_000,
    });
    const refused = await publishAs(
      holderNsec,
      {
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        content: "banned and posting",
      },
      `ws://${host}`,
    ).then(
      (result) => result as { accepted: boolean; reason: string },
      (error: unknown) => ({ accepted: false, reason: String(error) }),
    );
    expect(refused.accepted).toBe(false);
  });

  await test.step("the fallback: the command line reads the claim, votes, and takes them out of the DAO", async () => {
    const state = holderCli(host, holderNsec, [
      "launchpad",
      "work",
      "state",
      "--mandate",
      MANDATE,
      "--id",
      "write-docs",
    ]) as { status?: string };
    expect(state.status).toBe("Paid");

    // The decision's tally: the Shares backing it (the first of for, against, neutral).
    const backing = () =>
      BigInt(
        execFileSync(
          "cast",
          [
            "call",
            DAO,
            "tallies(uint256)(uint96,uint96,uint96)",
            CLI_DECISION,
            "--rpc-url",
            ANVIL_URL,
          ],
          { encoding: "utf8" },
        )
          .trim()
          .split(/\s+/)[0],
      );
    const backingBefore = backing();
    const holderShares = await balanceOf(SHARES, HOLDER);
    holderCli(host, holderNsec, [
      "launchpad",
      "vote",
      "--dao",
      DAO,
      "--id",
      CLI_DECISION,
      "--support",
      "for",
    ]);
    expect(backing(), "the banned holder's Shares back the decision").toBe(
      backingBefore + holderShares,
    );

    const sharesBefore = await balanceOf(SHARES, HOLDER);
    const usdcBefore = await balanceOf(CURRENCY, HOLDER);
    // Half of what they hold: they leave with part of it, and keep the rest.
    const leaving = sharesBefore / 2n;
    expect(leaving).toBeGreaterThan(0n);
    // The documented fallback (HOLDER-ACCESS-MODEL.md, step 5): `buzz org ragequit`, from the holder's own wallet key.
    const [left, after] = holderCliLines(host, holderNsec, [
      "org",
      "ragequit",
      "--dao",
      DAO,
      "--shares",
      leaving.toString(),
      "--token",
      CURRENCY,
    ]) as [
      { status?: string; burned?: { shares?: string } },
      { memberView?: { sharesRemaining?: string } },
    ];
    expect(left.status).toBe("ok");
    expect(left.burned?.shares).toBe(leaving.toString());
    expect(after.memberView?.sharesRemaining).toBe(
      (sharesBefore - leaving).toString(),
    );
    expect(await balanceOf(SHARES, HOLDER)).toBe(sharesBefore - leaving);
    expect(await balanceOf(CURRENCY, HOLDER)).toBeGreaterThan(usdcBefore);
    // Nothing above lifted the ban.
    await holder.goto(`http://${host}/c/${host}`);
    await expect(holder.getByTestId("community-banned")).toBeVisible({
      timeout: 60_000,
    });
  });
});
