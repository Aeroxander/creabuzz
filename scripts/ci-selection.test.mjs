import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";

const workflow = readFileSync(
  new URL("../.github/workflows/ci.yml", import.meta.url),
  "utf8",
);
const scratch = mkdtempSync(join(tmpdir(), "buzz-ci-selection-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const actionSha = workflow.match(/uses: dorny\/paths-filter@([a-f0-9]{40})/)[1];
const filters = workflow
  .match(/ {10}filters: \|\n([\s\S]*?)(?= {6}- name:)/)[1]
  .split("\n")
  .map((line) => line.slice(12))
  .join("\n");
// GitHub-hosted runners prepare pinned actions beside RUNNER_TEMP before any
// steps run. Reuse that bundle, without another download in the selection gate.
// Locally, point PATHS_FILTER_ACTION at dist/index.js from the pinned action.
const actionPath =
  process.env.PATHS_FILTER_ACTION ||
  (process.env.RUNNER_TEMP &&
    join(
      process.env.RUNNER_TEMP,
      "..",
      "_actions",
      "dorny",
      "paths-filter",
      actionSha,
      "dist",
      "index.js",
    ));
assert.ok(
  actionPath && existsSync(actionPath),
  `Set PATHS_FILTER_ACTION to the local dist/index.js from dorny/paths-filter@${actionSha}`,
);
async function select(paths, pullRequest = false, apiStatus = 200) {
  const repo = mkdtempSync(join(scratch, "repo-"));
  const git = (...args) =>
    execFileSync("git", args, { cwd: repo, stdio: "pipe", timeout: 10000 });
  git("init", "-q");
  // Fixture repositories must not inherit developer machine hooks.
  mkdirSync(join(repo, "empty-hooks"));
  git("config", "core.hooksPath", join(repo, "empty-hooks"));
  git(
    "-c",
    "user.name=CI fixture",
    "-c",
    "user.email=ci@example.com",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "fixture",
    "-s",
  );
  for (const path of paths) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), "fixture\n");
  }
  git("add", ".");
  let server;
  let apiUrl;
  const eventPath = join(scratch, `event-${repo.split("/").pop()}.json`);
  if (pullRequest) {
    const commit = (message) =>
      git(
        "-c",
        "user.name=CI fixture",
        "-c",
        "user.email=ci@example.com",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-qm",
        message,
        "-s",
      );
    const base = git("rev-parse", "HEAD").toString().trim();
    commit("PR documentation or code");
    const head = git("rev-parse", "HEAD").toString().trim();
    git("checkout", "-qb", "upstream", base);
    const upstreamPath = "app/src/upstream-only.ts";
    mkdirSync(dirname(join(repo, upstreamPath)), { recursive: true });
    writeFileSync(join(repo, upstreamPath), "upstream change\n");
    git("add", upstreamPath);
    commit("Unrelated upstream app change");
    git(
      "-c",
      "user.name=CI fixture",
      "-c",
      "user.email=ci@example.com",
      "-c",
      "commit.gpgsign=false",
      "merge",
      "--no-ff",
      "-m",
      "Synthetic merge",
      head,
    );
    git("checkout", "--detach");
    writeFileSync(
      eventPath,
      JSON.stringify({
        pull_request: {
          number: 7809,
          changed_files: paths.length,
          base: { sha: base },
          head: { sha: head },
        },
        repository: { default_branch: "main" },
      }),
    );
    // Serve the PR file list, which intentionally excludes the newer base's code.
    server = createServer((request, response) => {
      assert.equal(
        request.url,
        "/repos/block/buzz/pulls/7809/files?per_page=100",
      );
      response.setHeader("Content-Type", "application/json");
      if (apiStatus !== 200) {
        response.writeHead(apiStatus);
        response.end(JSON.stringify({ message: "Fixture access denied" }));
        return;
      }
      response.end(
        JSON.stringify(
          paths
            .slice(0, 3000)
            .map((filename) => ({ filename, status: "added" })),
        ),
      );
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    apiUrl = `http://127.0.0.1:${server.address().port}`;
  }
  const output = join(repo, "action-output");
  writeFileSync(output, "");
  try {
    await promisify(execFile)(process.execPath, [actionPath], {
      cwd: repo,
      encoding: "utf8",
      timeout: 30000,
      env: {
        ...process.env,
        INPUT_BASE: pullRequest ? "" : "HEAD",
        INPUT_FILTERS: filters,
        // Resolve the workflow's token expression to a fixture token. Removing
        // it must reproduce the contaminated git comparison in the PR fixture.
        INPUT_TOKEN:
          pullRequest && /token: \$\{\{ github\.token \}\}/.test(workflow)
            ? "fixture-token"
            : "",
        INPUT_REF: "",
        GITHUB_EVENT_NAME: pullRequest ? "pull_request" : "",
        GITHUB_EVENT_PATH: pullRequest ? eventPath : "",
        GITHUB_REPOSITORY: "block/buzz",
        GITHUB_API_URL: apiUrl || "https://api.github.com",
        GITHUB_OUTPUT: output,
        "INPUT_PREDICATE-QUANTIFIER":
          workflow.match(/predicate-quantifier: ['"]?([\w-]+)/)?.[1] ?? "some",
      },
    });
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
  }
  const rawOutputs = Object.fromEntries(
    [
      ...readFileSync(output, "utf8").matchAll(
        /^(rust|app|pot)<<([^\n]+)\n(true|false)\n\2/gm,
      ),
    ].map(([, key, , value]) => [key, value]),
  );
  const selectedOutput = join(repo, "selected-output");
  await promisify(execFile)(
    process.execPath,
    [new URL("./ci-runtime-selection.mjs", import.meta.url).pathname],
    {
      env: {
        ...process.env,
        FILTER_OUTPUTS: JSON.stringify(rawOutputs),
        GITHUB_EVENT_NAME: pullRequest ? "pull_request" : "push",
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_OUTPUT: selectedOutput,
      },
      timeout: 10000,
    },
  );
  return Object.fromEntries(
    readFileSync(selectedOutput, "utf8")
      .trim()
      .split("\n")
      .map((line) => line.split("=")),
  );
}
const scenarios = [
  ["app source", ["app/src/main.tsx"], ["app"]],
  ["app Markdown", ["app/README.md"], ["app"]],
  ["shared package", ["packages/creaton-core/src/index.ts"], ["app"]],
  ["pnpm lockfile", ["pnpm-lock.yaml"], ["app"]],
  ["deploy bundle", ["deploy/compose/test-app-settings.sh"], ["app"]],
  ["pot contract", ["contracts/pot/src/Pot.sol"], ["pot"]],
  ["pot contract test", ["contracts/pot/test/Pot.t.sol"], ["pot"]],
  ["contract library pin", ["contracts/lib/forge-std/src/Test.sol"], ["pot"]],
  ["solc installer", ["scripts/ensure-solc.sh"], ["pot"]],
  ["pot loop script", ["scripts/pot-app-loop.sh"], ["pot"]],
  ["relay", ["crates/buzz-relay/src/main.rs"], ["rust"]],
  ["migration", ["migrations/123.sql"], ["rust"]],
  ["shared workflow", [".github/workflows/ci.yml"], ["app", "pot", "rust"]],
  ["app workflow", [".github/workflows/_ci-app.yml"], ["app", "pot", "rust"]],
  ["contracts workflow", [".github/workflows/_ci-contracts.yml"], ["pot", "rust"]],
  ["Justfile", ["Justfile"], ["app", "pot", "rust"]],
  ["integration services", ["docker-compose.yml"], ["rust"]],
  ["CI integration images", ["docker-compose.ci.yml"], ["rust"]],
  [
    "mixed app and relay",
    ["app/src/main.tsx", "crates/buzz-core/src/lib.rs"],
    ["app", "rust"],
  ],
  [
    "mixed app and pot",
    ["app/src/main.tsx", "contracts/pot/src/Pot.sol"],
    ["app", "pot"],
  ],
  ["documentation", ["README.md"], []],
  [
    "incident documentation",
    ["CONTEXT.md", "docs/mobile-push-suppression.md", "VISION_MOBILE.md"],
    [],
  ],
  [
    "nested docs directory",
    ["docs/mobile/design.md", "docs/nips/NIP-FI.md"],
    [],
  ],
  ["crate Markdown", ["crates/buzz-cli/README.md"], ["rust"]],
  ["pot Markdown", ["contracts/pot/README.md"], ["pot"]],
  ["schema Markdown", ["schema/README.md"], ["rust"]],
  ["migration Markdown", ["migrations/README.md"], ["rust"]],
  [
    "mixed documentation and app",
    ["VISION_MOBILE.md", "docs/mobile/design.md", "app/src/main.tsx"],
    ["app"],
  ],
  [
    "mixed documentation and relay",
    ["docs/design.md", "crates/buzz-relay/src/lib.rs"],
    ["rust"],
  ],
  ["embedded ACP prompt", ["crates/buzz-acp/src/base_prompt.md"], ["rust"]],
  // Removed surfaces select nothing: no suite runs for a path that no longer has one.
  ["removed desktop path", ["desktop/src/main.tsx"], []],
  ["removed web path", ["web/src/main.tsx"], []],
  ["removed mobile path", ["mobile/lib/main.dart"], []],
];
for (const [name, paths, expected] of scenarios) {
  test(`real paths-filter: ${name}`, async () => {
    const outputs = await select(paths);
    assert.equal(Object.keys(outputs).length, 3);
    assert.deepEqual(
      Object.keys(outputs)
        .filter((key) => outputs[key] === "true")
        .sort(),
      expected.sort(),
    );
  });
}

for (const [name, paths, expected] of [
  [
    "docs-only",
    ["CONTEXT.md", "docs/mobile-push-suppression.md", "VISION_MOBILE.md"],
    [],
  ],
  [
    "mixed app and Markdown",
    ["CONTEXT.md", "app/src/main.tsx"],
    ["app"],
  ],
  [
    "mixed pot and Markdown",
    ["VISION_MOBILE.md", "contracts/pot/src/Pot.sol"],
    ["pot"],
  ],
]) {
  test(`PR file list ignores newer base changes: ${name}`, async () => {
    const outputs = await select(paths, true);
    assert.equal(Object.keys(outputs).length, 3);
    assert.deepEqual(
      Object.keys(outputs)
        .filter((key) => outputs[key] === "true")
        .sort(),
      expected.sort(),
    );
  });
}

test("workflow consumes guarded selection outputs", () => {
  const outputs = workflow.match(/ {4}outputs:\n([\s\S]*?) {4}steps:/)[1];
  for (const key of ["rust", "app", "pot"]) {
    assert.ok(outputs.includes(`steps.selection.outputs.${key}`));
  }
  assert.match(
    workflow,
    /id: selection\n {8}env:\n {10}FILTER_OUTPUTS: \$\{\{ toJSON\(steps.filter.outputs\) \}\}\n {8}run: node scripts\/ci-runtime-selection.mjs/,
  );
});
for (const count of [2999, 3000, 3001]) {
  test(`PR file-list ceiling: ${count} changed files`, async () => {
    const paths = Array.from(
      { length: Math.min(count, 3000) },
      (_, i) => `docs/file-${i}.md`,
    );
    if (count > 3000) paths.push("app/src/omitted-by-api.ts");
    const outputs = await select(paths, true);
    for (const value of Object.values(outputs)) {
      assert.equal(value, count >= 3000 ? "true" : "false");
    }
  });
}

test("PR API denial fails path selection instead of reporting no changes", async () => {
  await assert.rejects(select(["README.md"], true, 403), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stdout + error.stderr, /Fixture access denied/);
    return true;
  });
});
