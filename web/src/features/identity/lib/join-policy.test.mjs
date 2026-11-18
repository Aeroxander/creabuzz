import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  mayCreateAccount,
  policyFromResponse,
  policyRequirements,
} from "./join-policy.ts";

const ready = (over = {}) =>
  policyFromResponse({
    policy: {
      terms_markdown: "# T",
      privacy_markdown: "# P",
      age_attestation_required: false,
      version: "v1",
      ...over,
    },
  });

describe("join policy at sign-up", () => {
  it("reads the server's answer, and treats a garbled one as unavailable rather than as no policy", () => {
    assert.equal(policyFromResponse({}).status, "none");
    assert.equal(ready().status, "ready");
    assert.equal(policyFromResponse(null).status, "unavailable");
    assert.equal(
      policyFromResponse({ policy: { terms_markdown: "# T" } }).status,
      "unavailable",
    );
  });

  it("asks for agreement when there are terms or a privacy note, and for age only when the server asks", () => {
    assert.deepEqual(policyRequirements(ready()), {
      agreement: true,
      age: false,
    });
    assert.deepEqual(
      policyRequirements(ready({ age_attestation_required: true })),
      { agreement: true, age: true },
    );
    assert.deepEqual(
      policyRequirements(ready({ terms_markdown: " ", privacy_markdown: "" })),
      { agreement: false, age: false },
    );
  });

  it("lets sign-up go ahead only once every box asked for is ticked, and never while still loading", () => {
    const none = { agreement: false, age: false };
    assert.equal(mayCreateAccount({ status: "loading" }, none), false);
    assert.equal(mayCreateAccount(ready(), none), false);
    assert.equal(
      mayCreateAccount(ready(), { agreement: true, age: false }),
      true,
    );
    assert.equal(
      mayCreateAccount(ready({ age_attestation_required: true }), {
        agreement: true,
        age: false,
      }),
      false,
    );
    assert.equal(mayCreateAccount({ status: "none" }, none), true);
    assert.equal(mayCreateAccount({ status: "unavailable" }, none), true);
  });
});
