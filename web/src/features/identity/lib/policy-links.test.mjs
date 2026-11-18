import assert from "node:assert/strict";
import { test } from "node:test";

import { policyFromResponse } from "./join-policy.ts";
import { policyLinks } from "./policy-links.ts";

const BASE = "https://example.test";

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

test("a server with both pages gets both links, at the paths it serves them on", () => {
  assert.deepEqual(policyLinks(ready(), BASE), [
    {
      key: "terms",
      label: "Terms of use",
      href: "https://example.test/api/join-policy/terms",
    },
    {
      key: "privacy",
      label: "Privacy note",
      href: "https://example.test/api/join-policy/privacy",
    },
  ]);
});

test("only the pages the server has are linked", () => {
  assert.deepEqual(
    policyLinks(ready({ privacy_markdown: "" }), BASE).map((l) => l.key),
    ["terms"],
  );
  assert.deepEqual(
    policyLinks(ready({ terms_markdown: "  " }), BASE).map((l) => l.key),
    ["privacy"],
  );
  assert.deepEqual(
    policyLinks(ready({ terms_markdown: "", privacy_markdown: "" }), BASE),
    [],
  );
});

test("no links while loading, when the server sets none, or when it does not answer", () => {
  assert.deepEqual(policyLinks({ status: "loading" }, BASE), []);
  assert.deepEqual(policyLinks(policyFromResponse({}), BASE), []);
  assert.deepEqual(policyLinks({ status: "unavailable" }, BASE), []);
  assert.deepEqual(policyLinks(policyFromResponse("nonsense"), BASE), []);
});
