#!/usr/bin/env node
/**
 * Hermetic wrapper for desktop Playwright e2e runs.
 *
 * Closes the cross-test asset-staleness class by giving every run its own
 * immutable build output and its own TCP port:
 *
 *  1. Picks a free port unique to this run (4311–4499). The legacy shared
 *     port 4173 is deliberately avoided — it is claimed by the `web/`
 *     Playwright suite (`vite preview`), the `just desktop-screenshot`
 *     python server, and `playwright.perf.config.ts`, and the old
 *     `reuseExistingServer: !CI` semantics silently reused whichever of
 *     those answered first, so a desktop run could execute the *web* bundle
 *     (the phantom `assets/ReposPage-*.js` chunk — a file that only exists
 *     in `web/dist`, never in `desktop/`).
 *  2. Builds into an immutable per-run directory `.e2e-dist/<runId>` so a
 *     concurrent build against the shared `dist/` (parallel workers run
 *     `pnpm build`/`pnpm build:e2e` in the same checkout) can never swap
 *     chunks under a running suite. `dist` is only emptied by `vite build`
 *     (emptyOutDir default), so a mid-run rebuild also transiently 404s —
 *     impossible against a frozen run dir.
 *  3. Reaps orphaned `e2e-static-server.mjs` processes left by killed runs
 *     (their owning Playwright tree is dead but they keep squatting a port
 *     from the range) before picking this run's port — a fresh run replaces a
 *     stale server instead of leaking ports. If a chosen port is taken anyway,
 *     `reuseExistingServer: false` makes Playwright fail with a clear "port is
 *     already used" rather than serving someone else's build.
 *  4. Prunes `.e2e-dist/` entries older than 2h (bounded disk; active
 *     concurrent runs are always younger than that).
 *  5. Runs `playwright test` with `BUZZ_E2E_PORT`/`BUZZ_E2E_DIST` exported
 *     (see `playwright.config.ts` and `scripts/e2e-static-server.mjs`),
 *     then reports phase wall times.
 *
 * Usage (mirrors the previous `pnpm build:e2e && playwright test` chain):
 *
 *     node scripts/e2e-run.mjs --project=smoke [extra playwright args…]
 */
import { execFile, spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DESKTOP_DIR = path.dirname(
  fileURLToPath(new URL("../package.json", import.meta.url)),
);
const RUN_ROOT = path.join(DESKTOP_DIR, ".e2e-dist");
const PORT_MIN = 4311;
const PORT_MAX = 4499;
const PRUNE_AGE_MS = 2 * 60 * 60 * 1000; // keep run dirs for 2h

function log(msg) {
  console.log(`[e2e-run] ${msg}`);
}

function run(cmd, args, env) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: DESKTOP_DIR,
      stdio: "inherit",
      env: { ...process.env, ...env },
    });
    child.on("error", (err) => {
      console.error(`[e2e-run] failed to start ${cmd}: ${err.message}`);
      resolve(127);
    });
    child.on("exit", (code, signal) => {
      resolve(signal ? 1 : (code ?? 1));
    });
  });
}

async function portIsFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

async function pickPort() {
  const span = PORT_MAX - PORT_MIN + 1;
  const start = PORT_MIN + Math.floor(Math.random() * span);
  for (let i = 0; i < span; i++) {
    const port = PORT_MIN + ((start - PORT_MIN + i) % span);
    if (await portIsFree(port)) return port;
  }
  throw new Error(
    `no free port in ${PORT_MIN}-${PORT_MAX}; a previous run may be squatting one (lsof -iTCP:${PORT_MIN}-${PORT_MAX} -sTCP:LISTEN)`,
  );
}

async function pruneOldRuns() {
  let entries = [];
  try {
    entries = await fs.readdir(RUN_ROOT);
  } catch {
    return; // nothing to prune yet
  }
  const now = Date.now();
  for (const entry of entries) {
    const full = path.join(RUN_ROOT, entry);
    try {
      const stat = await fs.stat(full);
      if (now - stat.mtimeMs > PRUNE_AGE_MS) {
        await fs.rm(full, { recursive: true, force: true });
        log(`pruned stale run dir ${path.relative(DESKTOP_DIR, full)}`);
      }
    } catch {
      // A concurrent run may be touching this dir; skip it.
    }
  }
}

/**
 * Snapshot every live process as `pid -> { pid, ppid, command }`.
 * Returns null when `ps` is unavailable (then reaping is skipped).
 */
async function psSnapshot() {
  try {
    const { stdout } = await execFileAsync(
      "ps",
      ["-Ao", "pid=,ppid=,command="],
      {
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    const byPid = new Map();
    for (const line of stdout.split("\n")) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
      if (m) {
        const pid = Number(m[1]);
        byPid.set(pid, { pid, ppid: Number(m[2]), command: m[3] });
      }
    }
    return byPid;
  } catch {
    return null;
  }
}

/**
 * True when some live ancestor of `proc` (excluding `proc` itself) is a
 * Playwright run or another `e2e-run.mjs` wrapper — i.e. the process tree
 * that owns this static server is still alive, so the server is in active
 * use. Walks the `ps` snapshot up to 40 levels; a missing parent (reaped or
 * reparented to pid 1) ends the walk with "no live run owner".
 */
function hasLiveRunAncestor(proc, byPid) {
  let cur = byPid.get(proc.ppid);
  for (let depth = 0; cur && depth < 40; depth++) {
    if (/(playwright|e2e-run\.mjs)/.test(cur.command)) return true;
    const parent = byPid.get(cur.ppid);
    if (!parent || parent.pid === cur.pid) break; // dead parent or self-cycle
    cur = parent;
  }
  return false;
}

async function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Kill orphaned `e2e-static-server.mjs` processes left behind by killed runs.
 *
 * A run killed with SIGKILL never gets to ask Playwright to stop its
 * `webServer`, so the server survives reparented to pid 1 and keeps squatting
 * a port from the 4311-4499 range forever (one leaked node process + socket per
 * killed run; observed: pid 92105 still serving a run dir hours after its run
 * died). Correctness was already safe — `reuseExistingServer: false` + a
 * per-run port mean an orphan can never be *reused* — but the leak eventually
 * exhausts the port range. So a fresh run reaps orphans before picking a port:
 *
 *   candidate  = listener whose command is `e2e-static-server.mjs`
 *                AND whose cwd is THIS checkout (never another checkout's)
 *   orphan     = no live `playwright`/`e2e-run.mjs` ancestor (its owning run
 *                is dead); an active concurrent run always has one
 *   action      SIGTERM, then SIGKILL after 2s if it ignored SIGTERM
 *
 * Anything that does not match both filters is left alone.
 */
async function reapOrphanServers() {
  if (process.platform === "win32") return; // lsof-based; not applicable
  let listenerPids = null;
  try {
    const { stdout } = await execFileAsync(
      "lsof",
      ["-nP", "-iTCP", "-sTCP:LISTEN", "-t"],
      { maxBuffer: 4 * 1024 * 1024 },
    );
    listenerPids = stdout
      .split(/\s+/)
      .map((s) => Number(s))
      .filter((n) => Number.isInteger(n) && n > 0);
  } catch (err) {
    if (err?.code === "ENOENT") return; // no lsof; skip silently
    listenerPids = listenerPids ?? []; // exit 1 = no listeners at all
  }

  const byPid = await psSnapshot();
  if (!byPid) return;

  for (const pid of listenerPids) {
    const proc = byPid.get(pid);
    if (!proc?.command.includes("e2e-static-server.mjs")) continue;
    // Another checkout runs its own e2e servers; only touch ours.
    let cwd = null;
    try {
      const { stdout } = await execFileAsync("lsof", [
        "-a",
        "-p",
        String(pid),
        "-d",
        "cwd",
        "-Fn",
      ]);
      cwd = stdout
        .split("\n")
        .find((line) => line.startsWith("n"))
        ?.slice(1);
    } catch {
      continue; // can't prove ownership → don't kill
    }
    if (path.resolve(cwd ?? "") !== DESKTOP_DIR) continue;

    if (hasLiveRunAncestor(proc, byPid)) continue; // active concurrent run

    log(`reaping orphaned static server pid=${pid} (owning run is dead)`);
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      continue;
    }
    const deadline = Date.now() + 2000;
    while ((await pidAlive(pid)) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (await pidAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
        log(`pid ${pid} ignored SIGTERM; sent SIGKILL`);
      } catch {
        // exited between the check and the signal
      }
    }
  }
}

async function main() {
  // `pnpm test:e2e:smoke -- spec.ts` forwards a literal `--`; drop it so
  // Playwright sees only real args.
  let playwrightArgs = process.argv.slice(2);
  if (playwrightArgs[0] === "--") playwrightArgs = playwrightArgs.slice(1);
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-pid${process.pid}`;
  const distDir = path.join(RUN_ROOT, runId);

  // Reap orphans first so their ports are reusable (see reapOrphanServers).
  await reapOrphanServers();

  const port = await pickPort();
  await fs.mkdir(distDir, { recursive: true });
  await pruneOldRuns();

  const env = {
    BUZZ_E2E_PORT: String(port),
    BUZZ_E2E_DIST: distDir,
  };
  log(`runId=${runId}`);
  log(`port=${port} dist=${path.relative(DESKTOP_DIR, distDir)}`);

  const totalStart = Date.now();
  const buildStart = Date.now();
  log("build: tsc …");
  let code = await run("pnpm", ["exec", "tsc"], env);
  if (code !== 0) {
    log(`build failed (tsc exit ${code})`);
    process.exit(code);
  }
  log("build: vite build --mode e2e …");
  code = await run(
    "pnpm",
    ["exec", "vite", "build", "--mode", "e2e", "--outDir", distDir],
    env,
  );
  if (code !== 0) {
    log(`build failed (vite exit ${code})`);
    process.exit(code);
  }
  const buildSecs = ((Date.now() - buildStart) / 1000).toFixed(1);
  log(`build done in ${buildSecs}s`);

  const testStart = Date.now();
  code = await run(
    "pnpm",
    ["exec", "playwright", "test", ...playwrightArgs],
    env,
  );
  const testSecs = ((Date.now() - testStart) / 1000).toFixed(1);
  const totalSecs = ((Date.now() - totalStart) / 1000).toFixed(1);
  log(`build=${buildSecs}s test=${testSecs}s total=${totalSecs}s exit=${code}`);
  process.exit(code);
}

// Only run the wrapper when invoked directly; `scripts/e2e-run.test.mjs`
// imports the helpers above without launching a build.
const invokedDirectly =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`[e2e-run] ${err?.stack ?? err}`);
    process.exit(1);
  });
}

export { hasLiveRunAncestor, reapOrphanServers };
