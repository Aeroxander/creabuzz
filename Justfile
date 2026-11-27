# Buzz — development task runner

set dotenv-load := true

# List all available tasks
default:
    @just --list

# ─── Dev Environment ─────────────────────────────────────────────────────────

# Install required dev tools via Hermit and create .env (safe to re-run)
bootstrap:
    #!/usr/bin/env bash
    set -euo pipefail
    export PATH="{{justfile_directory()}}/bin:$PATH"
    # Hermit's bin/ symlinks auto-download pinned tool versions on first use.
    # Running each tool once triggers the download if not already cached.
    echo "Ensuring toolchain via Hermit..."
    cargo --version &
    node --version &
    pnpm --version &
    wait
    if ! command -v docker &>/dev/null; then
        echo "Error: Docker is required but not installed."
        echo "Install it from https://docs.docker.com/get-docker/"
        exit 1
    fi
    if [[ ! -f .env ]]; then
        cp .env.example .env
        echo "Created .env from .env.example — review it before running just dev."
    fi
    ./scripts/ensure-local-relay-key.sh .env

# Start Docker services, run migrations, install dependencies
setup: bootstrap
    ./scripts/dev-setup.sh

# Provision a community for the loopback hosts a dev relay serves (the relay
# binds connections to a community by Host header; without this the web app
# reports "no community is configured for this host"). Optional owner pubkey:
# `just dev-community PUBKEY=<hex>`.
dev-community PUBKEY="":
    ./scripts/dev-community.sh {{PUBKEY}}

# Install git hooks via lefthook (dispatches from the shared .git/hooks dir so all
# linked worktrees inherit the same hooks without a worktree-relative .hooks path)
hooks:
    #!/usr/bin/env bash
    set -euo pipefail
    # Use the Hermit-pinned lefthook (bin/lefthook self-downloads on first use):
    # works with no pre-installed lefthook and guarantees the pinned version
    # rather than whatever happens to be on PATH.
    export PATH="{{justfile_directory()}}/bin:$PATH"
    # --path-format=absolute guarantees an absolute path from every invocation context:
    # without it, --git-common-dir returns ".git" from the main checkout and a
    # relative hooksPath would break linked-worktree dispatch just like .hooks did.
    HOOKS_DIR="$(git rev-parse --path-format=absolute --git-common-dir)/hooks"
    git config --local core.hooksPath "$HOOKS_DIR"
    lefthook install --force

# Wipe development state and recreate a clean environment. Installed Buzz is preserved.
[confirm("This will DELETE all development data and preserve installed Buzz. Continue? (y/N)")]
reset:
    ./scripts/dev-reset.sh --yes

# Stop all dev services (keep data)
down:
    docker compose down

# Show dev service status
ps:
    docker compose ps

# Tail all service logs
logs *ARGS:
    docker compose logs -f {{ARGS}}

# ─── Local Dev Chain (Anvil) ─────────────────────────────────────────────────

# Boot a fully-loaded local dev chain on :8545 (chain id 31337): apptoken
# infra, the OrgBinding/DAO for org formation, a USDC-like currency mock, and
# the funded DEV-ONLY dev accounts printed to stdout. Idempotent: re-running
# detects the chain and skips what is already deployed. `--dry-run` prints the
# plan without touching anything.
dev-chain *ARGS:
    ./scripts/dev-chain.sh {{ARGS}}

# Stop the dev chain `just dev-chain` started (only the PID it recorded)
dev-chain-down:
    ./scripts/dev-chain.sh down

# What is deployed at which address: reads contracts/pot/deployments/*.json and
# probes the live chain on :8545
dev-chain-status:
    ./scripts/dev-chain.sh status

# Tests for the dev-chain plan/refusal logic — no chain, no foundry deploys
dev-chain-test:
    node --test scripts/dev-chain.test.mjs

# ─── Build & Check ───────────────────────────────────────────────────────────

# Build the Rust workspace
build:
    cargo build --workspace

# Build the Rust workspace in release mode
build-release:
    cargo build --workspace --release

# Run repo lint, formatting, and repository policy checks
check: fmt-check clippy app-check app-deploy-check security-review-check file-size-check

# Validate the trusted security-review workflow support and renderer contract.
security-review-check:
    node --check .github/scripts/codex-security-review.js
    node --test .github/scripts/codex-security-review.test.js
    actionlint .github/workflows/codex-security-review.yml

# Run the repository-wide differential file-size ratchet and its policy tests.
# The ratchet inspects only files changed from the merge base, so this stays
# cheap enough to run unconditionally without duplicating path filters.
file-size-check:
    node --test scripts/check-file-sizes-core.test.mjs

# Format all Rust code
fmt:
    cargo fmt --all

# Check formatting without modifying files
fmt-check:
    cargo fmt --all -- --check

# Run clippy with warnings as errors
clippy:
    cargo clippy --workspace --all-targets -- -D warnings

# Ensure Docker dev services (Postgres, Redis, etc.) are running and healthy
_ensure-services:
    #!/usr/bin/env bash
    set -euo pipefail
    pg=$(docker inspect --format '{{"{{"}}.State.Health.Status{{"}}"}}' buzz-postgres 2>/dev/null || echo "not_found")
    redis=$(docker inspect --format '{{"{{"}}.State.Health.Status{{"}}"}}' buzz-redis 2>/dev/null || echo "not_found")
    if [[ "$pg" == "healthy" && "$redis" == "healthy" ]]; then
        echo "Services already healthy"
        exit 0
    fi
    # The relay needs exactly two things: a database and Redis. Keycloak,
    # MinIO, Prometheus and Adminer are auxiliary — and a registry outage
    # (quay.io answering 401) must not block starting the relay when the
    # configured endpoints are already up. This is a TCP reachability pre-check
    # only: `_ensure-migrations` runs `buzz-admin migrate` immediately after,
    # so an unusable database still fails loudly there.
    [[ -f .env ]] && { set -a; source .env; set +a; }
    reachable() {
        local url="$1" default_port="$2" hostport host port
        [[ -n "$url" ]] || return 1
        hostport="${url#*://}"
        hostport="${hostport##*@}"
        hostport="${hostport%%/*}"
        host="${hostport%%:*}"
        port="${hostport##*:}"
        [[ "$port" == "$host" ]] && port="$default_port"
        [[ -n "$host" && -n "$port" ]] || return 1
        (exec 3<>"/dev/tcp/$host/$port") 2>/dev/null || return 1
        exec 3<&- 3>&-
        return 0
    }
    if reachable "${DATABASE_URL:-}" 5432 && reachable "${REDIS_URL:-}" 6379; then
        echo "Postgres and Redis are already reachable — skipping the compose stack"
        exit 0
    fi
    echo "Starting services..."
    docker compose up -d || true
    echo -n "Waiting for services"
    for i in $(seq 1 40); do
        pg=$(docker inspect --format '{{"{{"}}.State.Health.Status{{"}}"}}' buzz-postgres 2>/dev/null || echo "not_found")
        redis=$(docker inspect --format '{{"{{"}}.State.Health.Status{{"}}"}}' buzz-redis 2>/dev/null || echo "not_found")
        if [[ "$pg" == "healthy" && "$redis" == "healthy" ]]; then
            echo " ready"
            exit 0
        fi
        echo -n "."
        sleep 3
    done
    echo " timed out"
    exit 1

# Apply database migrations and seed the local dev community if the dev database is running
_ensure-migrations: _ensure-services
    cargo run -p buzz-admin -- migrate
    ./scripts/seed-local-community.sh

# Run all checks suitable for CI / pre-push (no infra needed)
ci: check test-unit app-test app-build

# ─── Test ─────────────────────────────────────────────────────────────────────

# Run all tests (unit + integration)
test:
    ./scripts/run-tests.sh all

# Run unit tests only (no infra needed). The backup encryption test needs the `age` program
# (sudo apt-get install -y age, or brew install age) and fails loudly without it; CI installs it.
# Set ALLOW_SKIP_AGE=1 to skip only its age cases on a machine that cannot install it.
test-unit:
    #!/usr/bin/env bash
    set -euo pipefail
    ./scripts/test-ensure-local-relay-key.sh
    ./scripts/test-compose-build-settings.sh
    ./scripts/test-compose-age-box.sh
    ./scripts/test-compose-backup-encryption.sh
    ./scripts/test-policy-stamp.sh
    ./scripts/test-policy-guard.sh
    if command -v cargo-nextest &>/dev/null; then
        cargo nextest run -p buzz-core -p buzz-auth --lib
        cargo nextest run -p buzz-audit --lib
        # Cross-pod disconnect payload tests (NIP-FI and community archive
        # fence); all infra-free.
        cargo nextest run -p buzz-pubsub --lib -E 'test(/^conn_control::tests::/)'
        # buzz-auth NIP-FI verifier doctests. The sealed-authority
        # `compile_fail` doctests prove the default-feature public API alone
        # cannot forge the issuer→JWKS authority; nextest does not run
        # doctests, hence this separate step. The verifier's regression suite
        # lives in the in-crate `#[cfg(test)] mod tests`, so `--lib` above
        # already runs it.
        cargo test -p buzz-auth --doc
        cargo nextest run -p buzz-cli
        # buzz-sdk builder/validation unit tests: pure event-builder and input
        # validation (e.g. the canvas writer-discipline/skew guard and the
        # canvas_write_survived predicate), no infra. `--lib` runs all unit
        # tests without the rustdoc dependency-resolution flake the full-package
        # invocation hits. Enumerated explicitly because nothing in CI runs
        # `cargo test --workspace` — membership buys clippy/check, not tests.
        cargo nextest run -p buzz-sdk --lib
        # buzz-db migrator/lint tests: pure SQL-parsing unit tests (no infra).
        # They guard the embedded-migrator invariant (the complete checked-in
        # additive migration set; legacy cutover/backfill remains an operator
        # script, not startup state) and the tenant-scoping lints. The
        # Postgres-backed buzz-db tests are
        # #[ignore]d, so --lib runs only the infra-free set. Without this gate a
        # stray file in migrations/ or a broken lint ships green.
        cargo nextest run -p buzz-db --lib
        # buzz-db source-policy tests: infra-free scans of the crate sources
        # that enforce the event-write admission chokepoint, metric/provenance
        # contracts, and their fixtures. They live in an integration-test
        # binary, so `--lib` above does not run them.
        cargo nextest run -p buzz-db --test observability_source
        # buzz-db `AdmittedTx` doctests. The `compile_fail` cases prove code
        # outside the crate can neither construct an admitted transaction nor
        # pass a raw `sqlx::Transaction` to an event-write helper; nextest
        # does not run doctests, hence this separate step.
        cargo test -p buzz-db --doc
        # Storage accounting crosses three crates whose focused regression
        # suites are otherwise absent from the infra-free unit lane.
        cargo nextest run -p buzz-media --lib \
            -E 'test(=bucket_index::tests::bucket_snapshot_json_round_trip_preserves_community_keys)'
        # buzz-admin: storage-snapshot worker plus the community archive
        # command parser, validation, and propagation-evidence tests.
        cargo nextest run -p buzz-admin \
            -E 'test(storage_snapshot) + test(/^communities::tests::/) + test(/^tests::communities_/)'
        # Multi-tenant conformance gate (buzz-conformance): the independent
        # replay checker + golden fixtures. No infra — pure in-process trace
        # replay — so it belongs in the unit job. Run all targets (lib + the
        # tests/replay_fixtures.rs integration test), not just --lib.
        cargo nextest run -p buzz-conformance
        # Admin API auth-boundary tests (api::admin in buzz-relay): the NIP-98
        # duplicate-tag rejections, the Host/Origin replay-ordering causal pair,
        # the admin.localhost origin/advertisement/canonical-URL pins, and the
        # host-oracle/credential-first checks. These are the regression guard for
        # the /api/admin/v1 moderation auth surface. Enumerated explicitly because
        # nothing in CI runs `cargo test --workspace`, `just test-unit` did not
        # enumerate `buzz-relay --lib`, and Backend Integration selects only the
        # #[ignore]d Postgres suites — so these non-ignored tests ran in no lane
        # and a red one could ship green (exactly how a broken admin test slipped
        # past every gate once). Scoped to api::admin, not the whole buzz-relay
        # --lib, because api::media has non-ignored tests that require Postgres.
        # DB-backed api::admin tests are #[ignore]d and run in the PostgreSQL
        # lane; the non-ignored ones reject before touching the database. Any
        # new non-ignored test here must stay DB-free: without a database, a
        # DB fallthrough only "passes" by waiting out the ~30s sqlx acquire
        # timeout.
        # The second clause adds the relay's pure authorization-decision tests:
        # the NIP-29 channel membership grid (handlers::channel_authz), the
        # moderation capability grid (handlers::moderation_authz), and the pure
        # helpers in handlers::side_effects. They ran in NO lane before —
        # `test(/^api::admin::/)` never matched them, and the PostgreSQL lane
        # pairs `--run-ignored ignored-only` with a `postgres_tests::`
        # default-filter — so a red one shipped green, exactly the gap the
        # api::admin clause above was added to close.
        # Deliberately scoped to these three modules instead of all of
        # `handlers::`: the wider set is mostly Postgres-backed, and five of its
        # non-postgres_tests cases only "pass" without a database by waiting out
        # the ~30s sqlx acquire timeout, so they do not belong in the infra-free
        # unit job either. The REQ subscription-lifecycle tests are picked by
        # exact name for the same reason: the rest of handlers::req needs a DB.
        # The third clause adds the NIP-FI HTTP ingress and its router/config
        # neighbours: nip_fi_http, nip_fi_config, router, api::parse_query_tests,
        # and the Git transport off_mode_precedence_tests. All are infra-free
        # and finish in well under a second with no DATABASE_URL, so none wait
        # out the sqlx acquire timeout. `--bin buzz-relay` adds main.rs's
        # `tests::` module (JWKS refresh cadence) and `composition_tests::`
        # (JWKS source + refresh-loop composition), which `--lib` cannot reach
        # because they live in the binary target; the nested
        # `tests::postgres_tests::` stays in the PostgreSQL lane.
        # The fourth clause adds the startup step timers (startup_steps) and the
        # env- and log-capture tests in telemetry and config. All three modules
        # are infra-free; config parses env into a struct and never connects.
        # `^config::` is anchored so it does not also select nip_fi_config.
        # `^chain_reader::` adds the chain reader's decoding and derived-numbers
        # tests; its Postgres tests are #[ignore]d *postgres_tests and run in
        # the PostgreSQL lane.
        cargo nextest run -p buzz-relay --lib --bin buzz-relay \
            -E 'test(/^api::admin::/) + test(/^handlers::channel_authz::/) + test(/^handlers::moderation_authz::/) + test(/^handlers::side_effects::tests::/) + test(/^storage_sweep::tests::/) + test(/^nip_fi_core::tests::/) + test(/^nip_fi_http::tests::/) + test(/^nip_fi_config::tests::/) + test(/^readiness::tests::/) + test(/^router::tests::/) + test(/^api::parse_query_tests::/) + test(/^api::git::transport::off_mode_precedence_tests::/) + test(/^audio::join::tests::/) + test(/^audio::handler::tests::/) + test(/^nip_fi_gate::tests::/) + test(/^nip_fi_session::tests::/) + test(/^nip_fi_shadow::tests::/) + test(/^nip_fi_shadow_session::tests::/) + test(/^startup_steps::tests::/) + test(/^telemetry::tests::/) + test(/^config::tests::/) + test(/^chain_reader::/) + test(=state::tests::neither_a_confirmed_inactive_community_nor_a_failed_lookup_admits_the_socket) + test(=state::tests::periodic_revalidation_disconnects_inside_the_fenced_callback) + test(=state::tests::bare_community_disconnect_fails_closed_when_the_fence_is_unavailable) + test(=connection::tests::send_loop_sends_policy_close_when_community_is_archived) + test(=state::tests::community_disconnect_then_nip_fi_keeps_community_deleted_reason) + test(=state::tests::disconnect_community_wins_reason_losing_nip_fi_does_not_enqueue_frame) + test(=handlers::req::tests::timed_out_historical_read_deregisters_before_closed) + test(=handlers::req::tests::superseded_timeout_leaves_replacement_intact) + test(=handlers::req::tests::search_claim_retires_live_and_yields_to_replacement) + test(=handlers::req::tests::concurrent_claims_and_stale_teardowns_keep_the_last_owner) + test(=handlers::req::tests::timeout_closed_is_emitted_before_a_replacement_can_claim) + test(=handlers::req::tests::revoke_then_replacement_keeps_replacement_whole) + test(=handlers::req::tests::claims_after_connection_cleanup_are_refused) + test(=handlers::req::tests::dropped_terminal_frame_cancels_connection) + test(=handlers::req::tests::revoke_dropped_terminal_frame_cancels_connection) + (kind(bin) & (test(/^tests::/) + test(/^composition_tests::/) + test(/^env_filter_tests::/)) - test(/^tests::postgres_tests::/))'
        # Note on audio::join::tests scope: the full suite is infra-free (no DB,
        # no Redis). The infra-free audio/FI regression witnesses — bootstrap
        # ordering barrier, CommitConfirmed arm, pending-close invisibility,
        # abnormal-stream-close fanout, and never-ready-sink writer witnesses —
        # are all selected by audio::join::tests and audio::handler::tests.
        # DB-backed audio join tests use #[ignore] and run in the postgres lane.
        # NIP-FI (S3/S4) relay witnesses: the wholly-new nip_fi_upgrade and
        # api::nip_fi modules,
        # the auth metrics contract module, plus the exact NIP-FI tests added,
        # or whose assertions changed, in mixed modules (audio::room,
        # connection, handlers::*, state). nip_fi_config and router are
        # selected whole by the command above. Mixed modules are listed by exact
        # name so main's unselected tests (several wait out the ~30s sqlx
        # acquire timeout) stay out. NIP-FI tests that need Postgres live in
        # postgres_tests and
        # run in the PostgreSQL lane. Keep scripts/run-tests.sh in step.
        cargo nextest run -p buzz-relay --lib -E '
                test(/^nip_fi_upgrade::/)
                + test(/^metrics::contract_tests::/)
                + test(=audio::room::tests::roster_revisions_are_ordered_and_snapshot_is_authoritative)
                + test(=connection::tests::auth_lifecycle_reconciles_every_terminal_and_never_leaks_gauge)
                + test(=audio::room::tests::b1_pending_peer_removed_before_commit_emits_no_delta)
                + test(=audio::room::tests::b2_commit_peer_emits_exactly_one_joined_delta_and_marks_visible)
                + test(=audio::room::tests::b3_commit_peer_revision_is_monotone_between_concurrent_events)
                + test(=audio::room::tests::f7a_pending_peer_excluded_from_snapshot_until_committed)
                + test(=connection::tests::b2_cancelled_connection_event_frame_not_dispatched)
                + test(=connection::tests::b3_expiry_denial_precedes_close_through_send_loop)
                + test(=connection::tests::b3_root_pairing_denial_precedes_close_through_send_loop)
                + test(=connection::tests::cancellation_during_select_with_fi_denial_routes_through_bounded_path)
                + test(=connection::tests::cancelled_never_ready_sink_with_queued_fi_denial_exits_within_timeout)
                + test(=connection::tests::deadline_exp_is_earliest_selects_exp)
                + test(=connection::tests::deadline_max_connection_lifetime_is_earliest_selects_partition)
                + test(=connection::tests::deadline_no_lifetime_returns_upstream_only)
                + test(=connection::tests::expiry_notice_queued_on_ctrl_before_cancel)
                + test(=connection::tests::f3_root_outer_wrapper_delivers_denial_on_bootstrap_cancellation)
                + test(=connection::tests::f3_root_pre_built_expired_gate_terminates_connection)
                + test(=handlers::auth::tests::b2_pre_cancelled_connection_never_becomes_authenticated)
                + test(=handlers::auth::tests::fi_ban_check_error_emits_terminal_authorization_unavailable)
                + test(=handlers::auth::tests::fi_root_authorization_denied_rows_emit_identical_frames)
                + test(=handlers::auth::tests::fi_invalid_nip42_proof_emits_terminal_evidence_rejected)
                + test(=handlers::auth::tests::handle_auth_pairing_mismatch_runs_full_root_denial_path)
                + test(=handlers::auth::tests::shadow_root_auth_records_pairing_denial)
                + test(=handlers::auth::tests::shadow_root_invalid_nip42_retires_without_record)
                + test(=handlers::auth::tests::nip42_denial_class_separates_internal_failure_from_bad_evidence)
                + test(=handlers::event::tests::fanout_access::owner_only_kinds_keep_only_the_owner)
                + test(=handlers::event::tests::pubsub_fanout::pubsub_owner_only_kinds_reach_only_the_owner)
                + test(=handlers::event::tests::pubsub_fanout::dispatch_owner_only_kinds_reach_only_the_owner)
                + test(=handlers::req::tests::p1a_huddle_liveness_req_barrier_expiry_blocks_query_and_emission)
                + test(=state::tests::f3_cancellation_during_check_terminates_socket_without_waiting_for_check)
                + test(=state::tests::on_not_run_runs_once_on_each_deny_arm_and_never_on_admit)
                + test(=state::tests::conn_manager_disconnect_nip_fi_ignores_unproven_connection)
                + test(=state::tests::conn_manager_disconnect_nip_fi_is_issuer_scoped)
                + test(=state::tests::conn_manager_disconnect_nip_fi_sets_authorization_denied_reason)
                + test(=state::tests::nip_fi_disconnect_audio_is_issuer_scoped)
                + test(=state::tests::nip_fi_disconnect_closes_proven_audio_socket_and_sends_policy_close_reason)
                + test(=state::tests::nip_fi_disconnect_closes_target_audio_only_and_preserves_collocated_peer)
                + test(=state::tests::nip_fi_disconnect_does_not_close_different_pubkey_audio_socket)
                + test(=state::tests::nip_fi_disconnect_does_not_close_unproven_audio_socket)
                + test(=state::tests::community_disconnect_then_nip_fi_keeps_community_deleted_reason)
                + test(=state::tests::disconnect_community_wins_reason_losing_nip_fi_does_not_enqueue_frame)
                + test(=state::tests::manager_disconnect_sets_reason_enqueues_frame_then_cancels)
                + test(/^api::nip_fi::/)'
        # boot_lifecycle spawns the real relay binary and asserts its startup
        # lifecycle, including that buzz_startup_phase_* reaches /metrics. Its
        # non-ignored tests need no Postgres or Redis; the Postgres cases are
        # #[ignore]d and stay in the PostgreSQL lane. Keep
        # scripts/run-tests.sh in step.
        cargo nextest run -p buzz-relay --test boot_lifecycle
    else
        ./scripts/run-tests.sh unit
    fi

# Run integration tests only (starts services if needed)
test-integration:
    ./scripts/run-tests.sh integration

# Run the DAO OS "org loop" end to end against a throwaway relay
# (scripts/loop-test.sh). Needs DATABASE_URL plus a running Postgres and Redis;
# dev only — it writes a test community into the database.
loop-test:
    ./scripts/loop-test.sh

# Regenerate the NIP-ORG authority corpus (anchoring, grant chains, node and
# budget publication, entailment, review tally) from the production Rust
# resolver in buzz-core. 
# Never hand-edit; the `corpus_matches_generated_snapshot` gate fails CI if the
# committed file drifts.
regen-org-corpus:
    cargo test -p buzz-core --lib org_grant::props::regen_corpus_file -- --ignored --exact

# Regenerate the shared event-kind tables (@creaton/core TS) from
# the registry source of truth, crates/buzz-core/src/kind.rs. Run after any
# kind change and commit the regenerated files. `node scripts/regen-kinds.mjs
# --check` (wired into the app and core checks) fails when they are stale.
regen-kinds:
    node scripts/regen-kinds.mjs

# ─── Run ──────────────────────────────────────────────────────────────────────

# Start the relay server (auto-starts Docker services if needed)
relay: bootstrap _ensure-migrations
    #!/usr/bin/env bash
    set -euo pipefail
    export PATH="{{justfile_directory()}}/bin:$PATH"
    set -o allexport
    source .env
    set +o allexport
    cargo run -p buzz-relay

# Post one root + N replies (and a few reactions) to the local dev relay, for eyeballing long threads
seed-long-thread replies="187":
    ./scripts/seed-long-thread.sh {{replies}}

# Start the relay server in release mode
relay-release: bootstrap _ensure-migrations
    #!/usr/bin/env bash
    set -euo pipefail
    set -o allexport
    source .env
    set +o allexport
    cargo run -p buzz-relay --release


# ─── Web ─────────────────────────────────────────────────────────────────────

# ─── Creaton app (app/, the new phone-first app) ────────────────────────────

app_dir := "app"

# Install the app's dependencies (and those of the shared package it builds from)
app-install:
    pnpm install --frozen-lockfile --filter "@creaton/app..."

# Run the app's checks: Biome, tsc, copy, rem-only text and file size guards, then the unused-exports scan (knip). Needs a full `pnpm install`, not only `just app-install`.
app-check:
    cd {{app_dir}} && pnpm check
    pnpm exec knip --no-progress

# Run the app's unit tests (vitest, jsdom: no browser, no relay, no chain)
app-test:
    cd {{app_dir}} && pnpm test

# Build the app: tsc, vite build, then the first-load bundle budget
app-build:
    cd {{app_dir}} && pnpm build

# The deploy bundle's own check of the app's settings: no Docker, no network (stand-ins for both)
app-deploy-check:
    bash deploy/compose/test-app-settings.sh

# ─── Money contracts (contracts/pot, a separate Foundry project) ─────────────
# Need Foundry on PATH and the pinned solc (scripts/ensure-solc.sh 0.8.37); the libraries are the submodules of contracts/lib.

pot_dir := "contracts/pot"

# Compile contracts/pot (the contract-size test in `forge test` binds the size limits)
pot-build:
    cd {{pot_dir}} && forge build

# Run contracts/pot's tests: units, fuzz, invariants and model vectors (takes minutes)
pot-test:
    cd {{pot_dir}} && forge test

# The app's money calls against the real contracts on a local chain (anvil only: no server, no browser); needs pot-build
pot-app-loop:
    ./scripts/pot-app-loop.sh

# The whole loop with `cast` only (anvil, forge, cast, jq); needs pot-build
pot-chain-loop:
    ./scripts/pot-chain-loop.sh

# The full loop (relay, Postgres, Redis, anvil, a browser; needs a built relay and buzz, about half an hour): CI runs it nightly
pot-full-loop *ARGS:
    ./scripts/pot-full-loop.sh {{ARGS}}

# ─── Database ─────────────────────────────────────────────────────────────────

# Apply database migrations
migrate: _ensure-migrations

# ─── Utilities ────────────────────────────────────────────────────────────────

# Remove build artifacts
clean:
    cargo clean

# Check the Rust workspace compiles without producing binaries
check-compile:
    cargo check --workspace --all-targets

# ─── Release ─────────────────────────────────────────────────────────────────

# Read the current relay version from its crate manifest
get-current-relay-version:
    @grep -m1 '^version = ' crates/buzz-relay/Cargo.toml | sed -E 's/version = "(.*)"/\1/'

# Compute next relay patch version (e.g., 0.3.0 → 0.3.1)
get-next-relay-patch-version:
    @python3 -c "v='$(just get-current-relay-version)'.split('.'); print(f'{v[0]}.{v[1]}.{int(v[2])+1}')"

# Bump the relay crate version and regenerate the lockfile
bump-relay-version version:
    #!/usr/bin/env bash
    set -euo pipefail
    # buzz-relay carries its own `version =` (not version.workspace), so the
    # replace targets the package version line only.
    perl -i -pe 's/^version = ".*"/version = "{{ version }}"/' crates/buzz-relay/Cargo.toml
    cargo update -p buzz-relay
    echo "Bumped buzz-relay to {{ version }} and regenerated Cargo.lock"

# Open or update the relay release PR (ghcr.io/block/buzz image)
release-relay *ARGS:
    #!/usr/bin/env bash
    set -euo pipefail
    ARG="{{ ARGS }}"
    if [[ -z "$ARG" || "$ARG" == "patch" ]]; then
        VERSION=$(just get-next-relay-patch-version)
    else
        VERSION="$ARG"
    fi
    just _release-pr relay "$VERSION"

# Release-PR engine for the relay.
_release-pr lane version:
    #!/usr/bin/env bash
    set -euo pipefail
    VERSION="{{ version }}"
    if ! echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'; then
        echo "Error: '$VERSION' is not valid semver (expected X.Y.Z)"
        exit 1
    fi
    # Lane-specific identifiers. The bump command runs after the branch switch.
    case "{{ lane }}" in
        relay)
            BRANCH_PREFIX="relay-release"
            TAG_FETCH='relay-v*'
            TAG_MATCH='relay-v[0-9]*'
            TAG_EXCLUDE='relay-v*-*'
            TAG_PREFIX="relay-v"
            CHANGELOG="crates/buzz-relay/CHANGELOG.md"
            ADD_FILES=(crates/buzz-relay/Cargo.toml Cargo.lock crates/buzz-relay/CHANGELOG.md)
            LOG_PATHS=(crates/buzz-relay/ crates/buzz-core/ crates/buzz-db/ crates/buzz-auth/ crates/buzz-pubsub/ crates/buzz-search/ crates/buzz-audit/ crates/buzz-media/ crates/buzz-sdk/ crates/buzz-workflow/ crates/buzz-conformance/ migrations/)
            ARTIFACT="Buzz Relay" ;;
        *)
            echo "Error: unknown release lane '{{ lane }}'"
            exit 1 ;;
    esac
    echo "Preparing ${ARTIFACT} release v${VERSION}..."
    # Must run on main with a clean, up-to-date tree.
    CURRENT_BRANCH=$(git symbolic-ref --short HEAD)
    if [[ "$CURRENT_BRANCH" != "main" ]]; then
        echo "Error: must be on main branch (currently on '$CURRENT_BRANCH')"
        exit 1
    fi
    git fetch origin refs/heads/main:refs/remotes/origin/main --no-tags
    # Release tags are remote-owned state; sync only this lane's tags so stale
    # local tags from older histories do not make release preflight fail.
    git fetch origin "+refs/tags/${TAG_FETCH}:refs/tags/${TAG_FETCH}"
    if [[ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]]; then
        echo "Error: local main is not up-to-date with origin/main. Run 'git pull' first."
        exit 1
    fi
    if ! git diff --quiet || ! git diff --cached --quiet; then
        echo "Error: working tree is dirty. Commit or stash changes first."
        exit 1
    fi
    # Switch to the release branch (create, or reset to main if it exists).
    BRANCH="${BRANCH_PREFIX}/${VERSION}"
    if git rev-parse --verify "refs/heads/$BRANCH" >/dev/null 2>&1; then
        echo "Branch '$BRANCH' already exists — resetting to origin/main..."
        git switch "$BRANCH"
        git reset --hard origin/main
    elif git ls-remote --exit-code --heads origin "$BRANCH" >/dev/null 2>&1; then
        echo "Branch '$BRANCH' exists on remote — checking out and resetting to origin/main..."
        git switch -c "$BRANCH" --track "origin/$BRANCH"
        git reset --hard origin/main
    else
        git switch -c "$BRANCH"
    fi
    # Lane-specific bump (the one diverging step).
    case "{{ lane }}" in
        relay)   just bump-relay-version "$VERSION" ;;
    esac
    # Generate the changelog from commits since this lane's last release tag.
    LAST_TAG=$(git describe --tags --abbrev=0 --match "$TAG_MATCH" --exclude "$TAG_EXCLUDE" 2>/dev/null || echo "")
    REPO=$(git remote get-url origin | sed -E 's|.*github\.com[:/]||; s|\.git$||')
    format_log() {
        local range="$1"
        git log "$range" --format="%h %H %s" --no-merges -- "${LOG_PATHS[@]}" | while IFS=' ' read -r short full rest; do
            local pr subject
            pr=$(printf '%s' "$rest" | grep -oE '\(#[0-9]+\)$' | grep -oE '[0-9]+' || true)
            if [[ -n "$pr" ]]; then
                subject=$(printf '%s' "$rest" | sed -E 's/ \(#[0-9]+\)$//')
                printf -- '- %s ([#%s](https://github.com/%s/pull/%s)) ([`%s`](https://github.com/%s/commit/%s))\n' \
                    "$subject" "$pr" "$REPO" "$pr" "$short" "$REPO" "$full"
            else
                printf -- '- %s ([`%s`](https://github.com/%s/commit/%s))\n' \
                    "$rest" "$short" "$REPO" "$full"
            fi
        done
    }
    TMPFILE=$(mktemp)
    {
        echo "# Changelog"
        echo ""
        echo "## ${TAG_PREFIX}${VERSION}"
        echo ""
        if [[ -n "$LAST_TAG" ]]; then
            format_log "${LAST_TAG}..HEAD"
        else
            echo "- Initial release"
        fi
        echo ""
        if [[ -f "$CHANGELOG" ]]; then
            tail -n +2 "$CHANGELOG"
        fi
    } > "$TMPFILE"
    mkdir -p "$(dirname "$CHANGELOG")"
    mv "$TMPFILE" "$CHANGELOG"
    # Commit.
    git add "${ADD_FILES[@]}"
    RELEASE_MSG="chore(release): release ${ARTIFACT} version ${VERSION}"
    if [[ "$(git log -1 --format='%s' 2>/dev/null)" == "$RELEASE_MSG" ]]; then
        git commit --amend --no-edit
    else
        git commit -m "$RELEASE_MSG"
    fi
    # Push and open/update the PR.
    git push --force-with-lease -u origin "$BRANCH"
    PR_BODY="## ${ARTIFACT} release v${VERSION}"$'\n\n'
    if [[ -n "$LAST_TAG" ]]; then
        PR_BODY+="### Changes since ${LAST_TAG}:"$'\n\n'
        CHANGELOG_BODY=$(format_log "${LAST_TAG}..HEAD~1")
        MAX_LOG=62000
        if (( ${#CHANGELOG_BODY} > MAX_LOG )); then
            TRUNCATED=$(printf '%s' "$CHANGELOG_BODY" | awk -v max="$MAX_LOG" \
                'BEGIN{n=0} {line_len=length($0)+1; if(n+line_len>max) exit; n+=line_len; print}')
            SHOWN=$(printf '%s\n' "$TRUNCATED" | grep -c '^-' || true)
            TOTAL=$(printf '%s\n' "$CHANGELOG_BODY" | grep -c '^-' || true)
            SKIPPED=$(( TOTAL - SHOWN ))
            CHANGELOG_BODY="${TRUNCATED}"$'\n'"_… and ${SKIPPED} more commits — [compare ${LAST_TAG}…${TAG_PREFIX}${VERSION}](https://github.com/${REPO}/compare/${LAST_TAG}...${TAG_PREFIX}${VERSION})_"
        fi
        PR_BODY+="${CHANGELOG_BODY}"$'\n\n'
    else
        PR_BODY+="Initial release."$'\n\n'
    fi
    PR_BODY+="**To release:** merge this PR. The tag and build will happen automatically."
    PR_TITLE="chore(release): release ${ARTIFACT} version ${VERSION}"
    EXISTING_PR=$(gh pr list --head "$BRANCH" --json url --jq '.[0].url' 2>/dev/null || true)
    if [[ -n "$EXISTING_PR" ]]; then
        gh pr edit "$BRANCH" --title "$PR_TITLE" --body "$PR_BODY"
        PR_URL="$EXISTING_PR"
        echo ""
        echo "Updated existing release PR: ${PR_URL}"
    else
        PR_URL=$(gh pr create --title "$PR_TITLE" --body "$PR_BODY")
        echo ""
        echo "Release PR opened: ${PR_URL}"
    fi
    echo "Merge it to trigger the release build."
