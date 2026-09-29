import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Shared "plain user copy" guard.
 *
 * Text people read in the app must say what a thing does, in plain words. It
 * kept drifting toward the vocabulary of whoever wrote the logic: research
 * citations ("Failure modes (WEF five)"), protocol internals ("kind:37012",
 * "NIP-29", "(GraduationExecutor.sol:86-91)", "Q96"), and pointers at routes a
 * user should never be sent to. This guard stops those from coming back.
 *
 * It parses each source file with the TypeScript compiler and inspects only
 * string literals, template text and JSX text — never comments, identifiers or
 * import paths — so code can still talk about kinds and contracts freely.
 * Strings passed straight to `console.*` are developer logs and are skipped.
 *
 * Put power-user detail behind a collapsed "Technical details" disclosure and
 * allowlist that one string with a reason; do not widen the rules.
 */

/** @typedef {{ id: string, pattern: RegExp, why: string }} CopyRule */

/** @type {readonly CopyRule[]} */
export const COPY_RULES = [
  {
    id: "citation",
    pattern:
      /\bWEF\b|World Economic Forum|arXiv|Pentland|Tomasello|CooperBench|MetaDAO|\(Cursor\)|Cursor's/,
    why: "cite nothing in UI text; name the thing by what it does",
  },
  {
    id: "contract-source",
    pattern: /\.sol:\d/,
    why: "contract file:line references are for code comments, not users",
  },
  {
    id: "event-kind",
    pattern: /\bkind[: ]\s?\d{4,5}\b/i,
    why: "event kind numbers are protocol internals",
  },
  {
    id: "nip-number",
    pattern: /\bNIP-(?:\d+|[A-Z]{2,})\b/,
    why: "NIP numbers are protocol internals",
  },
  {
    id: "fixed-point",
    pattern: /\bQ96\b|CREATE2/,
    why: "fixed-point formats and opcodes are implementation detail",
  },
  {
    id: "demo-route",
    pattern: /\/identity-demo\b/,
    why: "never send people to the demo page",
  },
];

const TEST_FILE_RE = /\.test\.(?:m?[jt]sx?)$/;

/**
 * Every rule violation in one file's user-visible strings.
 *
 * @param {typeof import("typescript")} ts
 * @param {string} fileName
 * @param {string} text
 * @returns {{ line: number, rule: string, why: string, snippet: string }[]}
 */
export function findCopyViolations(ts, fileName, text) {
  const source = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found = [];

  const inspect = (node, value) => {
    for (const rule of COPY_RULES) {
      if (rule.pattern.test(value)) {
        const { line } = source.getLineAndCharacterOfPosition(
          node.getStart(source),
        );
        found.push({
          line: line + 1,
          rule: rule.id,
          why: rule.why,
          snippet: value.replace(/\s+/g, " ").trim().slice(0, 120),
        });
      }
    }
  };

  const isConsoleCall = (node) =>
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "console";

  const visit = (node) => {
    if (
      ts.isImportDeclaration(node) ||
      ts.isExportDeclaration(node) ||
      isConsoleCall(node)
    ) {
      return;
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      inspect(node, node.text);
    } else if (
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      inspect(node, node.text);
    } else if (ts.isJsxText(node)) {
      inspect(node, node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

async function walk(directory, skipDirs) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return skipDirs.has(entry.name) ? [] : walk(full, skipDirs);
      }
      return [full];
    }),
  );
  return nested.flat();
}

/**
 * Scan `roots` under `projectRoot` and exit non-zero on any violation that is
 * not allowlisted. `skipFiles` are generated files (relative paths). `allow` entries are `{ file, contains, reason }`: a
 * violation is accepted when its file matches and its string contains
 * `contains` (stable across line moves, unlike `path:line`).
 */
export async function runCopyCheck({
  ts,
  projectRoot,
  roots,
  skipDirs = [],
  skipFiles = [],
  allow = [],
  label,
  scriptPath,
}) {
  const skip = new Set(["node_modules", ...skipDirs]);
  const violations = [];
  const usedAllow = new Set();
  for (const root of roots) {
    const files = await walk(path.join(projectRoot, root), skip);
    for (const file of files) {
      if (!/\.(?:tsx?|mts)$/.test(file) || TEST_FILE_RE.test(file)) continue;
      if (file.endsWith(".d.ts")) continue;
      const rel = path.relative(projectRoot, file).split(path.sep).join("/");
      if (skipFiles.includes(rel)) continue;
      const text = await fs.readFile(file, "utf8");
      for (const v of findCopyViolations(ts, rel, text)) {
        const entry = allow.find(
          (a) => a.file === rel && v.snippet.includes(a.contains),
        );
        if (entry) {
          usedAllow.add(entry);
          continue;
        }
        violations.push({ file: rel, ...v });
      }
    }
  }

  const stale = allow.filter((a) => !usedAllow.has(a));
  if (violations.length === 0 && stale.length === 0) {
    console.log(`${label} copy check passed.`);
    return;
  }
  if (violations.length > 0) {
    console.error(`${label} copy check failed (${scriptPath}):`);
    for (const v of violations) {
      console.error(`- ${v.file}:${v.line} [${v.rule}] ${v.why}\n    "${v.snippet}"`);
    }
    console.error(
      "Rewrite the text in plain words, or move the detail into a collapsed " +
        '"Technical details" section and allowlist that one string with a reason.',
    );
  }
  if (stale.length > 0) {
    console.error(`${label} copy check: allowlist entries that no longer match:`);
    for (const a of stale) console.error(`- ${a.file}: "${a.contains}"`);
  }
  process.exitCode = 1;
}
