import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { policyFromResponse } from "./join-policy.ts";
import {
  ACCEPTED_KEY,
  acceptedVersion,
  reacceptCheck,
  recordSignUpTerms,
  rememberAcceptance,
  resetAcceptanceState,
  subscribeAcceptance,
} from "./policy-acceptance.ts";

const ready = (over = {}) =>
  policyFromResponse({
    policy: {
      terms_markdown: "# T",
      privacy_markdown: "# P",
      age_attestation_required: false,
      version: "v2",
      ...over,
    },
  });

function memoryStore(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => data.set(k, v),
    data,
  };
}
const refusingStore = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("blocked");
  },
};

beforeEach(() => resetAcceptanceState());

describe("when changed terms must be agreed to again", () => {
  const signedIn = true;

  it("asks nobody who is not signed in: sign-up has its own boxes", () => {
    assert.deepEqual(
      reacceptCheck({ signedIn: false, state: ready(), accepted: null }),
      { kind: "none" },
    );
  });

  it("asks nothing while loading and nothing when the server has no policy", () => {
    for (const state of [{ status: "loading" }, { status: "none" }]) {
      assert.deepEqual(reacceptCheck({ signedIn, state, accepted: null }), {
        kind: "none",
      });
    }
  });

  it("says the text could not be loaded, and does not ask, when the server did not answer", () => {
    assert.deepEqual(
      reacceptCheck({
        signedIn,
        state: { status: "unavailable" },
        accepted: "v1",
      }),
      { kind: "unavailable" },
    );
  });

  it("asks nothing when the version agreed to is the served one", () => {
    assert.deepEqual(
      reacceptCheck({ signedIn, state: ready(), accepted: "v2" }),
      { kind: "none" },
    );
  });

  it("asks again when the served version differs, and says whether it is a change or a first agreement", () => {
    assert.deepEqual(
      reacceptCheck({ signedIn, state: ready(), accepted: "v1" }),
      { kind: "ask", changed: true },
    );
    assert.deepEqual(
      reacceptCheck({ signedIn, state: ready(), accepted: null }),
      { kind: "ask", changed: false },
    );
  });

  it("asks when only the age box is new, and nothing when the policy asks for nothing", () => {
    const ageOnly = ready({
      terms_markdown: "",
      privacy_markdown: "",
      age_attestation_required: true,
    });
    assert.equal(
      reacceptCheck({ signedIn, state: ageOnly, accepted: "v1" }).kind,
      "ask",
    );
    const empty = ready({ terms_markdown: "", privacy_markdown: "" });
    assert.equal(
      reacceptCheck({ signedIn, state: empty, accepted: null }).kind,
      "none",
    );
  });
});

describe("the version agreed to, kept in this browser", () => {
  it("keeps the version with the server it was agreed on, and reads it back for that server only", () => {
    const store = memoryStore();
    assert.equal(rememberAcceptance("v1", "a.example", 5, store), true);
    assert.deepEqual(JSON.parse(store.data.get(ACCEPTED_KEY)), {
      version: "v1",
      at: 5,
      host: "a.example",
    });
    assert.equal(acceptedVersion("a.example", store), "v1");
    assert.equal(acceptedVersion("b.example", store), null);
  });

  it("reads a record from before servers were kept as agreed on any server", () => {
    const store = memoryStore({
      [ACCEPTED_KEY]: JSON.stringify({ version: "v0", at: 1 }),
    });
    assert.equal(acceptedVersion("a.example", store), "v0");
  });

  it("reads nothing from a garbled record", () => {
    for (const raw of ["not json", "null", '{"version":3}', "[]"]) {
      assert.equal(
        acceptedVersion("a.example", memoryStore({ [ACCEPTED_KEY]: raw })),
        null,
      );
    }
  });

  it("still counts the agreement for this visit when the browser refuses to keep it, and says it was not kept", () => {
    assert.equal(
      rememberAcceptance("v3", "a.example", 1, refusingStore),
      false,
    );
    assert.equal(acceptedVersion("a.example", refusingStore), "v3");
    assert.equal(acceptedVersion("b.example", refusingStore), null);
  });

  it("tells listeners in this tab when a version is agreed to, until they stop listening", () => {
    let calls = 0;
    const stop = subscribeAcceptance(() => {
      calls += 1;
    });
    rememberAcceptance("v1", "a.example", 1, memoryStore());
    assert.equal(calls, 1);
    stop();
    rememberAcceptance("v2", "a.example", 2, memoryStore());
    assert.equal(calls, 1);
  });
});

describe("what sign-up records about the terms", () => {
  const store = () =>
    memoryStore({
      [ACCEPTED_KEY]: JSON.stringify({
        version: "v2",
        at: 1,
        host: "a.example",
      }),
    });

  it("keeps the agreed version when the terms were shown", () => {
    const s = memoryStore();
    recordSignUpTerms(ready(), "a.example", 7, s);
    assert.equal(acceptedVersion("a.example", s), "v2");
  });

  it("records that no terms were agreed to when they could not be loaded, over an older agreement", () => {
    for (const state of [{ status: "unavailable" }, { status: "none" }]) {
      resetAcceptanceState();
      const s = store();
      assert.equal(acceptedVersion("a.example", s), "v2");
      recordSignUpTerms(state, "a.example", 9, s);
      assert.equal(acceptedVersion("a.example", s), null);
      const record = JSON.parse(s.data.get(ACCEPTED_KEY));
      assert.equal(record.agreed, false);
      assert.equal(record.at, 9);
    }
  });

  it("asks at the first chance: the next served version is a first agreement, not a change", () => {
    const s = store();
    recordSignUpTerms({ status: "unavailable" }, "a.example", 9, s);
    assert.deepEqual(
      reacceptCheck({
        signedIn: true,
        state: ready(),
        accepted: acceptedVersion("a.example", s),
      }),
      { kind: "ask", changed: false },
    );
  });

  it("still counts for this visit when the browser refuses to keep the record", () => {
    const stale = {
      getItem: () =>
        JSON.stringify({ version: "v2", at: 1, host: "a.example" }),
      setItem: () => {
        throw new Error("blocked");
      },
    };
    recordSignUpTerms({ status: "unavailable" }, "a.example", 9, stale);
    assert.equal(acceptedVersion("a.example", stale), null);
  });

  it("lets a later agreement count again", () => {
    const s = store();
    recordSignUpTerms({ status: "unavailable" }, "a.example", 9, s);
    rememberAcceptance("v3", "a.example", 10, s);
    assert.equal(acceptedVersion("a.example", s), "v3");
  });

  it("tells every open tab, as an agreement does", () => {
    let told = 0;
    subscribeAcceptance(() => {
      told += 1;
    });
    recordSignUpTerms({ status: "unavailable" }, "a.example", 9, memoryStore());
    assert.equal(told, 1);
  });
});
