import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MAX_ROLES,
  PitchValidationError,
  buildPitchTemplate,
  declaredPool,
  parsePitch,
  slugify,
} from "./manifest.ts";

const FOUNDER = "f".repeat(64);

const ROLES = [
  { slug: "founder", label: "The founder", pct: 40 },
  { slug: "writer", label: "The writer", pct: 12 },
  { slug: "designer", label: "The designer", pct: 8 },
];

function build(overrides = {}) {
  return buildPitchTemplate({
    nodeId: "nebula",
    name: "Nebula",
    summary: "A social app for stargazers.",
    description: "Long-form pitch.",
    founderRole: "founder",
    roles: ROLES,
    ...overrides,
  });
}

function sign(template, overrides = {}) {
  return {
    id: overrides.id ?? "e".repeat(64),
    kind: template.kind,
    pubkey: overrides.pubkey ?? FOUNDER,
    created_at: overrides.created_at ?? 1_000,
    tags: template.tags,
    content: template.content,
  };
}

describe("buildPitchTemplate", () => {
  it("composes the golden kind:37015 tags and content body", () => {
    const template = build();
    assert.equal(template.kind, 37015);
    assert.deepEqual(template.tags, [
      ["d", "nebula"],
      ["name", "Nebula"],
      ["role", "founder", "The founder", "40"],
      ["role", "writer", "The writer", "12"],
      ["role", "designer", "The designer", "8"],
    ]);
    assert.deepEqual(JSON.parse(template.content), {
      v: 1,
      summary: "A social app for stargazers.",
      founderRole: "founder",
      description: "Long-form pitch.",
    });
  });

  it("keeps ids within the bounds the relay enforces", () => {
    const template = build({ nodeId: "n".repeat(32), name: "x".repeat(128) });
    assert.equal(template.tags[0][1].length, 32);
    assert.equal(template.tags[1][1].length, 128);
    const longSlug = build({
      roles: [
        { slug: "founder", label: "F", pct: 96 },
        { slug: "r".repeat(12), label: "R".repeat(64), pct: 4 },
      ],
    });
    const roleTag = longSlug.tags.find(
      (tag) => tag[1].length === 12 && tag[0] === "role",
    );
    assert.equal(roleTag[2].length, 64);
    // `<node>/<role>` is what a grant's d tag will be: it must fit in 64.
    assert.ok(`${template.tags[0][1]}/${roleTag[1]}`.length <= 64);
  });

  it("refuses a declared pool above 100%", () => {
    assert.throws(
      () =>
        build({
          roles: [
            { slug: "founder", label: "The founder", pct: 60 },
            { slug: "writer", label: "The writer", pct: 50 },
          ],
        }),
      (error) =>
        error instanceof PitchValidationError &&
        error.field === "roles" &&
        /add up to 110%/.test(error.message),
    );
  });

  it("accepts a pool of exactly 100%", () => {
    const template = build({
      roles: [
        { slug: "founder", label: "The founder", pct: 60 },
        { slug: "writer", label: "The writer", pct: 40 },
      ],
    });
    assert.equal(
      declaredPool([
        { slug: "founder", label: "The founder", pct: 60 },
        { slug: "writer", label: "The writer", pct: 40 },
      ]),
      100,
    );
    assert.ok(template.tags.some((tag) => tag[0] === "role"));
  });

  it("refuses duplicate, malformed, or unbounded roles", () => {
    const bad = [
      // duplicate slug
      { roles: [ROLES[0], { ...ROLES[1], slug: "founder" }] },
      // slug outside the relay's [a-z0-9-]{1,12}
      { roles: [{ slug: "Writer!", label: "W", pct: 5 }, ROLES[0]] },
      // percentage outside 1..=100
      { roles: [{ slug: "founder", label: "F", pct: 0 }] },
      // more roles than the board allows
      {
        roles: [
          { slug: "founder", label: "F", pct: 1 },
          ...Array.from({ length: MAX_ROLES }, (_, i) => ({
            slug: `r${i}`,
            label: `R${i}`,
            pct: 1,
          })),
        ],
      },
    ];
    for (const { roles } of bad) {
      assert.throws(
        () => build({ roles }),
        (error) =>
          error instanceof PitchValidationError && error.field === "roles",
        `roles ${JSON.stringify(roles)} must be refused`,
      );
    }
  });

  it("requires the founder's role to be one of the declared roles", () => {
    assert.throws(
      () => build({ founderRole: "editor" }),
      (error) =>
        error instanceof PitchValidationError &&
        /which declared role/.test(error.message),
    );
  });

  it("refuses an id, name, or summary the relay would reject", () => {
    assert.throws(
      () => build({ nodeId: "Not A Slug" }),
      (e) => e instanceof PitchValidationError && e.field === "nodeId",
    );
    assert.throws(
      () => build({ name: "   " }),
      (e) => e instanceof PitchValidationError && e.field === "name",
    );
    assert.throws(
      () => build({ summary: "" }),
      (e) => e instanceof PitchValidationError && e.field === "summary",
    );
  });
});

describe("parsePitch", () => {
  it("round-trips what buildPitchTemplate composed", () => {
    const pitch = parsePitch(sign(build()));
    assert.ok(pitch);
    assert.equal(pitch.nodeId, "nebula");
    assert.equal(pitch.name, "Nebula");
    assert.equal(pitch.author, FOUNDER);
    assert.equal(pitch.founderRole, "founder");
    assert.deepEqual(pitch.roles, ROLES);
    assert.equal(pitch.overPool, false);
  });

  it("needs a d tag to have a project at all", () => {
    const template = build();
    const noD = sign({
      ...template,
      tags: template.tags.filter((t) => t[0] !== "d"),
    });
    assert.equal(parsePitch(noD), null);
    assert.equal(parsePitch({ ...sign(build()), kind: 37010 }), null);
  });

  it("fails open: unreadable role tags drop out, the pitch still renders", () => {
    const template = build();
    const pitch = parsePitch(
      sign({
        ...template,
        tags: [
          ...template.tags,
          ["role", "Writer!", "Too long label here", "500"],
          ["role", "no-pct"],
        ],
      }),
    );
    assert.ok(pitch);
    assert.deepEqual(
      pitch.roles.map((r) => r.slug),
      ["founder", "writer", "designer"],
    );
    assert.equal(pitch.founderRole, "founder");
  });

  it("flags a manifest whose declared pool exceeds 100% instead of trusting it", () => {
    const tags = [
      ["d", "nebula"],
      ["role", "founder", "The founder", "70"],
      ["role", "writer", "The writer", "70"],
    ];
    const pitch = parsePitch(
      sign({
        kind: 37015,
        tags,
        content: JSON.stringify({ v: 1, summary: "s", founderRole: "founder" }),
      }),
    );
    assert.ok(pitch);
    assert.equal(pitch.overPool, true);
    assert.equal(declaredPool(pitch.roles), 140);
  });

  it("keeps a pitch whose content body is junk (tags carry the structure)", () => {
    const template = build();
    const pitch = parsePitch(sign({ ...template, content: "not json" }));
    assert.ok(pitch);
    assert.equal(pitch.summary, "");
    assert.equal(pitch.founderRole, null);
    assert.equal(pitch.roles.length, 3);
  });
});

describe("slugify", () => {
  it("produces valid project ids or nothing", () => {
    assert.equal(slugify("Nebula DAO"), "nebula-dao");
    assert.equal(slugify("  Hello, World!  "), "hello-world");
    assert.equal(slugify("!!!"), null);
  });
});
