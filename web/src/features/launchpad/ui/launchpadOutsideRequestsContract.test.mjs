import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Outside feedback, batch 3: the launchpad screens other groups' fixes needed. Each screen names the real instrument
 * (Shares for the milestone lock, whatever a funding round sells for rounds), says only what is true on the network the
 * build runs on, and describes what a person can do or check rather than how the contracts book it. The components are
 * the seam (node cannot render the .tsx), so the source is read with its comments taken out.
 */
const source = (name) =>
  readFileSync(new URL(name, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

test("the milestone lock screens call the locked asset Shares, and keep the bond token apart", () => {
  for (const file of [
    "./ChallengeMilestones.tsx",
    "./MilestoneProgressCard.tsx",
    "./LaunchReviewFields.tsx",
    "../lib/challenge-attention.ts",
  ]) {
    const text = source(file);
    for (const stale of [
      /tokens\s+still\s+locked/,
      /own\s+tokens\s+do\s+not\s+count/,
      /locked\s+tokens/,
      /issue\s+more\s+tokens/,
      /original\s+tokens/,
      /your\s+tokens/i,
      /team's\s+tokens/,
      /tokens\s+are\s+burned/,
    ]) {
      assert.doesNotMatch(text, stale, `${file} still says ${stale}`);
    }
  }
  const challenge = source("./ChallengeMilestones.tsx");
  assert.match(challenge, /issue\s+more\s+Shares\s+or\s+non-voting\s+shares/);
  assert.match(challenge, /of the bond token/);
  assert.match(challenge, /Shares still locked\./);
});

test("the launch review's late-objection line does not repeat the old refusal ending", () => {
  const fields = source("./LaunchReviewFields.tsx");
  assert.doesNotMatch(fields, /still\s+locked\s+stays\s+at\s+stake/);
  assert.match(
    fields,
    /late\s+objection\s+that\s+holders\s+agree\s+with\s+can\s+still\s+destroy\s+the\s+Shares/,
  );
});

test("'Open the submission on the Work tab' lands on that submission: the address feeds the Work tab's focus", () => {
  const page = source("./LaunchDetailPage.tsx");
  assert.match(page, /focusClaim=\{initialClaim\}/);
  assert.doesNotMatch(page, /onOpenWork=\{\(\) => setTab\("work"\)\}/);
  const route = readFileSync(
    new URL("../../../app/routes/launchpad.$launchId.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    route,
    /initialClaim=\{claim && mandate \? \{ id: claim, mandate \}/,
  );
});

test("the Work tab says above the suggestions when an open approval vote could not be read", () => {
  const work = source("./WorkTab.tsx");
  const note = work.indexOf(
    "<UnreadableVotesNote decisions={decisions.data?.decisions ?? []} />",
  );
  assert.ok(note > 0, "WorkTab renders UnreadableVotesNote");
  assert.ok(
    note < work.indexOf("<SuggestedWork"),
    "it sits above SuggestedWork",
  );
  const component = source("./UnreadableVotesNote.tsx");
  assert.match(component, /unreadableVoteNote\(decisions\)/);
  assert.match(component, /data-testid="suggested-unreadable-votes"/);
  assert.match(component, /role="status"/);
  assert.ok(
    work.split("\n").length <= 1000,
    "WorkTab.tsx stays within 1000 lines",
  );
});

test("a list of token addresses may be split by semicolons too", () => {
  const form = source("./FundingDecisionForm.tsx");
  assert.match(form, /tokensText\s*\.split\(\/\[\\s,;\]\+\/\)/);
});

test("a funding round names what it sells: new Shares or new non-voting shares", () => {
  const card = source("./WeeklyRoundsCard.tsx");
  assert.match(card, /const unit = roundUnit\(round, shares\)/);
  assert.match(card, /clearingLine\(round, unit\)/);
  assert.match(card, /`Bid for new \$\{unit\}`/);
  assert.match(card, /`new \$\{unit\}`/);
  assert.doesNotMatch(card, /"Bid for new shares"/);
  assert.doesNotMatch(card, /"new shares"/);
  // The floor chip on a funding round uses the same word as the price column.
  assert.match(card, /a \$\{unit\.replace\(\/s\$\/, ""\)\}`/);
  assert.doesNotMatch(card, /holders \? "Share" : "share"/);
});

test("the rounds journey expects the non-voting-share words its Loot round now shows", () => {
  const spec = readFileSync(
    new URL("../../../../tests/e2e/rounds-journey.spec.ts", import.meta.url),
    "utf8",
  );
  for (const line of [
    "You bid for 30 new non-voting shares at up to 1.8 USDC.",
    "If bidding ended now: 40 new non-voting shares at 1.65 USDC each.",
    "40 new non-voting shares at 1.65 USDC each were sold for the project.",
  ]) {
    assert.ok(spec.includes(line), line);
  }
  assert.doesNotMatch(spec, /\d+ new shares at /);
});

test("the passkey fee line is not hard-wired to the test network", () => {
  const strip = source("./AccountStrip.tsx");
  assert.doesNotMatch(strip, /covered on the test network/);
  assert.match(strip, /passkeyActingLine\(account\.chainId\)/);
  assert.match(strip, /feesCoveredOn\(passkeyChainId\(\)\)/);
  const lib = source("../lib/acting-account.ts");
  assert.doesNotMatch(lib, /covered on the test network\)/);
});

test("the founder and overview screens describe what to check, not the ledger", () => {
  for (const file of ["./ManagePanel.tsx", "./OverviewTab.tsx"]) {
    const text = source(file);
    assert.doesNotMatch(text, /(block)?chain\s+is\s+the\s+ledger/i, file);
    assert.doesNotMatch(text, /mirrors\s+the\s+claim/, file);
    assert.doesNotMatch(text, /through your RPC endpoint/, file);
    assert.doesNotMatch(text, /Claim mirror recorded/, file);
  }
  assert.match(source("./ManagePanel.tsx"), /the network is right/);
});

test("the graduation split shows the reserve as a percentage, not a contract field", () => {
  const panel = source("./TreasuryFlowsPanel.tsx");
  assert.doesNotMatch(panel, /\(reserveBps \{/);
  assert.doesNotMatch(panel, /\/10000\)/);
  assert.match(
    panel,
    /\{Number\(state\.reserveBps\) \/ 100\}% of\s+the\s+raise/,
  );
});
