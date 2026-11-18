// The hosted image's web settings are listed three times: the Dockerfile's build arguments, the names it turns from empty
// into unset, and compose.creaton.yml's build args (what .env can reach). A name missing from one of them reaches the build
// as nothing: the journeys build the web app with vite directly and would not notice. These must stay one list, and it
// must hold every setting the build check needs for the contributor-only image.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../../../../../", import.meta.url);
const dockerfile = readFileSync(new URL("Dockerfile", root), "utf8");
const compose = readFileSync(
  new URL("deploy/compose/compose.creaton.yml", root),
  "utf8",
);

const sorted = (names) => [...new Set(names)].sort();

function dockerArgs() {
  return sorted(
    [...dockerfile.matchAll(/^ARG (VITE_[A-Z0-9_]+)=/gm)].map((m) => m[1]),
  );
}

function dockerUnsetLoop() {
  const loop = /for name in ([^;]+); do/.exec(dockerfile);
  assert.ok(loop, "the Dockerfile's loop over the web settings");
  return sorted(loop[1].match(/VITE_[A-Z0-9_]+/g) ?? []);
}

function composeArgs() {
  const args = /\n {6}args:\n((?: {8}.+\n)+)/.exec(compose);
  assert.ok(args, "compose.creaton.yml's build args");
  return sorted(
    [...args[1].matchAll(/^ {8}(VITE_[A-Z0-9_]+):/gm)].map((m) => m[1]),
  );
}

test("the image's web settings are one list in the Dockerfile and in compose", () => {
  const args = dockerArgs();
  assert.ok(args.length > 5, args.join(" "));
  assert.deepEqual(dockerUnsetLoop(), args);
  // compose may leave out what only a build of your own sets (VITE_RELAY_URL: the image is served by its own relay).
  const fromEnv = composeArgs();
  for (const name of fromEnv) {
    assert.ok(
      args.includes(name),
      `${name} is passed by compose but not an ARG`,
    );
  }
  for (const name of args) {
    if (name === "VITE_RELAY_URL") continue;
    assert.ok(
      fromEnv.includes(name),
      `${name} is an ARG that .env cannot reach`,
    );
  }
});

test("everything the contributor-only image needs can reach its build", () => {
  const fromEnv = composeArgs();
  for (const name of [
    "VITE_LAUNCHPAD_CHAIN_ID",
    "VITE_CHAIN_RPC_URL",
    "VITE_CONTRIBUTOR_KITS",
    "VITE_HISTORY_FROM_BLOCKS",
    "VITE_ZERODEV_PROJECT_ID",
    "VITE_ZERODEV_CHAIN_ID",
    "VITE_ERROR_REPORT_URL",
  ]) {
    assert.ok(fromEnv.includes(name), name);
  }
  // The image is contributor-only and runs the build check on that basis.
  assert.match(
    dockerfile,
    /export VITE_CONTRIBUTOR_ONLY=1;[^\n]*\n\s*node --experimental-strip-types web\/scripts\/check-deploy-env\.mjs/,
  );
});
