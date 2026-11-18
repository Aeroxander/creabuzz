import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FAKE = new URL("./fake-prime.mjs", import.meta.url).pathname;

/**
 * Build an executable `prime-agent` stand-in: a shell script that execs
 * `node fake-prime.mjs` with whatever extra env the test needs. Mirrors how
 * production resolves the binary (a command on PATH invoked with
 * `--mode rpc ...`), so tests bind the real spawn path.
 */
export function makePrimeCommand(extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), "prime-exec-"));
  const path = join(dir, "prime-agent");
  const exports = Object.entries(extraEnv)
    .map(([k, v]) => `export ${k}="${v}"`)
    .join("\n");
  writeFileSync(
    path,
    `#!/bin/sh\n${exports ? `${exports}\n` : ""}exec ${process.execPath} ${FAKE} "$@"\n`,
  );
  chmodSync(path, 0o755);
  return path;
}
