import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

function git(args, cwd, options = {}) {
  // Git hooks export repository-local GIT_* variables. Child commands that
  // intentionally target `cwd` must not be redirected back to the hook's repo.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    env,
    ...options,
  });
}

function toPosixPath(relativePath) {
  return relativePath.split(path.sep).join("/");
}

export function countLines(content) {
  if (content.length === 0) {
    return 0;
  }
  return content.split(/\r?\n/).length;
}

export function allowedLineCount(baseLines, maxLines) {
  return baseLines == null || baseLines <= maxLines ? maxLines : baseLines;
}

export function evaluateFileSize({ baseLines, candidateLines, maxLines }) {
  const limit = allowedLineCount(baseLines, maxLines);
  return { limit, violates: candidateLines > limit };
}

function findRule(rules, relativePath) {
  return rules.find((rule) => relativePath.startsWith(`${rule.root}/`));
}

// Remote branches whose merge-base with HEAD can serve as the ratchet's base,
// in order. `origin/lite` covers the lite branch, which shares no history with
// `origin/main`.
const BASE_CANDIDATES = ["origin/main", "origin/lite"];

function mergeBaseWith(repoRoot, ref) {
  try {
    return git(["merge-base", ref, "HEAD"], repoRoot, {
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // The ref is missing, or it shares no history with HEAD.
    return null;
  }
}

/**
 * Pick the commit the ratchet compares against and say which rule picked it.
 * In order: CHECK_FILE_SIZES_BASE; HEAD^1 on GitHub Actions; the merge-base
 * with origin/main, then origin/lite, when that ref shares history with HEAD;
 * finally HEAD^1.
 */
export function resolveBase(repoRoot, env = process.env) {
  if (env.CHECK_FILE_SIZES_BASE) {
    return {
      ref: env.CHECK_FILE_SIZES_BASE,
      description: "CHECK_FILE_SIZES_BASE",
    };
  }

  if (env.GITHUB_ACTIONS === "true") {
    return { ref: "HEAD^1", description: "HEAD^1 (GitHub Actions)" };
  }

  const head = git(["rev-parse", "HEAD"], repoRoot).trim();
  for (const candidate of BASE_CANDIDATES) {
    const mergeBase = mergeBaseWith(repoRoot, candidate);
    if (mergeBase) {
      return {
        ref: mergeBase === head ? "HEAD" : mergeBase,
        description: `merge-base with ${candidate}`,
      };
    }
  }

  try {
    git(["rev-parse", "--verify", "--quiet", "HEAD^1^{commit}"], repoRoot, {
      stdio: ["ignore", "pipe", "ignore"],
    });
    return {
      ref: "HEAD^1",
      description: `HEAD^1, because neither ${BASE_CANDIDATES.join(" nor ")} shares history with HEAD`,
    };
  } catch (error) {
    throw new Error(
      `Could not resolve the file-size base: neither ${BASE_CANDIDATES.join(" nor ")} shares history with HEAD, and HEAD has no parent. Fetch origin or set CHECK_FILE_SIZES_BASE to an explicit commit.`,
      { cause: error },
    );
  }
}

export function resolveBaseRef(repoRoot, env = process.env) {
  return resolveBase(repoRoot, env).ref;
}

export function parseChangedFiles(output) {
  const fields = output.split("\0");
  const changes = [];

  for (let index = 0; index < fields.length - 1; ) {
    const status = fields[index++];
    if (status.startsWith("R") || status.startsWith("C")) {
      changes.push({
        status: status[0],
        oldPath: fields[index++],
        path: fields[index++],
      });
    } else {
      changes.push({ status: status[0], path: fields[index++] });
    }
  }

  return changes;
}

function changedProjectFiles({ repoRoot, projectRelative, baseRef }) {
  const output = git(
    ["diff", "--name-status", "-z", "-M", baseRef, "--", projectRelative],
    repoRoot,
  );
  const changes = parseChangedFiles(output);
  const trackedPaths = new Set(changes.map((change) => change.path));
  const untracked = git(
    ["ls-files", "--others", "--exclude-standard", "-z", "--", projectRelative],
    repoRoot,
  )
    .split("\0")
    .filter(Boolean);

  for (const filePath of untracked) {
    if (!trackedPaths.has(filePath)) {
      changes.push({ status: "A", path: filePath });
    }
  }
  return changes;
}

function readBaseFile(repoRoot, baseRef, filePath) {
  return git(["show", `${baseRef}:${filePath}`], repoRoot, {
    encoding: null,
  }).toString("utf8");
}

export async function runFileSizeCheck({ projectRoot, rules, label }) {
  // Every governed project is a direct child of the repository root. Derive
  // these paths without Git so hook-provided repository environment variables
  // cannot collapse the project pathspec to an empty string.
  const repoRoot = path.dirname(projectRoot);
  const projectRelative = toPosixPath(path.basename(projectRoot));
  const { ref: baseRef, description: baseDescription } = resolveBase(repoRoot);
  console.log(`${label} file size base: ${baseRef} (${baseDescription})`);

  // Fail clearly instead of silently turning a missing/shallow base into a pass.
  git(["cat-file", "-e", `${baseRef}^{commit}`], repoRoot);

  const violations = [];
  for (const change of changedProjectFiles({
    repoRoot,
    projectRelative,
    baseRef,
  })) {
    if (change.status === "D") continue;

    const relativePath = toPosixPath(
      path.relative(projectRelative, change.path),
    );
    const rule = findRule(rules, relativePath);
    if (!rule || !rule.extensions.has(path.extname(relativePath))) continue;

    const candidatePath = path.join(repoRoot, change.path);
    const candidateLines = countLines(await fs.readFile(candidatePath, "utf8"));
    const basePath = change.oldPath ?? change.path;
    const baseContent =
      change.status === "A" ? null : readBaseFile(repoRoot, baseRef, basePath);
    const baseLines = baseContent == null ? null : countLines(baseContent);
    const result = evaluateFileSize({
      baseLines,
      candidateLines,
      maxLines: rule.maxLines,
    });

    if (result.violates) {
      violations.push({
        relativePath,
        baseLines,
        candidateLines,
        limit: result.limit,
      });
    }
  }

  if (violations.length === 0) return;

  console.error(`${label} file size ratchet failed (base ${baseRef}, ${baseDescription}):`);
  for (const violation of violations) {
    const before = violation.baseLines == null ? "new" : violation.baseLines;
    const delta =
      violation.baseLines == null
        ? ""
        : ` (${violation.candidateLines - violation.baseLines >= 0 ? "+" : ""}${violation.candidateLines - violation.baseLines})`;
    console.error(
      `- ${violation.relativePath}: ${before} -> ${violation.candidateLines}${delta} lines (allowed ${violation.limit})`,
    );
  }
  console.error(
    "Keep new files at or below the limit; files already over it may not grow.",
  );
  process.exitCode = 1;
}
