import assert from "node:assert/strict";
import { test } from "node:test";

import { hashText } from "@creaton/core/launchpad/work.ts";

import {
  emptyBudgetProblem,
  nameProblem,
  noAreaProblem,
  resubmitProblem,
} from "./claim-file-checks.ts";

const open = (evidence, status = "Open") => ({
  record: { status, evidenceHash: hashText(evidence) },
});

test("a name already used can only finish the same open submission, never stand for new or fixed work", () => {
  assert.equal(resubmitProblem(undefined, "anything"), null);
  // The same evidence on an open submission: publishing its evidence again, or putting its words right.
  assert.equal(resubmitProblem(open("https://x/pr/1"), "https://x/pr/1"), null);
  // Fixed work under the old name would change nothing on chain.
  assert.match(
    resubmitProblem(open("https://x/pr/1"), "https://x/pr/2") ?? "",
    /Choose a new name/,
  );
  for (const status of ["Rejected", "Paid", "Expired", "Approved"]) {
    assert.match(
      resubmitProblem(open("https://x/pr/1", status), "https://x/pr/1") ?? "",
      /already used that name/,
      status,
    );
  }
});

test("words that match no open work area are refused before anything is sent", () => {
  const areas = [{ checkHash: hashText("docs merged and reviewed") }];
  assert.equal(noAreaProblem(areas, "docs merged and reviewed"), null);
  assert.match(
    noAreaProblem(areas, "my own words") ?? "",
    /match no open work area/,
  );
  // A budget whose areas are not known here is not second-guessed.
  assert.equal(noAreaProblem([], "my own words"), null);
});

test("a name is plain text the pages can show, up to 32 characters", () => {
  assert.equal(nameProblem("write-the-docs"), null);
  assert.match(nameProblem("Übersetzung") ?? "", /no accents or emoji/);
  assert.match(nameProblem("docs 🚀") ?? "", /no accents or emoji/);
  assert.match(nameProblem("   ") ?? "", /a title, up to 32 characters/);
  assert.match(nameProblem("x".repeat(33)) ?? "", /up to 32/);
});

test("new work in a budget with no open work area is refused before it is sent; finishing earlier work is not", () => {
  const none = {
    openAreas: 0,
    truncated: false,
    otherBudgets: 0,
    existing: false,
  };
  assert.match(emptyBudgetProblem(none) ?? "", /no open work areas yet/);
  assert.match(
    emptyBudgetProblem({ ...none, otherBudgets: 1 }) ?? "",
    /Pick another work budget/,
  );
  assert.equal(emptyBudgetProblem({ ...none, openAreas: 1 }), null);
  // A list cut short may be missing the open area: never refused on a guess.
  assert.equal(emptyBudgetProblem({ ...none, truncated: true }), null);
  // A claim already filed under this title can still have its evidence published after its area closed.
  assert.equal(emptyBudgetProblem({ ...none, existing: true }), null);
});
