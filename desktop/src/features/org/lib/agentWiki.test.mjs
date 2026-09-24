// Unit tests for Agent Wiki (kind:44002) read-side LWW grouping and the
// distill-run status mapping.
// Run with: node --import ./test-loader.mjs --experimental-strip-types --test src/features/org/lib/agentWiki.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  AGENT_WIKI_DISTILL_ERROR_EXCERPT_CHARS,
  AGENT_WIKI_FETCH_LIMIT,
  AGENT_WIKI_STANDUP_D,
  classifyAgentWikiDistillError,
  classifyAgentWikiDistillRun,
  eventToAgentWikiPage,
  newestAgentWikiPages,
  parseAgentWikiD,
  stripFrontMatter,
} from "./agentWiki.ts";

const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);

function wikiEvent({
  id,
  d,
  created_at,
  pubkey = ALICE,
  content = "hello",
  tags = [],
}) {
  return {
    id,
    pubkey,
    created_at,
    kind: 44002,
    tags: [["d", d], ...tags],
    content,
    sig: "sig",
  };
}

describe("parseAgentWikiD", () => {
  it("splits space from a nested slug", () => {
    assert.deepEqual(parseAgentWikiD("default/projects/research/index"), {
      space: "default",
      slug: "projects/research/index",
    });
  });

  it("rejects d tags without a <space>/<slug> shape", () => {
    assert.equal(parseAgentWikiD("standup"), null);
    assert.equal(parseAgentWikiD(""), null);
    assert.equal(parseAgentWikiD("default/"), null);
    assert.equal(parseAgentWikiD("/standup"), null);
  });
});

describe("stripFrontMatter", () => {
  it("strips the CLI front-matter block", () => {
    const content = [
      "---",
      "slug: default/standup",
      "agwiki-cursor: 1750000000",
      "model: glm-5.3-flash",
      "---",
      "",
      "# Standup",
      "",
      "Shipped the thing.",
    ].join("\n");
    assert.equal(stripFrontMatter(content), "# Standup\n\nShipped the thing.");
  });

  it("returns content without front matter unchanged", () => {
    assert.equal(stripFrontMatter("# Just markdown"), "# Just markdown");
  });

  it("returns content unchanged when the front matter never closes", () => {
    const content = "---\nslug: default/standup\nno close";
    assert.equal(stripFrontMatter(content), content);
  });
});

describe("eventToAgentWikiPage", () => {
  it("extracts space, slug, body, and provenance tags", () => {
    const page = eventToAgentWikiPage(
      wikiEvent({
        id: "e1",
        d: "default/standup",
        created_at: 100,
        content: "---\nmodel: glm-5.3-flash\n---\n\nBody.",
        tags: [
          ["model", "glm-5.3-flash"],
          ["cost_tokens", "4200"],
          ["sources", `${"c".repeat(64)},${"d".repeat(64)}`],
        ],
      }),
    );
    assert.ok(page);
    assert.equal(page.space, "default");
    assert.equal(page.slug, "standup");
    assert.equal(page.content, "Body.");
    assert.equal(page.model, "glm-5.3-flash");
    assert.equal(page.costTokens, 4200);
    assert.equal(page.sources.length, 2);
  });

  it("tolerates missing or malformed provenance", () => {
    const page = eventToAgentWikiPage(
      wikiEvent({ id: "e1", d: "default/standup", created_at: 100 }),
    );
    assert.ok(page);
    assert.equal(page.model, null);
    assert.equal(page.costTokens, null);
    assert.deepEqual(page.sources, []);
    const malformed = eventToAgentWikiPage(
      wikiEvent({
        id: "e2",
        d: "default/standup",
        created_at: 100,
        tags: [["cost_tokens", "lots"]],
      }),
    );
    assert.ok(malformed);
    assert.equal(malformed.costTokens, null);
  });

  it("skips non-44002 events and malformed d tags", () => {
    const wrongKind = eventToAgentWikiPage({
      id: "x",
      kind: 37010,
      pubkey: ALICE,
      created_at: 1,
      tags: [["d", "default/standup"]],
      content: "",
      sig: "sig",
    });
    assert.equal(wrongKind, null);
    const badD = eventToAgentWikiPage(
      wikiEvent({ id: "x", d: "no-slash", created_at: 1 }),
    );
    assert.equal(badD, null);
  });
});

describe("newestAgentWikiPages", () => {
  it("folds revisions to the newest event per d (read-side LWW)", () => {
    const pages = newestAgentWikiPages([
      wikiEvent({
        id: "v1",
        d: "default/standup",
        created_at: 100,
        content: "old",
      }),
      wikiEvent({
        id: "v3",
        d: "default/standup",
        created_at: 300,
        content: "newest",
      }),
      wikiEvent({
        id: "v2",
        d: "default/standup",
        created_at: 200,
        content: "middle",
      }),
    ]);
    assert.equal(pages.length, 1);
    assert.equal(pages[0].content, "newest");
    assert.equal(pages[0].updatedAt, 300);
  });

  it("keeps one head per (pubkey, d), then one winner per d across authors", () => {
    const pages = newestAgentWikiPages([
      // Alice revised twice; her head is t=300.
      wikiEvent({ id: "a1", d: "default/standup", created_at: 100 }),
      wikiEvent({ id: "a2", d: "default/standup", created_at: 300 }),
      // Bob's older page must lose to Alice's newer head for the same d.
      wikiEvent({
        id: "b1",
        d: "default/standup",
        created_at: 200,
        pubkey: BOB,
      }),
      // A different page stays independent.
      wikiEvent({ id: "c1", d: "default/projects/x/index", created_at: 400 }),
    ]);
    assert.equal(pages.length, 2);
    assert.deepEqual(
      pages.map((page) => page.d),
      ["default/projects/x/index", "default/standup"],
    );
    const standup = pages.find((page) => page.d === "default/standup");
    assert.equal(standup.authorPubkey, ALICE);
    assert.equal(standup.updatedAt, 300);
  });

  it("breaks same-timestamp ties deterministically by event id", () => {
    const pages = newestAgentWikiPages([
      wikiEvent({ id: "zzz", d: "default/standup", created_at: 500 }),
      wikiEvent({ id: "aaa", d: "default/standup", created_at: 500 }),
    ]);
    assert.equal(pages.length, 1);
    assert.equal(pages[0].eventId, "zzz");
  });

  it("ignores non-44002 events entirely", () => {
    const pages = newestAgentWikiPages([
      {
        id: "org",
        kind: 37010,
        pubkey: ALICE,
        created_at: 900,
        tags: [["d", "default/standup"]],
        content: "{}",
        sig: "sig",
      },
    ]);
    assert.deepEqual(pages, []);
  });
});

describe("constants", () => {
  it("bounds the fetch and pins the standup page", () => {
    assert.equal(AGENT_WIKI_FETCH_LIMIT, 100);
    assert.equal(AGENT_WIKI_STANDUP_D, "default/standup");
    assert.equal(AGENT_WIKI_DISTILL_ERROR_EXCERPT_CHARS, 300);
  });
});

// ── Distill status mapping (the seam useAgentWikiDistillMutation calls) ────
//
// Representative CLI outputs, verified against crates/buzz-cli/src:
// - skip stdout: run_distill_inner (commands/agent_wiki.rs) prints exactly
//   "no new done tasks or contribution records since cursor {since}; nothing
//   to distill" and exits 0 before any LLM call.
// - publish stdout: the normalized write response printed at the end of
//   run_distill_inner (`println!("{normalized}")`); normalize_write_response
//   (client.rs) emits `{"accepted":…,"event_id":…,"message":…}`.
// - failure stderr: print_error (error.rs) writes one JSON envelope
//   `{"error":…,"message":…,"retryable":…}` per CliError.
// - timeout text: "… timed out after <n>s and was stopped" (the format used
//   by desktop/src-tauri/src/commands/org_classify.rs and the agwiki_distill
//   sidecar contract).

const SKIP_STDOUT =
  "no new done tasks or contribution records since cursor 1750000000; nothing to distill";
const PUBLISH_STDOUT = '{"accepted":true,"event_id":"aabbcc","message":""}';
const ENV_KEY_STDERR =
  '{"error":"user_error","message":"BUZZ_CLASSIFIER_API_KEY is required; classify fails closed without it","retryable":false}';
const TIMEOUT_TEXT = "distill timed out after 180s and was stopped";
const UNCONFIRMED_PREFIX = "distill exited without a publish confirmation";

describe("classifyAgentWikiDistillRun", () => {
  const matrix = [
    {
      name: "publish confirmation → published with the event id",
      run: { ok: true, stdout: PUBLISH_STDOUT, stderr: "" },
      expected: { status: "published", eventId: "aabbcc" },
    },
    {
      name: "publish confirmation is key-order agnostic",
      run: {
        ok: true,
        stdout: '{"event_id":"ffee00","accepted":true,"message":""}',
        stderr: "",
      },
      expected: { status: "published", eventId: "ffee00" },
    },
    {
      name: "skip line → nothing-new (friendly status, NOT an error)",
      run: { ok: true, stdout: SKIP_STDOUT, stderr: "" },
      expected: { status: "nothing-new" },
    },
    {
      name: "skip line survives stderr notes",
      run: {
        ok: true,
        stdout: `${SKIP_STDOUT}\n`,
        stderr: "note: --limit 30 exceeds the hard cap of 20; using 20\n",
      },
      expected: { status: "nothing-new" },
    },
    {
      name: "non-zero exit with print_error envelope → failed with its message",
      run: { ok: false, stdout: "", stderr: ENV_KEY_STDERR },
      expected: {
        status: "failed",
        message:
          "BUZZ_CLASSIFIER_API_KEY is required; classify fails closed without it",
      },
    },
    {
      name: "harness timeout string in the run output → timeout",
      run: { ok: false, stdout: "", stderr: TIMEOUT_TEXT },
      expected: { status: "timeout" },
    },
  ];

  for (const { name, run, expected } of matrix) {
    it(name, () => {
      assert.deepEqual(classifyAgentWikiDistillRun(run), expected);
    });
  }

  it("surfaces a raw stderr failure verbatim (bounded excerpt)", () => {
    const outcome = classifyAgentWikiDistillRun({
      ok: false,
      stdout: "",
      stderr: "  relay error 502: bad gateway  \n",
    });
    assert.deepEqual(outcome, {
      status: "failed",
      message: "relay error 502: bad gateway",
    });
  });

  it("falls back to a no-output message when a failure prints nothing", () => {
    const outcome = classifyAgentWikiDistillRun({
      ok: false,
      stdout: "",
      stderr: "",
    });
    assert.deepEqual(outcome, {
      status: "failed",
      message: "buzz agwiki distill failed with no output",
    });
  });

  it("bounds the failure excerpt to the char cap", () => {
    const outcome = classifyAgentWikiDistillRun({
      ok: false,
      stdout: "",
      stderr: "x".repeat(1000),
    });
    assert.equal(outcome.status, "failed");
    assert.ok(
      outcome.message.length <= AGENT_WIKI_DISTILL_ERROR_EXCERPT_CHARS + 1,
    );
    assert.ok(outcome.message.endsWith("…"));
  });

  it("treats a preview-only run (exit 0, no publish confirmation) as failed", () => {
    const previewStdout = [
      "---\nslug: default/standup\nagwiki-cursor: 1\n---\n# Standup",
      "preview only (cost ~1500 tokens); pass --publish to save the standup page (d=default/standup)",
    ].join("\n");
    const outcome = classifyAgentWikiDistillRun({
      ok: true,
      stdout: previewStdout,
      stderr: "",
    });
    assert.equal(outcome.status, "failed");
    assert.ok(outcome.message.startsWith(UNCONFIRMED_PREFIX));
  });

  it("never reports success without accepted:true and a non-empty event id", () => {
    for (const stdout of [
      '{"accepted":false,"event_id":"aabbcc","message":"rejected"}',
      '{"accepted":true,"event_id":"","message":""}',
      "published something",
    ]) {
      const outcome = classifyAgentWikiDistillRun({
        ok: true,
        stdout,
        stderr: "",
      });
      assert.equal(outcome.status, "failed", `must fail for: ${stdout}`);
    }
  });
});

describe("classifyAgentWikiDistillError", () => {
  it("classifies the sidecar timeout format as timeout", () => {
    assert.deepEqual(classifyAgentWikiDistillError(TIMEOUT_TEXT), {
      status: "timeout",
    });
    // The same format the org_classify sidecar uses for its timeout rejection.
    assert.deepEqual(
      classifyAgentWikiDistillError(
        "classifier timed out after 60s and was stopped",
      ),
      { status: "timeout" },
    );
  });

  it("passes missing-classifier-env errors through unchanged (classify UX)", () => {
    for (const message of [
      "BUZZ_CLASSIFIER_API_URL is not configured",
      "BUZZ_CLASSIFIER_API_KEY is not configured",
    ]) {
      assert.deepEqual(classifyAgentWikiDistillError(message), {
        status: "failed",
        message,
      });
    }
  });

  it("bounds long rejection messages to the char cap", () => {
    const outcome = classifyAgentWikiDistillError("y".repeat(1000));
    assert.equal(outcome.status, "failed");
    assert.ok(
      outcome.message.length <= AGENT_WIKI_DISTILL_ERROR_EXCERPT_CHARS + 1,
    );
    assert.ok(outcome.message.endsWith("…"));
  });

  it("falls back to the no-output message for an empty rejection", () => {
    assert.deepEqual(classifyAgentWikiDistillError("   "), {
      status: "failed",
      message: "buzz agwiki distill failed with no output",
    });
  });
});
