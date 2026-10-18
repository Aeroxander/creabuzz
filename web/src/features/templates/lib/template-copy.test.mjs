import test from "node:test";
import assert from "node:assert/strict";

import { TEMPLATE_CATALOG } from "@creaton/core/templates/catalog.generated.ts";
import { TEMPLATE_INDEX } from "@creaton/core/templates/catalog-index.generated.ts";

import {
  describeDefaultLimit,
  PRESETS,
  templateAudience,
  templatePreset,
  templateCounts,
  templateTitle,
} from "./template-copy.ts";

test("every bundled template has a plain title and a line about who it is for", () => {
  for (const summary of TEMPLATE_INDEX) {
    assert.ok(templateTitle(summary).length > 0);
    assert.ok(
      templateAudience(summary.id),
      `${summary.id} has no audience line`,
    );
  }
  assert.equal(
    templateTitle({ id: "vanilla-app-studio", name: "Vanilla App Studio" }),
    "Web & App Studio",
  );
  assert.equal(
    templateTitle({ id: "ai-media-studio", name: "AI Media Studio" }),
    "AI Media Studio",
  );
});

test("the two starting points are bundled teams, in plain words, and are not copied from anywhere else", () => {
  assert.equal(PRESETS.length, 2);
  for (const preset of PRESETS) {
    assert.ok(
      TEMPLATE_INDEX.some((t) => t.id === preset.id),
      `${preset.id} is not a bundled team`,
    );
    assert.deepEqual(templatePreset(preset.id), preset);
    assert.ok(preset.blurb.length > 0 && preset.blurb.length <= 80);
  }
  assert.deepEqual(
    PRESETS.map((p) => p.title),
    ["Creative project", "Technical project"],
  );
  // Teams that are not a starting point stay under "More kinds of team".
  assert.equal(templatePreset("crypto-app-studio"), null);
});

test("counts say what a template makes and leave out what it does not", () => {
  assert.equal(
    templateCounts({
      channels: [1, 2, 3, 4],
      helpers: [1, 2, 3, 4, 5, 6],
      pages: [1, 2, 3],
    }),
    "4 channels · 6 AI helpers · 3 shared pages",
  );
  assert.equal(
    templateCounts({ channels: [1], helpers: [], pages: [] }),
    "1 channel",
  );
  // Boards are counted apart from channels.
  assert.equal(
    templateCounts({
      channels: [
        { board: false },
        { board: false },
        { board: true },
        { board: true },
      ],
      helpers: [1],
      pages: [],
    }),
    "2 channels · 2 boards · 1 AI helper",
  );
  assert.equal(
    templateCounts({
      channels: [{ board: false }, { board: true }],
      helpers: [],
      pages: [],
    }),
    "1 channel · 1 board",
  );
  assert.equal(
    templateCounts({ channels: [1, 2], helpers: [1], pages: [1] }),
    "2 channels · 1 AI helper · 1 shared page",
  );
});

test("the default limit is said the way a person would say it", () => {
  const template = TEMPLATE_CATALOG["ai-media-studio"].template;
  assert.equal(
    describeDefaultLimit(template.org.default_budget),
    "Each helper can run 200 times, start 20 tasks, send 300 messages and make 200 AI requests a day. Past that, it asks you first.",
  );
  assert.equal(describeDefaultLimit(null), null);
  assert.equal(describeDefaultLimit({}), null);
  assert.equal(
    describeDefaultLimit({ window: "week", runs: 5 }),
    "Each helper can run 5 times a week. Past that, it asks you first.",
  );
});
