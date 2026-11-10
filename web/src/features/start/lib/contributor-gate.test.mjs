import assert from "node:assert/strict";
import test from "node:test";

import {
  canResume,
  contributorGate,
  freshLaunchId,
  LOCKED_GATE_MESSAGE,
} from "./contributor-gate.ts";
import { everyReviewerMustAgree, reviewQuorum } from "./contributor-project.ts";

const ready = {
  network: {
    pending: false,
    failed: false,
    data: { chainId: 11155111, kit: "0xkit", currency: "0xusdc", decimals: 6 },
  },
  mainnetRefused: false,
  me: "aa".repeat(32),
  signingBlocked: null,
  projects: "read",
  wallet: {
    kind: "passkey",
    address: "0xf00",
    accountsChecked: true,
    chainId: 11155111,
    passkeyOffered: true,
  },
  label: (id) => `net-${id}`,
};

test("everything in place: Start is offered", () => {
  assert.deepEqual(contributorGate(ready), { ok: true });
});

test("a kit this build cannot start a project on stops Start with the reason, before anything is sent", () => {
  const reason =
    "Starting a project here needs trading switched on for this site, and it is not.";
  const gate = contributorGate({
    ...ready,
    network: {
      ...ready.network,
      data: { ...ready.network.data, kitProblem: reason },
    },
  });
  assert.deepEqual(gate, { ok: false, reason: "unavailable", message: reason });
  // No problem, or none stated, is no stop.
  for (const kitProblem of [null, undefined]) {
    assert.deepEqual(
      contributorGate({
        ...ready,
        network: {
          ...ready.network,
          data: { ...ready.network.data, kitProblem },
        },
      }),
      { ok: true },
    );
  }
});

test("a locked passkey stops Start before anything is sent, even with an account that could make the DAO", () => {
  const gate = contributorGate({
    ...ready,
    signingBlocked: "Unlock your passkey so this browser can confirm this.",
  });
  assert.equal(gate.ok, false);
  assert.equal(gate.reason, "locked");
  assert.equal(gate.message, LOCKED_GATE_MESSAGE);
});

test("Start waits until the founder's projects, and the ones they removed, have been read", () => {
  assert.equal(
    contributorGate({ ...ready, projects: "reading" }).reason,
    "projects-reading",
  );
  const failed = contributorGate({ ...ready, projects: "failed" });
  assert.equal(failed.reason, "projects-unreadable");
  assert.match(failed.message, /could not be read/);
  assert.match(failed.message, /Try again/);
});

test("the other reasons keep their order and words", () => {
  assert.equal(
    contributorGate({ ...ready, network: { ...ready.network, pending: true } })
      .reason,
    "reading",
  );
  assert.equal(
    contributorGate({
      ...ready,
      network: { ...ready.network, data: { ...ready.network.data, kit: null } },
    }).reason,
    "unavailable",
  );
  assert.equal(contributorGate({ ...ready, me: null }).reason, "sign-in");
  assert.equal(
    contributorGate({ ...ready, wallet: { ...ready.wallet, address: null } })
      .reason,
    "wallet",
  );
  assert.match(
    contributorGate({ ...ready, wallet: { ...ready.wallet, chainId: 1 } })
      .message,
    /works on net-1, but this site's projects are on net-11155111/,
  );
});

test("a new project never takes the id of one its founder removed, so it never picks up the removed one's DAO", () => {
  // Removed from the list, so not among the founder's projects any more: the name alone would reuse its id.
  const id = freshLaunchId(
    { name: "Creaton", mine: [], removed: ["creaton"] },
    () => 0.5,
  );
  assert.notEqual(id, "creaton");
  assert.match(id, /^creaton-[0-9a-z]{4}$/);
  // Never used: the slug itself.
  assert.equal(
    freshLaunchId({ name: "Creaton", mine: ["other"], removed: [] }),
    "creaton",
  );
  // A Projects-board id is kept unless it was ever used, listed or removed.
  assert.equal(
    freshLaunchId({ name: "X", fromBoard: "board-1", mine: [], removed: [] }),
    "board-1",
  );
  assert.notEqual(
    freshLaunchId({
      name: "X",
      fromBoard: "board-1",
      mine: [],
      removed: ["board-1"],
    }),
    "board-1",
  );
});

test("setting up Shares for the founder's own project keeps its id, so its goal, record and followers stay with it", () => {
  assert.equal(
    freshLaunchId({
      name: "Nebula",
      fromIdea: "nebula",
      mine: ["nebula", "other"],
      removed: [],
    }),
    "nebula",
  );
  // An id that was ever removed is never kept, even when a project has it again: a removed project may have had a DAO.
  const again = freshLaunchId(
    {
      name: "Nebula",
      fromIdea: "nebula",
      mine: ["nebula"],
      removed: ["nebula"],
    },
    () => 0.5,
  );
  assert.match(again, /^nebula-[0-9a-z]{4}$/);
  // Not on the founder's list (someone else's, or gone): a fresh id as before.
  assert.equal(
    freshLaunchId({
      name: "Nebula",
      fromIdea: "old-name",
      mine: [],
      removed: [],
    }),
    "nebula",
  );
});

test("with two reviewers the empty box means both must agree, which the form says before anything is made", () => {
  assert.equal(reviewQuorum(2, ""), 2);
  assert.equal(everyReviewerMustAgree(2, ""), true);
  assert.equal(everyReviewerMustAgree(2, "1"), false);
  assert.equal(reviewQuorum(3, ""), 2);
  assert.equal(everyReviewerMustAgree(3, ""), false);
  assert.equal(everyReviewerMustAgree(3, "3"), true);
  // One reviewer deciding alone is not a split that can get stuck.
  assert.equal(everyReviewerMustAgree(1, ""), false);
  assert.equal(reviewQuorum(4, " 3 "), 3);
});

test("a project set up earlier is carried on only by its founder, and not while the passkey is locked", () => {
  const job = { founder: "0xf00" };
  assert.equal(canResume({ job, wallet: "0xF00", signingBlocked: null }), true);
  // Locked: the record could not be published under the founder's name, so nothing is sent first.
  assert.equal(
    canResume({
      job,
      wallet: "0xf00",
      signingBlocked: "Unlock your passkey so this browser can confirm this.",
    }),
    false,
  );
  assert.equal(
    canResume({ job, wallet: "0xbad", signingBlocked: null }),
    false,
  );
  assert.equal(canResume({ job, wallet: null, signingBlocked: null }), false);
});

test("the passkey set-up hint names where fees are covered only when the build knows it", () => {
  const signedOutWallet = {
    kind: null,
    address: null,
    accountsChecked: true,
    chainId: null,
    passkeyOffered: true,
  };
  const words = (passkeyFeesOn) =>
    contributorGate({ ...ready, wallet: { ...signedOutWallet, passkeyFeesOn } })
      .message;
  assert.match(words("Base"), /with its fees covered on Base\./);
  assert.doesNotMatch(words("Base"), /test network/);
  assert.match(words("the test network"), /covered on the test network\./);
  assert.doesNotMatch(words(null), /fees covered/);
});
