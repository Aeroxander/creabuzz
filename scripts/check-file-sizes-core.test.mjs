import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { policy as appPolicy } from "../app/scripts/check-file-sizes.mjs";
import {
  allowedLineCount,
  countLines,
  evaluateFileSize,
  parseChangedFiles,
  resolveBase,
  resolveBaseRef,
} from "./check-file-sizes-core.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

function git(repo, ...args) {
  // These fixture repositories inherit both hook configuration and Git's
  // repository-local environment when this test runs from pre-push. Isolate
  // them completely so fixture commits cannot recurse into the real checkout.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd: repo,
    encoding: "utf8",
    env,
  }).trim();
}

function createEntrypointFixture({
  surface,
  files,
  lineDelta = 1,
  symlinkEntrypoint = false,
}) {
  const repo = realpathSync(
    mkdtempSync(path.join(tmpdir(), `file-size-${surface}-`)),
  );
  const scriptsDir = path.join(repo, "scripts");
  const surfaceScriptsDir = path.join(repo, surface, "scripts");
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(surfaceScriptsDir, { recursive: true });
  copyFileSync(
    path.join(repoRoot, "scripts/check-file-sizes-core.mjs"),
    path.join(scriptsDir, "check-file-sizes-core.mjs"),
  );
  copyFileSync(
    path.join(repoRoot, surface, "scripts", "check-file-sizes.mjs"),
    path.join(surfaceScriptsDir, "check-file-sizes.mjs"),
  );

  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "base");
  const base = git(repo, "rev-parse", "HEAD");
  git(repo, "switch", "-c", "feature");

  for (const { relativeFile, maxLines } of files) {
    const governedFile = path.join(repo, surface, relativeFile);
    const lineCount = maxLines + lineDelta;
    mkdirSync(path.dirname(governedFile), { recursive: true });
    writeFileSync(governedFile, `${"line\n".repeat(lineCount - 1)}line`);
  }

  const realEntrypointPath = path.join(
    surfaceScriptsDir,
    "check-file-sizes.mjs",
  );
  let entrypointPath = realEntrypointPath;
  if (symlinkEntrypoint) {
    entrypointPath = path.join(repo, `${surface}-file-size-check.mjs`);
    symlinkSync(realEntrypointPath, entrypointPath);
  }
  const result = spawnSync(realpathSync(process.execPath), [entrypointPath], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, CHECK_FILE_SIZES_BASE: base },
  });
  return { result, relativeFiles: files.map(({ relativeFile }) => relativeFile) };
}

function createBaseRepo() {
  const repo = mkdtempSync(path.join(tmpdir(), "file-size-base-"));
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "commit", "--allow-empty", "-m", "base");
  return repo;
}

// A root commit that shares no history with the repository's branches, as
// `origin/main` does on the lite branch.
function unrelatedCommit(repo) {
  const emptyTree = git(repo, "hash-object", "-t", "tree", "/dev/null");
  return git(repo, "commit-tree", emptyTree, "-m", "unrelated root");
}

function addBranchCommits(repo) {
  git(repo, "switch", "-c", "feature");
  git(repo, "commit", "--allow-empty", "-m", "first branch commit");
  git(repo, "commit", "--allow-empty", "-m", "second branch commit");
}

test("the configured base wins over every fallback", () => {
  const repo = createBaseRepo();
  const base = git(repo, "rev-parse", "HEAD");
  git(repo, "update-ref", "refs/remotes/origin/main", base);
  addBranchCommits(repo);

  const resolved = resolveBase(repo, { CHECK_FILE_SIZES_BASE: "some-commit" });
  assert.equal(resolved.ref, "some-commit");
  assert.match(resolved.description, /CHECK_FILE_SIZES_BASE/);
});

test("on GitHub Actions the base is HEAD^1", () => {
  const repo = createBaseRepo();
  addBranchCommits(repo);

  assert.equal(resolveBaseRef(repo, { GITHUB_ACTIONS: "true" }), "HEAD^1");
});

test("local base resolution uses the merge-base with origin/main", () => {
  const repo = createBaseRepo();
  git(repo, "remote", "add", "origin", repo);
  git(repo, "fetch", "origin", "main:refs/remotes/origin/main");
  const base = git(repo, "rev-parse", "HEAD");
  addBranchCommits(repo);

  assert.equal(resolveBaseRef(repo, {}), base);
  assert.match(resolveBase(repo, {}).description, /origin\/main/);
});

test("a base that is HEAD itself resolves to HEAD", () => {
  const repo = createBaseRepo();
  git(repo, "update-ref", "refs/remotes/origin/main", git(repo, "rev-parse", "HEAD"));

  assert.equal(resolveBaseRef(repo, {}), "HEAD");
});

test("origin/main with no shared history falls back to the merge-base with origin/lite", () => {
  const repo = createBaseRepo();
  const base = git(repo, "rev-parse", "HEAD");
  git(repo, "update-ref", "refs/remotes/origin/main", unrelatedCommit(repo));
  git(repo, "update-ref", "refs/remotes/origin/lite", base);
  addBranchCommits(repo);

  const resolved = resolveBase(repo, {});
  assert.equal(resolved.ref, base);
  assert.match(resolved.description, /origin\/lite/);
});

test("a missing origin/main falls back to the merge-base with origin/lite", () => {
  const repo = createBaseRepo();
  const base = git(repo, "rev-parse", "HEAD");
  git(repo, "update-ref", "refs/remotes/origin/lite", base);
  addBranchCommits(repo);

  assert.equal(resolveBaseRef(repo, {}), base);
});

test("with no remote branch sharing history the base is HEAD^1 and says so", () => {
  const repo = createBaseRepo();
  git(repo, "update-ref", "refs/remotes/origin/main", unrelatedCommit(repo));
  addBranchCommits(repo);

  const resolved = resolveBase(repo, {});
  assert.equal(resolved.ref, "HEAD^1");
  assert.match(resolved.description, /HEAD\^1/);
  assert.match(resolved.description, /origin\/main nor origin\/lite/);
});

test("with no shared history and no parent commit the base cannot be resolved", () => {
  const repo = createBaseRepo();

  assert.throws(
    () => resolveBase(repo, {}),
    /Fetch origin or set CHECK_FILE_SIZES_BASE/,
  );
});

const entrypointCases = [
  {
    surface: "app",
    files: [
      { relativeFile: "src/oversized.ts", maxLines: 600 },
      { relativeFile: "src/features/oversized.tsx", maxLines: 600 },
      { relativeFile: "src/styles/oversized.css", maxLines: 600 },
      { relativeFile: "tests/oversized.ts", maxLines: 1000 },
    ],
  },
];

test("surface entrypoints execute every production rule", () => {
  for (const fixture of entrypointCases) {
    const { result, relativeFiles } = createEntrypointFixture(fixture);
    assert.equal(
      result.status,
      1,
      `${fixture.surface} should reject every ceiling + 1: ${result.stderr || result.stdout}`,
    );
    for (const relativeFile of relativeFiles) {
      assert.ok(
        result.stderr.includes(relativeFile),
        `${fixture.surface} should report ${relativeFile}: ${result.stderr}`,
      );
    }
  }
});

test("surface entrypoints execute through symlinked paths", () => {
  for (const fixture of entrypointCases) {
    const { result, relativeFiles } = createEntrypointFixture({
      ...fixture,
      symlinkEntrypoint: true,
    });
    assert.equal(
      result.status,
      1,
      `${fixture.surface} symlink should reject ceiling + 1: ${result.stderr || result.stdout}`,
    );
    for (const relativeFile of relativeFiles) {
      assert.ok(
        result.stderr.includes(relativeFile),
        `${fixture.surface} symlink should report ${relativeFile}: ${result.stderr}`,
      );
    }
  }
});

test("surface entrypoints allow every production rule at its ceiling", () => {
  for (const fixture of entrypointCases) {
    const { result } = createEntrypointFixture({ ...fixture, lineDelta: 0 });
    assert.equal(
      result.status,
      0,
      `${fixture.surface} should allow every ceiling: ${result.stderr || result.stdout}`,
    );
  }
});

test("counts empty, LF, and CRLF content with the existing semantics", () => {
  assert.equal(countLines(""), 0);
  assert.equal(countLines("one\n"), 2);
  assert.equal(countLines("one\r\ntwo"), 2);
});

test("surface entrypoints expose the exact ordered production policies", () => {
  const policies = [
    [
      appPolicy,
      [
        ["src", [".ts", ".tsx", ".css"], 600],
        ["tests", [".ts"], 1000],
      ],
    ],
  ];

  for (const [policy, expectedRules] of policies) {
    const actualRules = policy.rules.map((rule) => [
      rule.root,
      [...rule.extensions],
      rule.maxLines,
    ]);
    assert.deepEqual(
      actualRules,
      expectedRules,
      `${policy.label} production rules`,
    );

    for (const rule of policy.rules) {
      assert.equal(
        evaluateFileSize({
          baseLines: null,
          candidateLines: rule.maxLines,
          maxLines: rule.maxLines,
        }).violates,
        false,
        `${policy.label} ${rule.root} should allow the ceiling`,
      );
      assert.equal(
        evaluateFileSize({
          baseLines: null,
          candidateLines: rule.maxLines + 1,
          maxLines: rule.maxLines,
        }).violates,
        true,
        `${policy.label} ${rule.root} should reject ceiling + 1`,
      );
    }
  }
});

test("new files use the configured ceiling", () => {
  assert.equal(allowedLineCount(null, 1000), 1000);
  assert.deepEqual(
    evaluateFileSize({ baseLines: null, candidateLines: 1000, maxLines: 1000 }),
    {
      limit: 1000,
      violates: false,
    },
  );
  assert.equal(
    evaluateFileSize({ baseLines: null, candidateLines: 1001, maxLines: 1000 })
      .violates,
    true,
  );
});

test("a compliant file may not cross the ceiling", () => {
  assert.equal(
    evaluateFileSize({ baseLines: 996, candidateLines: 1000, maxLines: 1000 })
      .violates,
    false,
  );
  assert.equal(
    evaluateFileSize({ baseLines: 996, candidateLines: 1003, maxLines: 1000 })
      .violates,
    true,
  );
});

test("parses modifications, deletions, and renames from Git's NUL format", () => {
  assert.deepEqual(
    parseChangedFiles(
      "M\0app/src/a.ts\0D\0app/src/b.ts\0R100\0app/src/old.ts\0app/src/new.ts\0",
    ),
    [
      { status: "M", path: "app/src/a.ts" },
      { status: "D", path: "app/src/b.ts" },
      {
        status: "R",
        oldPath: "app/src/old.ts",
        path: "app/src/new.ts",
      },
    ],
  );
});

test("an inherited oversized file may hold or shrink but not grow", () => {
  assert.equal(allowedLineCount(1026, 1000), 1026);
  assert.equal(
    evaluateFileSize({ baseLines: 1026, candidateLines: 1026, maxLines: 1000 })
      .violates,
    false,
  );
  assert.equal(
    evaluateFileSize({ baseLines: 1026, candidateLines: 1001, maxLines: 1000 })
      .violates,
    false,
  );
  assert.equal(
    evaluateFileSize({ baseLines: 1026, candidateLines: 1027, maxLines: 1000 })
      .violates,
    true,
  );
});
