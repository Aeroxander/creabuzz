#!/usr/bin/env node
// Bundles the project templates (templates/<id>/) for the web app:
//
//   node scripts/regen-template-catalog.mjs           # rewrite the generated files
//   node scripts/regen-template-catalog.mjs --check   # fail when they are stale
//
// The command line reads `templates/` directly; the browser cannot, so this
// reads every template once, checks it against the same bounds
// (packages/creaton-core/src/templates/schema.ts, which follows
// crates/buzz-cli/src/commands/templates/schema.rs) and writes:
//
//   packages/creaton-core/src/templates/catalog-index.generated.ts
//     what the picker shows (small, loaded with the page)
//   packages/creaton-core/src/templates/catalog.generated.ts
//     every template with every file it names (loaded when someone picks one)
//
// Both are @generated; never edit by hand. `--check` is the drift gate (wired
// into the web `pnpm check`): editing a template without regenerating, or
// hand-editing a generated file, fails it.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

import {
  docSlug,
  isRemoteSkill,
  validateTemplate,
} from "../packages/creaton-core/src/templates/schema.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATES_DIR = resolve(repoRoot, "templates");
const OUT_DIR = resolve(repoRoot, "packages/creaton-core/src/templates");
const OUT_INDEX = join(OUT_DIR, "catalog-index.generated.ts");
const OUT_CATALOG = join(OUT_DIR, "catalog.generated.ts");

/** Picker order: the people we are building for first. Unlisted ids follow, alphabetically. */
const ORDER = [
  "ai-media-studio",
  "ai-app-studio",
  "crypto-app-studio",
  "vanilla-app-studio",
];

/** Split `---\n<yaml>\n---\nbody` and return the parsed front matter. */
function frontMatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return null;
  try {
    const value = parse(match[1]);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

/** Normalize a parsed template.yaml into the shape the schema types describe. */
function normalize(raw) {
  return {
    id: raw.id,
    name: raw.name,
    description: raw.description,
    channels: (raw.channels ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      purpose: c.purpose ?? "",
      ...(c.seed ? { seed: c.seed } : {}),
    })),
    personas: (raw.personas ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      prompt: p.prompt,
      ...(p.skills ? { skills: p.skills } : {}),
    })),
    workflows: (raw.workflows ?? []).map((w) => ({
      file: w.file,
      ...(w.channel ? { channel: w.channel } : {}),
    })),
    docs: (raw.docs ?? []).map((d) => ({ file: d.file, title: d.title })),
    skills: (raw.skills ?? []).map((s) => ({
      name: s.name,
      source: s.source,
      applies_to: s.applies_to ?? "all",
    })),
    welcome: raw.welcome,
    ...(raw.org
      ? {
          org: {
            root: {
              name: raw.org.root.name,
              ...(raw.org.root.blurb ? { blurb: raw.org.root.blurb } : {}),
            },
            seats: (raw.org.seats ?? []).map((s) => ({
              persona: s.persona,
              ...(s.title ? { title: s.title } : {}),
            })),
            ...(raw.org.default_budget
              ? { default_budget: raw.org.default_budget }
              : {}),
          },
        }
      : {}),
  };
}

/** Every template-relative file a template names. */
function referencedFiles(t) {
  const paths = new Set();
  for (const c of t.channels) if (c.seed) paths.add(c.seed);
  for (const p of t.personas) paths.add(p.prompt);
  for (const w of t.workflows) paths.add(w.file);
  for (const d of t.docs) paths.add(d.file);
  for (const s of t.skills) if (!isRemoteSkill(s)) paths.add(s.source);
  paths.add(t.welcome);
  return [...paths].sort();
}

function loadTemplate(id) {
  const dir = join(TEMPLATES_DIR, id);
  const raw = parse(readFileSync(join(dir, "template.yaml"), "utf8"));
  const template = normalize(raw);
  const files = {};
  for (const path of referencedFiles(template)) {
    const full = join(dir, path);
    if (existsSync(full)) files[path] = readFileSync(full, "utf8");
  }
  const skills = {};
  for (const skill of template.skills) {
    if (isRemoteSkill(skill)) continue;
    const content = files[skill.source];
    if (content === undefined) continue;
    const meta = frontMatter(content);
    if (!meta?.name || !meta?.description) {
      throw new Error(`${id}: skill ${skill.name} has no name and description in its front matter`);
    }
    skills[skill.name] = {
      name: String(meta.name),
      description: String(meta.description),
      sha256: createHash("sha256").update(content).digest("hex"),
      content,
    };
  }
  const entry = { template, files, skills };
  const problems = validateTemplate(entry);
  if (problems.length > 0) {
    throw new Error(`template ${id} is invalid:\n  - ${problems.join("\n  - ")}`);
  }
  return entry;
}

function summarize(entry) {
  const t = entry.template;
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    channels: t.channels.map((c) => ({
      name: c.name,
      purpose: c.purpose,
    })),
    helpers: t.personas.map((p) => p.name),
    pages: t.docs.map((d) => d.title),
    automations: t.workflows.map((w) => docSlug(w.file) ?? w.file),
    needsCommandLine: t.skills.filter(isRemoteSkill).map((s) => s.name),
    defaultBudget: t.org?.default_budget ?? null,
  };
}

const HEADER = (what) => `// @generated by \`node scripts/regen-template-catalog.mjs\` — DO NOT EDIT.
// ${what}
// Source of truth: templates/. Edit a template, then regenerate.
// biome-ignore-all lint: generated
// biome-ignore-all format: generated
`;

function render() {
  const ids = readdirSync(TEMPLATES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(TEMPLATES_DIR, e.name, "template.yaml")))
    .map((e) => e.name);
  const ordered = [
    ...ORDER.filter((id) => ids.includes(id)),
    ...ids.filter((id) => !ORDER.includes(id)).sort(),
  ];
  const entries = ordered.map(loadTemplate);
  const index = `${HEADER("What the template picker shows.")}
import type { TemplateSummary } from "./schema.ts";

export const TEMPLATE_INDEX: readonly TemplateSummary[] = ${JSON.stringify(entries.map(summarize), null, 2)};
`;
  const catalog = `${HEADER("Every bundled template with every file it names.")}
import type { TemplateEntry } from "./schema.ts";

export const TEMPLATE_CATALOG: Readonly<Record<string, TemplateEntry>> = ${JSON.stringify(
    Object.fromEntries(entries.map((e) => [e.template.id, e])),
    null,
    2,
  )};
`;
  return [
    [OUT_INDEX, index],
    [OUT_CATALOG, catalog],
  ];
}

const outputs = render();
if (process.argv.includes("--check")) {
  const stale = outputs.filter(([path, text]) => {
    try {
      return readFileSync(path, "utf8") !== text;
    } catch {
      return true;
    }
  });
  if (stale.length > 0) {
    console.error(
      `template catalog is stale: ${stale.map(([p]) => p.replace(`${repoRoot}/`, "")).join(", ")}\nrun: node scripts/regen-template-catalog.mjs`,
    );
    process.exit(1);
  }
  console.log("regen-template-catalog: bundled templates are up to date");
} else {
  for (const [path, text] of outputs) writeFileSync(path, text);
  console.log(`regen-template-catalog: wrote ${outputs.length} files`);
}
