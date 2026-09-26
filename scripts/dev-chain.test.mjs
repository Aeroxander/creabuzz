/**
 * Tests for `scripts/dev-chain.sh` — the plan, the idempotency annotations,
 * and the refusal paths. No chain is booted and nothing is deployed: the
 * exercised seams are `--dry-run` (the plan the real run follows), the
 * loopback guard, and the honest "port already occupied" error.
 *
 * Falsifiability: drop a step from the plan, delete the occupied-port message,
 * let the script write its pid file during a dry run, or answer the RPC port
 * with a non-anvil service without failing — one of the assertions below goes
 * red. The real deploy/idempotency behavior is verified by running
 * `just dev-chain` twice (see the recipe's header).
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./dev-chain.sh", import.meta.url));
/** A loopback port nothing listens on (high, non-standard, unlikely in use). */
const DEAD_RPC = "http://127.0.0.1:59876";

function run(args, env = {}) {
  return spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 120_000,
  });
}

function tempStateDir() {
  return mkdtempSync(path.join(tmpdir(), "dev-chain-test-"));
}

/** Anvil's well-known dev accounts, derived from the script's keys. */
const FOUNDER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const BUYER1 = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const BUYER2 = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

test("dry-run prints the ordered plan and touches no state", () => {
  const state = tempStateDir();
  try {
    const result = run(["--dry-run"], {
      RPC_URL: DEAD_RPC,
      STATE_DIR: state,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const out = result.stdout;

    assert.match(out, /dry run — nothing started, nothing deployed/);
    assert.match(out, /NOT RUNNING/);

    // The six steps, in execution order — dropping or reordering one fails.
    const steps = [
      "1. anvil",
      "2. apptoken infra",
      "3. org dao",
      "4. currency",
      "5. fund",
      "6. accounts",
    ];
    let cursor = -1;
    for (const step of steps) {
      const at = out.indexOf(step);
      assert.ok(at > cursor, `plan step out of order or missing: "${step}"`);
      cursor = at;
    }

    // Idempotency guards are part of the plan, not folklore.
    assert.match(out, /idempotent/);
    assert.match(out, /skipped: a dev anvil already answers/);
    assert.match(out, /names an OrgBinding that still has code/);
    assert.match(out, /names a token that still has code/);

    // Dev accounts: right roles, right (derived) addresses, keys labeled.
    assert.match(out, /DEV-ONLY ACCOUNTS/);
    assert.match(out, /PRIVATE KEY \(DEV ONLY\)/);
    assert.match(out, /DEV ONLY/);
    assert.match(out, new RegExp(FOUNDER, "i"));
    assert.match(out, new RegExp(BUYER1, "i"));
    assert.match(out, new RegExp(BUYER2, "i"));
    for (const role of ["founder", "buyer1", "buyer2"]) {
      assert.match(out, new RegExp(`^${role}\\s`, "m"), `missing role ${role}`);
    }
    // anvil key 0 (the deployer) is printed so a wallet can import it.
    assert.match(
      out,
      /0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80/i,
    );

    // Side-effect free: no pid file, no anvil log, nothing created.
    assert.equal(existsSync(path.join(state, "anvil.pid")), false);
    assert.deepEqual(
      readdirSync(state),
      [],
      "dry-run wrote into STATE_DIR",
    );
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

test("dry-run output is stable across runs (a plan, not a stream)", () => {
  const state = tempStateDir();
  try {
    const first = run(["--dry-run"], { RPC_URL: DEAD_RPC, STATE_DIR: state });
    const second = run(["--dry-run"], { RPC_URL: DEAD_RPC, STATE_DIR: state });
    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(first.stdout, second.stdout);
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

test("up refuses a non-loopback RPC URL before doing anything", () => {
  const state = tempStateDir();
  try {
    const result = run(["up"], {
      RPC_URL: "https://example.com:8545",
      STATE_DIR: state,
    });
    assert.notEqual(result.status, 0, "a non-loopback URL must not be allowed");
    assert.match(result.stderr, /REFUSING/);
    assert.match(result.stderr, /loopback/);
    assert.match(result.stderr, /NEVER a real network/);
    assert.equal(existsSync(path.join(state, "anvil.pid")), false);
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

test("up fails honestly when the RPC port is already occupied", async () => {
  const state = tempStateDir();
  // A plain TCP service that is NOT a JSON-RPC node: accepting connections,
  // answering nothing.
  const server = net.createServer((socket) => socket.destroy());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const result = run(["up"], {
      RPC_URL: `http://127.0.0.1:${port}`,
      STATE_DIR: state,
    });
    assert.notEqual(result.status, 0, "an occupied port must not be a success");
    const output = `${result.stdout}\n${result.stderr}`;
    assert.match(output, /something is already listening/);
    assert.match(output, /dev-chain didn't start/);
    assert.match(output, /anvil with the infra loaded/);
    assert.match(output, /just dev-chain-status/);
    // It refused instead of adopting the foreign service: no pid file, and
    // the listener is still the process that owns the port.
    assert.equal(existsSync(path.join(state, "anvil.pid")), false);
    assert.equal(server.listening, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(state, { recursive: true, force: true });
  }
});

test("status on a stopped chain reports honestly and exits 0", () => {
  const state = tempStateDir();
  try {
    const result = run(["status"], { RPC_URL: DEAD_RPC, STATE_DIR: state });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /dev-chain status/);
    assert.match(result.stdout, /NOT RUNNING/);
    assert.match(result.stdout, /start it with: just dev-chain/);
    // The manifests are still read — the record outlives the process.
    assert.match(result.stdout, /deployments/);
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

test("down with no pid file stops nothing and says so", () => {
  const state = tempStateDir();
  try {
    const result = run(["down"], { RPC_URL: DEAD_RPC, STATE_DIR: state });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /nothing to stop/);
    assert.equal(existsSync(path.join(state, "anvil.pid")), false);
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});
