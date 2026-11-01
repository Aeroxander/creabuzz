# The MVP gate in CI

Written 2026-11-01 (outside review A 1.2 and B 9, with the critique's corrections). **Not pushed.** The workflow
[`.github/workflows/mvp-gate.yml`](../../.github/workflows/mvp-gate.yml) exists only on the local branch
`v4-governance-rework` and has never run on GitHub. Pushing the branch or opening a pull request is the owner's call;
any pull request that carries it stays a draft until the owner says otherwise.

A green gate is not the pilot's go-ahead. It does not replace the hand tests in
[PILOT-TEST-GUIDE.md](PILOT-TEST-GUIDE.md): the hosted image itself, a reviewer acting from a passkey account, the name
link on the real server, device recovery, and the restore rehearsal ([RESTORE-REHEARSAL.md](RESTORE-REHEARSAL.md)).

## What the job does

One job, `gate`, on `ubuntu-latest`. It is separate from the Web job (`_ci-clients.yml`, called from `ci.yml`: 15 minutes, no database), because the
gate needs about an hour, databases, a media store, Foundry and browsers.

| When | What it runs | Time limit |
|---|---|---|
| A pull request that changes any path below | `scripts/mvp-gate.sh --pilot` | 120 minutes |
| Nightly, 03:17 UTC | `scripts/mvp-gate.sh --later` | 240 minutes |
| By hand (`workflow_dispatch`) | `pilot`, `later` or `all`, as chosen | 120 (pilot) or 240 |

**Paths that start it**: `web/**`, `packages/**`, the pnpm lock, workspace and patches; `crates/**` (the server, its
storage, auth, media and search, the command line), `Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml`, `.cargo/**`;
`migrations/**` and `schema/**`; `contracts/**` and `.gitmodules`; `scripts/**`; `Dockerfile`, `deploy/**`,
`docker-compose.yml`, `.env.example`, `bin/hermit.hcl`; and the workflow itself.

**Steps, in order** (every command was checked to exist on 2026-11-01):

1. Check out with submodules (`recursive`: the contracts' libraries change kit bytecode when missing).
2. Hermit (`cashapp/activate-hermit`, the same pin as the other lanes): node, pnpm, cargo.
3. `lsof` and the Postgres client from apt, then a check that `node pnpm cargo curl docker lsof openssl psql python3
   shasum` are all there.
4. `scripts/test-mvp-gate.sh`: the runner's own self-test (no chain, browser or database). It fails if any
   `scripts/*-e2e.sh` has no home (below).
5. Foundry (`stable`, as the contracts lane), then `scripts/ensure-solc.sh` (the pinned 0.8.37).
6. `pnpm install --frozen-lockfile`, then `pnpm exec playwright install --with-deps chromium` in `web/`.
7. `cargo build -p buzz-relay -p buzz-cli` (the journeys would build them anyway; this keeps a compile error apart
   from a journey failure). The Rust build cache is saved by the nightly and manual runs and restored by pull
   requests, so only the first run builds cold.
8. `cp .env.example .env`, `docker compose up -d --wait postgres redis minio`, then the one-shot `docker compose run --rm
   minio-init` that makes the `buzz-media` bucket and a check that MinIO is still running afterwards (`docker compose
   up --exit-code-from minio-init` would stop MinIO with it; `scripts/test-mvp-gate.sh` fails if the job goes back to
   that): the same services and credentials `just setup` gives a developer. Each real-server journey
   makes and drops its own database there.
9. `scripts/mvp-gate.sh --pilot` (or `--later`, or the full run), after printing its `--list`.
10. Always, pass or fail: the services' logs into the log folder, every journey's log uploaded as the artifact
    `mvp-gate-<set>-logs` (kept 14 days), and `docker compose down -v` (the gate itself stops each journey's own
    processes and removes its own chain state).

`SEPOLIA_RPC_URL` comes from a repository secret of that name if the owner adds one. Without it the two Sepolia-fork
journeys use their default public node, which can drop a read: one rerun before calling it a bug.

## The journeys

**Pilot set** (`--pilot`, ten): `web-pilot-e2e`, `web-social-hosted-e2e`, `web-invite-only-e2e`,
`web-error-report-e2e`, `cli-no-raise-e2e`, `web-contributor-e2e`, `web-passkey-contributor-e2e`, `web-work-e2e`,
`web-paid-work-e2e`, `web-restricted-holder-e2e`.

Under `--pilot`, `web-contributor-e2e` runs in its contributor-only mode (`PILOT_BUILD=1`, set by the runner since
2026-11-01): the web app is built as the hosted image builds it (`VITE_CONTRIBUTOR_ONLY=1`, no optional feature named),
and `web/tests/e2e/contributor-journey.spec.ts` reads `E2E_PILOT_BUILD`: it expects the pilot's words ("How Shares
work"), checks that the remix fields and card, the "No token sale" chip, the bounty button and the payouts card are
absent, and skips the remix, bounty, payout and CREATE steps. Every other run (`--later` does not include it; the full
run and a journey named by hand do) builds it with the optional features on and plays them, as before.
`scripts/test-mvp-gate.sh` checks both.

`web-restricted-holder-e2e` boots a real server (its own scratch database, a free port) serving the pilot build and a
dev chain, and runs two specs against it: `web/tests/e2e-real/restricted-holder.spec.ts` (a muted, then banned, holder
keeps reading evidence, voting and leaving with `buzz org ragequit`; [HOLDER-ACCESS-MODEL.md](HOLDER-ACCESS-MODEL.md))
and `web/tests/e2e-real/passkey-sign-in.spec.ts` (signing up with a passkey and signing in again after a reload, with
Chrome's virtual authenticator).

**Later set** (`--later`, twelve): `cli-milestone-e2e`, `web-record-e2e`, `web-milestone-e2e`, `web-dao-launch-e2e`,
`web-challenge-e2e`, `web-dao-journey-e2e`, `web-economy-e2e`, `web-sepolia-fork-e2e`, and, new on 2026-11-01,
`web-rounds-e2e`, `web-post-bounty-e2e`, `web-self-serve-e2e` and `shares-erc20c-e2e`. The four new ones were in no set
before, so nothing ran them; they have not been run since they were added to the set, so the first nightly run may find
them broken.

**Outside both sets, each with a reason** (`scripts/mvp-gate.sh --outside` prints them):

| Script | Why no set runs it |
|---|---|
| `web-social-e2e` | The social suite itself; the gate runs it as `web-social-hosted-e2e` (`HOSTED=1`, as the pilot server runs) |
| `web-decisions-e2e` | Raise-era (a launch-kit DAO); the contributor journeys open, vote and run decisions |
| `web-discussion-e2e` | Raise-era; a project's Discussion tab is covered by `web/tests/e2e/feed.spec.ts` |
| `web-passkey-wallet-e2e` | A passkey account as a payment wallet, against a stand-in chain; `web-passkey-contributor-e2e` covers passkey accounts on the pilot's screens |

The last three carry a "not in any gate" banner (DEPRECATION-2026-10-31.md, #34). Any other `scripts/*-e2e.sh` that is
in no set and has no reason is printed as a `WARNING` on every gate run, and `scripts/test-mvp-gate.sh` fails while one
exists. `scripts/e2e-git-perms.sh` and `scripts/e2e-large-channel-roster.sh` are the upstream server's own tests (git
permissions, a large channel roster), named the other way round and run by hand; the gate does not look at them.

## Known mismatches

- **Fixed 2026-11-01: `web-contributor-e2e` ran under `--pilot` in the wrong build.** It now runs there in the
  contributor-only build (above). What is still not the pilot's: the wallet is a browser wallet forwarding to Anvil's
  unlocked accounts (passkey accounts on the pilot's screens are `web-passkey-contributor-e2e`'s), the server is stubbed
  in the page, and the AI helpers (newcomer interviewer, check before submitting, check-note and challenge drafts) are
  played against a stand-in AI service, which the pilot server does not run; with no service those buttons are not
  offered.

## Not covered: real-server steps with no journey yet

These are hand tests until a journey exists ([PILOT-TEST-GUIDE.md](PILOT-TEST-GUIDE.md) says where):

1. **Linking the name to a passkey account against a real server.** Passkey sign-up and sign-in again after a reload
   now run against a real server (`web/tests/e2e-real/passkey-sign-in.spec.ts`, in `web-restricted-holder-e2e`).
   Linking the name ("Show your name with this account") is not in it: it needs the passkey account contracts and a
   bundler on a chain that journey does not have; `web-passkey-contributor-e2e` checks it on a Sepolia fork with a
   stubbed server.
2. **"Your work" from a real server.** `web-pilot-e2e` checks the label and who sees it against a stubbed server, and
   `web-passkey-contributor-e2e` opens it from the navigation against a stubbed server. Nothing opens Your work as a
   contributor whose claims, reviews and awards came from a real server.
3. **A holder whose social access is restricted**: the browser-wallet holder is now a journey
   (`web-restricted-holder-e2e`, above). A passkey-account holder's fallback and the "nothing leaked" check stay hand
   tests ([HOLDER-ACCESS-MODEL.md](HOLDER-ACCESS-MODEL.md)).

## Checks run on this change

`scripts/test-mvp-gate.sh` (all checks pass, including the new ones: an unhomed journey script is warned about on
standard error, `--list` stays a plain list, every script in `scripts/` has a home, `--outside` gives each a reason, and
the four new later journeys are listed). Removing the warning, or removing one reason from `OUTSIDE`, makes those checks
fail. `actionlint` (the repo's Hermit copy) passes on the workflow. The workflow itself has not run anywhere.

Later on 2026-11-01 (the contributor-only mode under `--pilot`): `scripts/test-mvp-gate.sh` passes, including "--pilot
runs web-contributor-e2e with PILOT_BUILD=1" and "a run without --pilot does not set PILOT_BUILD".
`PILOT_BUILD=1 scripts/web-contributor-e2e.sh` passed 2 of 2 (1.4 minutes of tests), the default run passed 2 of 2 (1.9
minutes), and the spec in pilot mode against the full build fails at its first pilot check ("How Shares work"), so the
pilot checks are not vacuous. `scripts/web-restricted-holder-e2e.sh` passed 2 of 2 after the spec fix in
[STATUS.md](STATUS.md). The whole `--pilot` set was not run in one go.
