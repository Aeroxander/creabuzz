/**
 * Every way of making or restoring an account must wait for the terms boxes (or record that none were agreed to).
 *
 * This reads the source: each call to a function that mints, restores or replaces an account key has to sit in a
 * file listed below, inside a handler that checks the terms gate first. A new call site in an unlisted file, or an
 * unguarded handler in a listed one, fails here until it is fixed or listed with the reason it is not a sign-up.
 * Run under `node --test`; no alias or browser is needed.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../../", import.meta.url));
const CREATORS = [
  "getOrCreateIdentity",
  "importIdentity",
  "createPasskeyIdentity",
  "signInWithWallet",
  "rotateIdentity",
];

/**
 * Sign-up and sign-in screens: each call sits in a handler with the named check. `first` means the check must come
 * before the call (a gate); otherwise it may come after (a record made once the key is changed).
 */
const GATED = {
  "features/identity/ui/OnboardingDialog.tsx": {
    calls: 4,
    guard: /if \(.*!allowed/,
    first: true,
    // The create view and the recovery-key sign-in view both show the boxes.
    boxes: 2,
  },
  "features/invite/ui/InvitePage.tsx": {
    calls: 2,
    guard: /if \(disabled\)/,
    first: true,
    boxes: 0,
  },
  // Restores or replaces a key this browser already holds but cannot read (the banner and the desktop link page): no
  // boxes here, so each records that none were agreed to and the app asks at once on the next load.
  "features/identity/ui/IdentityRecoveryBanner.tsx": {
    calls: 2,
    guard: /rememberNoAgreement\(/,
    boxes: 0,
  },
  "features/identity/ui/LinkDevicePage.tsx": {
    calls: 1,
    guard: /rememberNoAgreement\(/,
    boxes: 0,
  },
};

/** Calls that are not a sign-up, with why. A changed count in any of these fails until the new call is looked at. */
const NOT_SIGN_UP = {
  "features/identity/lib/passkey-identity.ts": {
    calls: 2,
    why: "called only from the gated screens above, and to unlock a passkey account this browser already holds",
  },
  "features/identity/ui/PaymentWalletCard.tsx": {
    calls: 1,
    why: "connects a payment wallet to the account already signed in",
  },
  "features/launchpad/lib/agent-launchpad.ts": {
    calls: 1,
    why: "binds an agent to the signed-in owner; a failure leaves the event unsigned by the owner",
  },
  "shared/lib/identity.ts": {
    calls: 3,
    why: "the key store itself: signing mints a key when none exists, so every screen that signs must first require an account (known gap, see LAWYER-FEEDBACK-RESPONSE.md follow-up 9)",
  },
};

function sourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) out.push(path);
  }
  return out;
}

/** Source without comments, so a name in prose is not taken for a call. Line numbers are kept. */
function code(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Each call to a creator: its name, and the handler it sits in (up to the call, and the whole of it). */
function callSites(text) {
  const src = code(text);
  const lines = src.split("\n");
  const sites = [];
  const call = new RegExp(`\\b(${CREATORS.join("|")})\\(`, "g");
  lines.forEach((line, index) => {
    for (const match of line.matchAll(call)) {
      if (/\bfunction\s+$/.test(line.slice(0, match.index))) continue;
      let start = index;
      while (
        start > 0 &&
        !/^\s*(export\s+)?(async\s+)?function\s+\w+|^\s*const\s+\w+\s*=\s*(async\s*)?(\(|function)/.test(
          lines[start],
        )
      )
        start -= 1;
      let end = index + 1;
      while (
        end < lines.length &&
        !/^\s*(export\s+)?(async\s+)?function\s+\w+|^\s*const\s+\w+\s*=\s*(async\s*)?(\(|function)/.test(
          lines[end],
        )
      )
        end += 1;
      sites.push({
        name: match[1],
        line: index + 1,
        before: lines.slice(start, index + 1).join("\n"),
        whole: lines.slice(start, end).join("\n"),
      });
    }
  });
  return sites;
}

const all = new Map(
  sourceFiles(SRC).map((path) => [
    relative(SRC, path).split("\\").join("/"),
    readFileSync(path, "utf8"),
  ]),
);

describe("every account-making path waits for the terms", () => {
  it("finds the account-making call sites (the scan itself works)", () => {
    const found = callSites(
      all.get("features/identity/ui/OnboardingDialog.tsx"),
    );
    assert.deepEqual(found.map((s) => s.name).sort(), [
      "createPasskeyIdentity",
      "getOrCreateIdentity",
      "importIdentity",
      "signInWithWallet",
    ]);
  });

  it("allows a call site only in a file listed here", () => {
    const listed = new Set([
      ...Object.keys(GATED),
      ...Object.keys(NOT_SIGN_UP),
    ]);
    const strays = [...all]
      .filter(([file, text]) => !listed.has(file) && callSites(text).length > 0)
      .map(
        ([file, text]) =>
          `${file}: ${callSites(text)
            .map((s) => `${s.name} line ${s.line}`)
            .join(", ")}`,
      );
    assert.deepEqual(
      strays,
      [],
      "A new way to make or restore an account needs the terms boxes (see OnboardingDialog), or an entry in NOT_SIGN_UP saying why it is not a sign-up.",
    );
  });

  for (const [file, rule] of Object.entries(GATED)) {
    it(`${file}: every call is inside a handler that checks the gate first`, () => {
      const text = all.get(file);
      assert.ok(text, `${file} exists`);
      const sites = callSites(text);
      assert.equal(sites.length, rule.calls, `${file} call sites changed`);
      for (const site of sites) {
        assert.match(
          rule.first ? site.before : site.whole,
          rule.guard,
          `${file} line ${site.line}: ${site.name} is reachable without the terms check ${rule.guard}`,
        );
      }
      assert.ok(
        (text.match(/<PolicyBoxes/g) ?? []).length >= rule.boxes,
        `${file} shows the boxes in each view`,
      );
      if (rule.boxes > 0) {
        assert.ok(
          (text.match(/mayCreateAccount\(/g) ?? []).length >= rule.boxes,
          `${file} waits on mayCreateAccount in each view`,
        );
      }
    });
  }

  for (const [file, rule] of Object.entries(NOT_SIGN_UP)) {
    it(`${file}: not a sign-up (${rule.why})`, () => {
      assert.equal(callSites(all.get(file)).length, rule.calls);
    });
  }

  it("records what the person agreed to after a sign-up, or that nothing was", () => {
    const text = all.get("features/identity/ui/OnboardingDialog.tsx");
    // One recorder for every route, and no route calls the version-only one directly.
    assert.match(text, /recordSignUpTerms\(/);
    assert.doesNotMatch(text, /\brememberAcceptance\(/);
    // The invite page records both cases: a server with terms, and a server with none.
    const invite = all.get("features/invite/ui/InvitePage.tsx");
    assert.match(invite, /rememberAcceptance\(/);
    assert.match(invite, /rememberNoAgreement\(/);
  });
});
