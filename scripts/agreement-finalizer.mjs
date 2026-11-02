#!/usr/bin/env node
/**
 * Agreement finalizer — durable operator worker CLI (Phase C).
 *
 * Thin argument shell over scripts/agreement-finalizer-lib.mjs. All safety
 * rules live in the library (documented there); this file only parses
 * arguments, chooses a command, and maps failures to exit codes:
 *
 *   0  every job ended `confirmed` (verified onchain at depth, effects exact)
 *   1  usage / argument error (nothing was written)
 *   2  jobs still in flight (queued / prepared / submitted — never a success)
 *   3  journal lock refused (another live worker, or a stale holder without
 *      the explicit --reclaim flag)
 *   4  environment changed (chain reset / different node vs. journal binding)
 *   5  at least one `observed-mismatch` (manual reconcile required)
 *   6  at least one `failed` (manual --retry required; retry keeps records)
 *   7  at least one `blocked` (conditions not met — re-run when they are)
 *   8  the run list mentioned no job (nothing processed)
 *
 * Exit code 0 is the ONLY "success" — and it requires every job to have a
 * receipt at the configured depth whose expected chain effects (derived from
 * the onchain record, and verified against the known mint logs) matched.
 *
 * Requires the repo's hermit toolchain (`node` v22+ for the type-stripped
 * repo imports) and `cast` on PATH for offline signing:
 *
 *   export PATH="$PWD/.hermit/bin:$HOME/.foundry/bin:$PATH"
 *
 * Safety reminders (enforced by the library, restated here for the operator):
 *   - LOOPBACK ANVIL ONLY. The --rpc must be a loopback http URL that answers
 *     anvil_metadata. The worker refuses a public RPC, a non-anvil node, and
 *     any environment reset (journal fingerprint).
 *   - Writes require --opt-in-fixture-writes AND --fixture-key, where the key
 *     must derive to one of the well-known anvil dev accounts. No .env
 *     sourcing, no stored wallets, no key material in the journal or logs.
 *   - Only two calls are ever signed: ClaimStake.settle(claimId) (to START a
 *     verified challenge window — never into an objection quorum, which
 *     would slash) and Moloch.settleAgreement(mandate, agreementId) (exact
 *     accepted terms; recipients/amounts derived from the onchain record,
 *     never chosen here).
 *   - Journal is atomic, single-worker locked, keeps failed/blocked/mismatch
 *     records; recovery commands: --retry (failed/blocked), --reconcile
 *     (submitted/observed-mismatch), and a fresh journal for a new chain.
 *
 * Example:
 *
 *   node scripts/agreement-finalizer.mjs run \
 *     --journal ./.finalizer-journal \
 *     --rpc http://127.0.0.1:8545 \
 *     --opt-in-fixture-writes \
 *     --fixture-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
 *     --job chain=31337,dao=0xAaa…,mandate=0xBbb…,agreement=0x‌ccc…,action=start-window
 */
import {
  parseJobSpec,
  runFinalizer,
  retryJob,
  statusJournal,
  describeJobIdentity,
  executeReconcile,
} from "./agreement-finalizer-lib.mjs";

const CLI_HELP = `
agreement-finalizer — durable agreement settlement worker (loopback-anvil fixtures only)

USAGE

  run       Contracts the operator's bounded job list, reads the environment
            and provenance fresh per step, then either signs+broadcasts or
            reconciles an in-flight tx, with a bounded watch.
  status    Print journal summary (no RPC, no signing).
  retry     Manual recovery: re-queue a failed/blocked job (nothing deleted;
            the same prepared raw is reused if it is still on disk).
  reconcile Manual recovery: re-verify effects of a submitted/mismatched job.

COMMON OPTIONS

  --journal DIR                 required journal directory (mode 0700)
  --rpc  URL                    a loopback http-only anvil URL that answers
                                anvil_metadata; the worker never falls back
  --opt-in-fixture-writes       explicit opt-in: writes only happen against an
                                operator-declared local scratch-anvil fixture
  --fixture-key HEX             the explicit well-known anvil dev private key
                                (validated; never logged; never journaled)
  --confirm-depth N             required confirmations (default 1)
  --watch [SECONDS] [--watch-interval-ms MS]
                                bounded watch (no daemon); default 120 s / 2 s
  --attempts N --backoff-ms M   bounded broadcast retries + backoff
  --reclaim                     accept a dead holder's lock explicitly

JOB SPEC (one per --job; min 1; the whole work list is what the operator typed)

  chain=<decimal>  the bound chain id (must equal the live one)
  dao=<0x…20>      the Moloch DAO address that owns the mandate
  mandate=<0x…20>  the TreasuryMandate that holds the agreement record
  agreement=<0x…32> the agreement bytes32 id on the mandate
  action=start-window   → the worker signs ClaimStake.settle(claimId)
  action=settle-agreement → the worker signs Moloch.settleAgreement(mandate, agreementId)

EXAMPLES

  node scripts/agreement-finalizer.mjs status --journal ./.finalizer-journal
  node scripts/agreement-finalizer.mjs retry --journal ./.finalizer-journal \\
      --job chain=31337,dao=0x…,mandate=0x…,agreement=0x…,action=start-window
`;

function usage(msg) {
  process.stderr.write(`agreement-finalizer: ${msg}\n\n${CLI_HELP}\n`);
  return 1;
}

export function parseArgs(argv) {
  const opts = { jobs: [], watch: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      const value = argv[i];
      if (value == null || value.startsWith("--")) {
        throw new Error(`--${arg.replace(/^--/, "")} requires a value`);
      }
      return value;
    };
    if (arg === "--help" || arg === "-h") {
      opts.help = true;
    } else if (arg === "--journal") {
      opts.journalDir = next();
    } else if (arg === "--rpc") {
      opts.rpcUrl = next();
    } else if (arg === "--opt-in-fixture-writes") {
      opts.optInFixtureWrites = true;
    } else if (arg === "--fixture-key") {
      opts.fixtureKey = next();
    } else if (arg === "--confirm-depth") {
      const value = next();
      if (!/^\d+$/.test(value)) throw new Error(`--confirm-depth expects an integer, got '${value}'`);
      opts.confirmDepth = Number(value);
    } else if (arg === "--watch") {
      opts.watch = true;
      // An optional seconds value: --watch 300 (not the same as the next --flag).
      if (argv[i + 1] != null && /^\d+$/.test(argv[i + 1])) {
        const seconds = Number(next());
        opts.watchTimeoutMs = seconds * 1000;
      }
    } else if (arg === "--watch-interval-ms") {
      const value = next();
      if (!/^\d+$/.test(value)) throw new Error(`--watch-interval-ms expects an integer, got '${value}'`);
      opts.watchIntervalMs = Number(value);
    } else if (arg === "--attempts") {
      const value = next();
      if (!/^\d+$/.test(value)) throw new Error(`--attempts expects an integer, got '${value}'`);
      opts.maxAttempts = Number(value);
    } else if (arg === "--backoff-ms") {
      const value = next();
      if (!/^\d+$/.test(value)) throw new Error(`--backoff-ms expects an integer, got '${value}'`);
      opts.backoffBaseMs = Number(value);
    } else if (arg === "--reclaim") {
      opts.reclaim = true;
    } else if (arg === "--job") {
      opts.jobs.push(parseJobSpec(next()));
    } else {
      positional.push(arg);
    }
  }
  if (positional.length > 1) throw new Error(`unexpected extra arguments: ${positional.join(" ")}`);
  opts.command = positional[0];
  return opts;
}

function requireJournal(opts) {
  if (!opts.journalDir) {
    throw new Error("--journal DIR is required for this command");
  }
  return opts.journalDir;
}

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (err) {
    return usage(err.message);
  }
  if (options.help) {
    process.stdout.write(CLI_HELP);
    return 0;
  }
  const logLine = (line) => process.stdout.write(line + "\n");
  try {
    switch (options.command) {
      case "run": {
        if (!options.journalDir) throw new Error("--journal DIR is required for run");
        if (!options.rpcUrl) throw new Error("--rpc URL is required for run");
        const jobs = options.jobs;
        if (jobs.length < 1) throw new Error("run needs exactly the operator's --job list (one or more --job flags)");
        const result = await runFinalizer({ ...options, jobs });
        logLine(`[finalizer] run done; exit code ${result.exitCode}; jobs:`);
        for (const row of result.jobs) {
          logLine(`[finalizer] ${row.state} — ${row.note}`);
        }
        return result.exitCode;
      }
      case "status": {
        const journal = requireJournal(options);
        await statusJournal(journal, { onLog: logLine });
        return 0;
      }
      case "retry": {
        const journal = requireJournal(options);
        if (options.jobs.length !== 1) throw new Error("retry takes exactly one --job spec");
        const identity = options.jobs[0];
        const outcome = await retryJob(journal, identity, { onLog: logLine });
        logLine(`[finalizer] retry: ${describeJobIdentity(identity)} → ${outcome.state}`);
        return 0;
      }
      case "reconcile": {
        const journal = requireJournal(options);
        if (!options.rpcUrl) throw new Error("--rpc URL is required for reconcile");
        if (options.jobs.length !== 1) throw new Error("reconcile takes exactly one --job spec");
        const identity = options.jobs[0];
        const outcome = await executeReconcile(journal, identity, {
          rpcUrl: options.rpcUrl,
          onLog: logLine,
          reuseDefaultConfirmDepth: options.confirmDepth,
        });
        logLine(`[finalizer] reconcile: ${describeJobIdentity(identity)} → ${outcome.state || "?"}`);
        return outcome.exitCode ?? 0;
      }
      case "":
        return usage("a command is required (run | status | retry | reconcile)");
      default:
        return usage(`unknown command '${options.command}' (expected run | status | retry | reconcile)`);
    }
  } catch (err) {
    if (err?.__exit) {
      process.stderr.write(`escellRefused: ${err.message}\n`);
      return err.__exit;
    }
    if (typeof err?.message === "string") {
      process.stderr.write(`agreement-finalizer refused: ${err.message}\n`);
    } else {
      process.stderr.write(`agreement-finalizer refused: unexpected error\n`);
    }
    return mapFailureToExcode(err);
  }
}

function mapFailureToExcode(err) {
  if (err && String(err?.constructor?.name).includes("UsageError")) {
    return 1;
  }
  if (err && String(err?.constructor?.name).includes("Lock")) {
    return 3;
  }
  if (err && String(err?.constructor?.name).includes("EnvironmentChanged")) {
    return 4;
  }
  if (err && String(err?.constructor?.name).includes("BlockedJob")) {
    return 7;
  }
  process.stderr.write(`unhandled error type: ${err?.constructor?.name}\n`);
  return 8;
}

// On executed main:
const isMain = process.argv[1] && process.argv[1].endsWith("agreement-finalizer.mjs");
if (isMain) {
  const code = await main(process.argv.slice(2));
  process.exit(code);
}
