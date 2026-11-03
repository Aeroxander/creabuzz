# V5 implementation and evidence

Status: in progress, 2026-11-02. Branch `v5-governance-rework`, based on v4
commit `8fecc3258`. This document is not a deployment manifest or an audit.

## Authorized scope

Implement the 2026-11-01 handoff in small reviewable passes: A, project-story
reuse and score-root provenance; B, agreed contribution rewards; C, mechanical
finalization; D, bounded artifact checks; E, a secondary-only listing candidate
with founder eligibility and voting activation. Desktop/mobile product parity,
new primary fundraising, sponsor escrow and broad matching are out of scope.

Only scratch local-chain/fork deployments and fixture tokens may be used. No
public push, public-network write, existing-wallet funds, or real-value trading.

## Pass and validation plan

1. Establish a thin but real agreed-reward journey: authorized offer, contributor
   acceptance before effort, evidence/revision, independent review, challenge,
   exact once-only settlement. The contract reviewer owns authority/accounting
   defects; Foundry tests must use real production paths and adversarial cases.
2. Connect the browser and CLI to explicit candidate capabilities. Existing
   deployments keep legacy labels and actions; unavailable reads remain unknown,
   never evidence that a deployment is legacy. The web lane owns targeted
   browser evidence, including the exact contributor-only build.
3. Add one terms-bound finalizer with durable receipt recovery and one isolated
   check runner with real pass/fail/timeout cases. Failed containment fails
   closed. The tooling lanes own focused command/runtime tests.
4. Implement the separately designed secondary candidate and amount-specific
   voting activation. Convert applicable D179 exploits into regressions against
   that candidate. The contract reviewer owns escrow, provenance, eligibility,
   and support/snapshot checks; no UI-only lock or provenance claim substitutes.
5. Reconcile all writers, then run repository-required broad gates once on the
   final state. Record exact commands, outcomes and pre-existing failures here.
   Runtime journeys supplement, not replace, those checks.

## Current capability/deployment matrix

| Capability | Existing deployed instances | V5 development candidate |
|---|---|---|
| Recognition | Review followed by discretionary award vote | Contract draft and tested shared adapter exist; web journey wiring and contract acceptance pending |
| Finishing | Preserve the instance's real manual flow | D174 zero-money finishing plus constrained agreement settlement under review |
| Founder sale guard | ContributorKit permanently chose a zero guard | New-kit and transfer-only guard drafts exist; integrated checks pending |
| Secondary rounds | D179-vulnerable rounds remain unsuitable for real value | Separate market/factory drafts exist; reconciliation and adversarial checks pending |
| Voting maturity | Weighted holding age is not acquisition eligibility | Amount-specific policy draft exists; historical/quorum integration checks pending |
| Score roots | Admission follows the actual hook-selected root | Publisher/program-labelled browser reads implemented; runtime review pending |
| Artifact checking | Existing optional text-only AI helpers | CLI/check-record lane in progress; sandbox/runtime evidence pending |
| Finalizer | Existing manual actions | Local-only worker draft exists; crash/retry/reorg and real-chain acceptance pending |

## Evidence and remaining gates

Phase A author reports clean web checks/typecheck and 2527 Node tests. Phase B
author reports focused Foundry tests and five reverted guard mutations. Those
reports are supporting evidence, not acceptance: review is pending and the full
agreed-reward browser/real-local-chain journey has not been exercised.

Human testing, real hosted recovery, AI behavior evidence and an independent
security/legal review remain separate. None is marked complete by this work.

### Parent-run evidence, 2026-11-02

- Hermit environment: Node `v24.15.0`, pnpm `11.4.0`, Forge `1.4.3-stable`,
  Cargo `1.95.0`; Docker server `29.2.1` answers locally.
- `git diff --ignore-submodules=all --check`: exit 0 on the in-progress state.
- `bash scripts/mvp-gate.sh --pilot --list`: exit 0; ten existing pilot journeys
  listed. This lists coverage; it does **not** run those browser journeys.
- `bash scripts/test-mvp-gate.sh`: exit 0, `all checks passed`. Its stand-in
  journeys exercised process-group cleanup, bystander/foreign-state protection,
  occupied-port refusal, unregistered-script warnings, pilot-build flag isolation,
  failure propagation and MinIO CI setup. This establishes the gate harness's
  behavior, not correctness of the unfinished feature contracts or UI.

Phase B integration review reproduced two contract/brief blockers: the initial
corrections route cannot revise a live attempt, and the legacy award route can
consume an agreement at a different amount. Both are being corrected before
downstream wiring. Exact split totals, coauthor independence, truthful states,
review deadlines and dispute-safe closure are also in the correction scope.

The first parent-run agreement command, `forge test --offline --root contracts
--match-path test/ContributionAgreement.t.sol`, did not reach the tests: the
compiler encountered an incomplete concurrently written `SecondaryMarket.sol`
at line 600. This is recorded as a blocked intermediate run, not a passing
test or a demonstrated agreement-contract failure. Later checks must run on
the reconciled, syntactically complete state. Lanes use separate Foundry output
and cache paths, but that alone does not isolate shared source writes.

- Native Playwright launch was reproduced by the parent and failed before
  rendering: Chromium's macOS `bootstrap_check_in` returned a Mach port
  permission error. No browser pass or screenshots are claimed for that run.
- Pulling the public Playwright image failed in Docker's credential helper
  (`-50`), including with a separate anonymous client configuration. Existing
  Docker credentials/configuration were not changed. Browser runtime evidence
  remains blocked in this execution environment.
- A cached `alpine:3.20` container **did** run with `--pull never --network none
  --read-only --cap-drop ALL --security-opt no-new-privileges --pids-limit 32
  --memory 128m --cpus 1 --user 65534:65534`. Observed output: `isolated container
  execution works`, `root filesystem write refused`, `network request refused`;
  exit 0. This disproves the initial check-run lane's assumption that no enforced
  sandbox was available. The unsafe host-execution opt-in is being replaced;
  this probe alone is not acceptance of the unfinished full artifact runner.

- After source review, the parent corrected a loopback-host lookalike
  (`127.attacker.example` must not count as this machine), removed an unused
  export, captured the gate RPC endpoint consistently, and reset proof selection
  on community/policy changes even before the reader had approved a fetch.
  `score-root-policy`, `next-action` and `agreement-next` Node suites: **23
  passed, 0 failed**. Biome on the four touched provenance/card/spec files: clean.
- `E2E_STUB_RPC=1 pnpm -C web exec playwright test
  tests/e2e/v5-project-story.spec.ts --project=smoke --list`: exit 0; one test
  discovered. The stub uses the actual `votingWeight()`/`mandateFactory()`
  selectors. Discovery/transpilation is **not** browser execution; the runtime
  gate above remains open.

- `web-project-story-e2e` is now registered in the later gate set, with a fresh,
  isolated stub build on port 4196 and retained screenshots under
  `test-results/v5-project-story`. Run `scripts/web-project-story-e2e.sh` on a
  host that can launch Chromium. No inherited deployment credentials are passed
  into its build.
- Re-running the gate harness under concurrent load exposed its test fixture's
  one-second sleep: the stand-in chain sometimes never reached its startup
  marker, while several negative checks passed vacuously. The fixture now has a
  bounded, checked readiness handshake and an explicit started assertion. The
  parent re-ran `bash scripts/test-mvp-gate.sh`: **all checks passed**, including
  `the stand-in chain actually reached readiness`. No real containment check
  was disabled or marked as an expected failure.

### Artifact runner integration review (not yet accepted)

The author supplied an actual Docker read-back demo and 24 focused passing
tests. Parent source review nevertheless found concrete defects: recursive
snapshot copying reset the root and could flatten nested files; its digest was
computed from the source tree rather than the copy; Docker management failures
could be misread as successful cleanup; image-declared volumes were not checked;
and the reviewer view matched an unsigned record by claim id without mandate or
community isolation. A signed publisher's `sandboxEnforced` boolean also must
remain that publisher's report, not independent remote attestation. Scoped fixes
and adversarial tests are in progress. No runner-completion or safety claim is
made until those are reconciled.

The snapshot rewrite now preserves hierarchy, hashes the bytes it actually
copies, rejects unsupported file types, bounds traversal, and owns a private
temporary directory. The author reports eleven focused passing tests, including
a scratch harness importing the actual file. That harness is not an integrated
CLI pass: the lifecycle lane was still changing shared module signatures. A
same-user concurrent path-swap limitation remains documented; no complete
dirfd/`O_NOFOLLOW` containment claim is made. The parent also requested
cooperative deadline checks during copying and lossless handling or refusal of
non-UTF-8 filenames before accepting the snapshot lane.

Those two follow-ups are now present in the reviewed source. The author reports
14 integrated focused tests passing; on the parent's subsequent rerun,
`cargo test -p buzz-cli --lib work_checks::snapshot` exited 101 before running
tests because the concurrently edited `sandbox.rs:230` had an unmatched
delimiter. The lifecycle author was notified; this is an intermediate build
block, not a snapshot-test failure or a parent-confirmed pass. Parent-run
`rustfmt --edition 2021 --check` on both snapshot files and
`git diff --ignore-submodules=all --check` passed. `node scripts/regen-kinds.mjs
--check` also passed; the mobile change is a generated kind-table mirror only.

### New-kit parent verification and deployment blocker

The parent ran the real worktree's `ContributorKitV2Test`,
`FounderSaleEligibilityTest`, `ContributorKitTest`, `MolochPatchedTest`,
`TransferLockTest` and `ExitExchangeTest` with offline Forge and isolated output
and cache directories: **45 passed, 0 failed, 0 skipped** (including 256 runs of
the transfer-lock fuzz test). `node scripts/check-majeur-fork.mjs` passed with
100 marked regions and no edits outside them. This verifies the exercised
creation/binding, founder transfer/burn and legacy baseline paths in the test VM.

Independent artifact-size inspection then found a deployment blocker which
those tests did not detect: `ContributorKitV2` creation code was **60,155 bytes**,
already over EIP-3860's **49,152-byte** limit before constructor arguments.
Its runtime was 15,802 bytes. Other measured runtimes were Moloch 23,970,
Shares 12,755, ActivationVoting 22,889, SecondaryMarket 13,310 and its factory
16,984 bytes, each below EIP-170's 24,576-byte limit at that source state.

The corrective scope separates the factory's infrastructure deployment from
the kit's, binding an immutable predicted kit address in the factory and checking
that binding in the kit constructor. Project creation remains one atomic kit
call. No mutable registrar, deployer authority or public activation is being
added. Corrected size assertions must include constructor arguments; a successful
`new` inside Foundry tests is not a substitute for checking deployment limits.
The kit lane is **not accepted as deployable** until this is fixed and rechecked.

### Shared agreement adapter checkpoint

Parent-run `agreements.test.mjs` and `agreementsRead.test.mjs`: **40 passed**.
The integration check also found the existing work reader did not recognize the
new `Retired` claim status, which would omit superseded attempts. The enum,
terminal next-step copy and exhaustive status-tone map now preserve that history
without offering another review or award. The combined work/agreement focused
Node run passed **59 tests**, with no failures or skips. Scoped Biome checks
had no errors (style information only); web typechecking passed after the
status-map update. Committed locally as `7a34b6339`.

The web journey is now being connected to that adapter. This checkpoint encodes
and reads real contract interfaces; it is not yet evidence of a browser wallet
completing the full agreed-reward journey.

### Runner and evidence-query reconciliation

After the lifecycle files compiled, the parent ran
`cargo test -p buzz-cli --lib 'work_checks::'`: **48 passed, 0 failed** in
72 seconds. This includes all fourteen snapshot tests and real Docker tests
for outside writes, secret access, networking, output caps, timeout cleanup,
bystanders, image volumes and host-client death. It supersedes the earlier
intermediate compile block, but is not final runner acceptance.

An additional parent-run adversarial probe stopped the same-user watchdog
processes inside the namespace. A container with a two-second inner deadline
was still running after six seconds; its uniquely named probe container was
then removed successfully. Merely stopping the parent process did not reproduce
this (that probe exited 137). The fix replaces the stoppable image watchdog with
a trusted actual PID1 deadline boundary; the ownership journal also needs
private, atomic persistence and authenticated cleanup. Until those pass, CLI
death plus an adversarial check can leave a container running past its deadline.

The reviewer-record parser's parent-run tests passed **11/11** and scoped Biome
was clean. A separate production-SDK probe then established that the server
silently ignores multi-character `#claim`, `#mandate`, `#evidence` filters. The
query had therefore asked for the newest fifty records across the server, not
the intended submission. Client-side filtering prevented misattribution but
could lose real matches. Publisher and reader are being changed together to
one single-letter `c` context tag containing the normalized mandate, claim id
and evidence hash, retaining the longer display tags and signature/content
checks. The parent also checked the SQL path: accepting a filter in the SDK is
not enough if it is applied only after `LIMIT`. A narrowly scoped relay change
will push that exact context through the existing custom-tag constraint before
the limit. No new HTTP endpoint, event kind, schema or general tag-query system
is needed.

### Maturity-policy review boundary

The small policy tests did not exercise its multi-epoch conservation walk:
that known-failing helper was named `diag_`, outside normal Forge discovery.
The read-only reviewer reproduced a panic when running that walk as a test.
Parent source review also identified a dormant-holder path: global matured
buckets can be evicted while a holder still retains their old tag, so an
unconditional global-tag removal can reject a later legitimate transfer or
exit. Corrections must keep bounded epoch accounting, normally discover the
fuzz walk, and handle or freeze exclusion changes. No all-holder sweep or
withdrawal lock is being added. The earlier 45-test kit/baseline result remains
valid for its exercised cases, not as evidence that these paths are safe.

### Check-query server handoff

The relay change is present and parent-reviewed: only a single `c` value on an
exclusively kind-47010 filter becomes `EventQuery.custom_tag`, using existing
JSONB containment before SQL ordering and limiting. The COUNT fast-path check
uses the same narrow condition; community scope and requested limits are
unchanged. The author reports two new tests and 73 passing request-handler
tests, with two existing ignored tests. These are supporting reports, not a
live-server pass. A fresh isolated relay/database query-and-count run is now
assigned to establish whether an older target survives sixty newer unrelated
records. Existing local databases, containers and wallets are outside its scope.

The maturity correction specialist ended with a provider response-header
timeout after saving changes. The parent confirmed the restored `testFuzz_`
entrypoint and policy guard edits exist, and started a focused offline Forge run
against those actual files. No successful handoff or passing result is inferred
from the specialist's interrupted session.

### Latest parent evidence and quota block

- The parent re-ran the isolated live query fixture after removing its desktop
  dependency and session-specific default path. A fresh debug relay, fresh
  Postgres/Redis, 61 signed events, HTTP query/COUNT, WebSocket authentication/REQ
  and cross-community checks all passed. The older target was returned despite
  sixty newer unrelated records, COUNT was 1, and wrong-context/other-community
  queries returned zero. The live test caught a fast-COUNT over-count: `c` now
  stays off that fast path and uses the exact filtered fallback. The parent
  independently confirmed the fixture relay PID and both owned containers were
  gone. Logs remain under the approved temp root at
  `buzz-workcheck-e2e-EAF64C4875B54F1CBCE74966EE5542A6-logs`.
- The final reader's focused Node tests passed **12/12**, the kind-registration
  test passed, the two query-pushdown tests passed, generated kinds were current,
  and the gate-harness regression checks passed. These source/runtime changes
  are committed locally as `5dc3ff0d0`. The fixture proves the event/query scope;
  it does not claim a complete CLI-to-browser check-record workflow.
- The parent's maturity run, scoped with `--skip ContributionAgreement` after
  an intermediate agreement-test compile error, compiled and ran **31 passing
  unit tests and one failing discovered fuzz test** (`SnapshotNotTaken`). The
  saved fuzz harness has concrete unfinished issues, including its probe's
  unassigned returned id. It is not accepted. A fresh specialist was assigned
  to finish that regression, then hit the quota block below.
- The corrected external-factory kit source is present. Its author reports
  argument-inclusive initcode of 29,960 bytes for the kit and 30,559 for the
  factory, plus 49 focused passing tests. Parent review confirmed the constructor
  binding and birth-time start handling; a real Anvil deployment was assigned
  but did **not** complete before the quota block. These reported sizes and
  tests are not substituted for the pending parent deployment check.

**Blocked on model permission/quota, not marked complete.** GLM Flash specialist
calls now report the weekly limit, resetting **2026-11-08 18:09:32 UTC**; Ling
Flash was already unavailable. The agreement contracts, finalizer, maturity
correction, sandbox deadline/journal hardening and agreed-reward web journey
have unfinished uncommitted changes. No allowed specialist remains available.
Continuing those lanes requires restored quota or explicit authorization for a
different model. Browser execution, human acceptance and independent audits
remain separate open gates. No public deployment or activation occurred.

### Resumed verification (2026-11-02, later)

The user switched the specialist models to DeepSeek V4.1 Flash, so the lanes
were resumed. Everything below is a command result the parent ran or
reproduced, not an author report.

- **Contracts, one reconciled run.** `forge test --offline --root contracts`
  restricted to the agreement, market, activation, kit and legacy-adjacent
  suites: **181 tests passed, 0 failed, 0 skipped across 18 suites**
  (ContributionAgreement 42, splits 6, TreasuryMandate 8, ClaimStakeCurrency 7,
  ActivationVoting 37, its discovered fuzz walk 1, ContributorKit 9,
  ContributorKitV2 15, FounderSaleEligibility 5, SecondaryMarket flows 7+4+5,
  Adversary 10, Provenance 7, Invariant 2, MolochPatched 9, TransferLock 8,
  ExitExchange 3, plus the remaining suite).
- **The full contracts build compiles.** It had been failing with a solc
  internal error (`Tag too large for reserved space`); the cause was one
  oversized *test* contract, not a product contract. The sixteen flow tests were
  split across three sibling contracts sharing one fixture: the same sixteen
  tests, none dropped or weakened, and `forge build --offline --root contracts`
  now succeeds.
- **Capability marker corrected.** The mandate exposed `agreementsVersion()`
  while the frozen adapters probe `AGREEMENTS_VERSION()`; the contract now
  answers the frozen selector and a test pins it (`0xf964bc9e`). The audit scope
  document was corrected to match.
- **Maturity policy repaired.** The previously excluded multi-epoch walk is now
  an ordinary discovered fuzz test and passes, with deterministic regressions for
  the dormant-holder global-bucket path; post-creation exclusions are frozen and
  an over-long schedule is refused.
- **Artifact runner hardened and green.** `cargo test -p buzz-cli --lib
  'work_checks::'`: **51 passed, 0 failed**, including real Docker tests for the
  malicious same-namespace stop, host-CLI death with the deadline still landing,
  timeout removal with a forked descendant, forged/corrupt journal records being
  retained rather than removed, image-declared volumes and credential defaults
  refused, and the private-root/mount read-back. Three real defects were fixed
  to get there: the daemon identity check compared an image *tag* against a
  sha256 ID (so verified cleanup could never match), probe container names
  collided with their own predecessor, and the trusted-supervisor fixtures were
  a non-executable payload plus a journal entry with no image ID. Two further
  test-fixture defects (an owner-label-less leftover container, and a check that
  backgrounded and exited instead of running to its deadline) were corrected;
  neither weakened an assertion.
- The trusted supervisor is now a small standalone Rust program run as true PID 1
  (no Docker `--init`), built offline from cached images, hash-pinned in a
  manifest, copied into a private root and mounted read-only. A same-UID check
  can no longer stop the process enforcing its deadline.

### Real local deployment of the creation version

`./scripts/v5-local-fixture.sh` deploys the whole creation path as real
transactions on a self-started local anvil (chain id 31337, loopback WebSocket)
and reads every value back from node state with `cast`, not from the script's
memory. Three consecutive runs exited 0; the final run reported **8/8 receipts
`status = 1`**, the kit landing on its predicted address
(`0xDc64…F6C9`), and:

- `dao.shares()` and `dao.votingWeight()` equal the predicted Shares and policy
  clones; `marketFactory.marketOf(dao)` is the predicted market, whose
  `dao/sharesToken/policy/quote/lotSize` all match;
- `listing()` is `false,0,0,0` — trading is a later DAO decision, not automatic;
- `saleEligibleOf(founder) = (0, 1)`, `lockGuard() = 0`,
  `lockGuardSet() = true`, `transferExempt() = market`, `transfersLocked() = true`;
- the founder's bootstrap `capacity` is non-zero (`2e20`) with
  `proposalThreshold` `2e18`, so a new project can govern from birth;
- the policy's frozen schedule reads market, founder, grant `2e20`, start = the
  launch block, cliff 0, duration 15,552,000.

Creation payloads as the node received them, against EIP-3860's 49,152:
`TreasuryMandateFactory` **49,129** (23 bytes of headroom — a real constraint for
future work), `Summoner` 47,832, `SecondaryMarketFactory` 30,559,
`ContributorKitV2` 29,960, `ActivationVoting` 23,886. Runtimes against
EIP-170's 24,576: Moloch 23,970, `ActivationVoting` 23,687, mandate factory
21,086, market factory 16,984, work budget 16,505, kit 15,792, market 13,310,
Shares 12,755, Summoner 1,970.

Noted, not resolved here: Foundry 1.4.3 produces different bytecode for
`ActivationVoting` from `forge build` (23,446 runtime) versus `forge script`
(23,687) with identical sources and metadata, and the checked-in `out/`
artifact was stale. The deployment path is the larger number, so the limits hold
either way, but a reproducible-artifact check for that contract remains open.

### Real CLI run of the artifact check

The built CLI was run against a fixture artifact with three declared checks
(read, write-outside, hang) using `--no-publish`:

- `sandboxEnforced: true`, `summary: {passed: 2, timedOut: 1, notRun: 0}`;
- the outside write was refused by the container (`Read-only file system`) and
  nothing appeared on the host;
- the hanging check ended at its deadline rather than hanging the run;
- the signed record carried `["c", "<mandate>:<claim>:<evidence>"]` alongside the
  display tags, so the reader's indexed query can reach it.

That run exposed and fixed two real defects: the container read-back compared
`HostConfig.Binds` as an ordered list, so a daemon that returns the same two
read-only binds in another order was reported as a containment failure (now a
set comparison), and the publisher did not emit the `c` context tag at all.

## Running the new pieces by hand

Everything below is local-only. Nothing here deploys to a public network or
turns trading on.

1. **Deploy the creation version on a scratch chain.**
   `./scripts/v5-local-fixture.sh` starts its own anvil on a free loopback port,
   deploys the factory, policy, summoner, market factory and kit as real
   transactions, launches one project, reads every binding back with `cast`, and
   kills only the anvil it started. It prints the addresses and the receipt
   statuses; a failure is a real revert or a limit violation, not a skip.
2. **Run a claim's declared checks.**
   `buzz launchpad work-checks --launch … --claim … --mandate … --evidence-hash …
   --check-hash … --checks checks.json --dir <artifact> --sandbox-image alpine:3.20
   --sandbox-supervisor target/buzz-check-supervisor`
   builds the trusted supervisor once with `scripts/build-check-supervisor.sh`,
   runs each check inside the enforced container, and signs a record you can
   publish beside the claim. `--no-publish` prints the signed record instead.
3. **Settle an accepted agreement.**
   `node scripts/agreement-finalizer.mjs run --journal <dir> --rpc
   http://127.0.0.1:8545 --opt-in-fixture-writes --fixture-key <well-known anvil
   key> --job chain=31337,dao=…,mandate=…,agreement=…,action=start-window` (then
   `action=settle-agreement`). It refuses a public RPC, a non-anvil node, a
   changed chain, a claim without an approval quorum, and a claim with an
   objection quorum (which would slash). `status`, `retry` and `reconcile` are
   the recovery commands; nothing is deleted on failure.
4. **Walk the agreed-reward flow in the app.** Manager proposes a fixed Share
   quantity against a work area; the beneficiary accepts the exact terms and
   sees the reservation; the beneficiary submits once (three calls, retryable
   one at a time); a reviewer may ask for changes without voting; the panel
   approves; after the challenge window anyone settles and the record shows the
   exact recipients. Confirm the legacy "open an award vote" button is gone for
   that claim, and that a publish failure survives a reload.

## What is still not proven

- No browser run has happened on this host: Chromium fails before rendering with
  a macOS MachPort permission error, and the public Playwright image cannot be
  pulled through this Docker credential helper. The agreed-reward screens are
  covered by type checks, unit tests and the full web test suite, not by a
  person or a browser.
- Human acceptance of the new flow is outstanding, and so is an independent
  security and legal review of secondary trading.
- Real-chain reorg handling, a frozen claim settled on a real chain, and killing
  a real anvil mid-broadcast are covered only by fake-node tests.
- `TreasuryMandateFactory` has 23 bytes of creation-code headroom; any further
  growth there will need splitting.

## Whole-suite results and gate status

- `forge test --offline --root contracts`: **734 passed, 0 failed, 2 skipped**
  across 69 suites. One regression surfaced here and was fixed: a work-area
  bounty test expected an approved claim bound to no work area, which the new
  review-readiness guard makes unreachable — attesting such a claim now reverts
  `NotReadyForReview` before any approval exists, so the test asserts that
  earlier, stronger refusal and still proves the bounty refuses a foreign area.
- `cargo test -p buzz-cli --lib 'work_checks::'`: **51 passed, 0 failed**;
  `cargo test -p buzz-relay --lib 'handlers::req'`: **73 passed, 0 failed,
  2 pre-existing ignored**; `cargo clippy -p buzz-cli -p buzz-core -p buzz-relay
  --all-targets` and `cargo fmt --check` are clean.
- `scripts/agreement-finalizer.test.mjs`: **34 passed, 0 failed, 0 skipped**,
  including the real-chain journey.
- `pnpm -C web test`: **2581 passed, 0 failed**; `pnpm -C web typecheck` clean;
  `check:copy`, `check:px-text`, `check:kinds` and the file-size ratchet pass.
- `just clippy` (whole workspace) cannot run in this environment: the
  `sherpa-onnx-sys` build script tries to download a native archive and DNS is
  unavailable, so the workspace lint stops before reaching this change. Clippy
  scoped to the three touched crates is clean; the full-workspace run remains a
  CI-side check.
- `just web-check` currently fails only on `knip` unused exports introduced by
  the new modules; that is being cleared. No behavioural failure is outstanding
  in the suites above.

## Gate status at this checkpoint

| Check | Result |
|---|---|
| `forge test --offline --root contracts` | 734 passed, 0 failed, 2 skipped |
| `forge build --offline --root contracts` | compiles (no ICE) |
| `cargo test -p buzz-cli --lib 'work_checks::'` | 51 passed |
| `cargo test -p buzz-relay --lib 'handlers::req'` | 73 passed, 2 pre-existing ignored |
| `cargo clippy` (buzz-cli, buzz-core, buzz-relay) / `cargo fmt --check` | clean |
| `scripts/agreement-finalizer.test.mjs` | 34 passed (real chain included) |
| `./scripts/v5-local-fixture.sh` | 8/8 receipts, all read-backs exact |
| `./scripts/work-check-query-e2e.sh` | passed on a fresh isolated relay |
| `pnpm -C web test` / `typecheck` / `build` | 2581 passed / clean / builds |
| `just web-check` (incl. knip, copy, px-text, kinds) | passes |
| `just fmt-check file-size-check majeur-fork-check` | pass |
| `just web-bundle-budget` equivalent | entry 0.78 MiB, ok |
| `scripts/test-mvp-gate.sh` | all checks passed |
| `just clippy` (whole workspace) | blocked offline by `sherpa-onnx-sys` download |

`v5-local-fixture` is now registered in the gate's later set, so the sweep runs
the real deployment proof alongside the query fixture.

## A world you can click through, and real browser evidence

**Browser execution works on this host** with the pinned headless shell and the
sandbox disabled — the earlier MachPort failure was the browser sandbox, not the
app:

```bash
export PW_CHROMIUM_PATH="$HOME/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell"
export PW_CHROMIUM_EXTRA_ARGS="--disable-gpu --disable-dev-shm-usage --single-process"
```

With that, `scripts/web-project-story-e2e.sh` **passes** (1 test, 0 failures,
twice) and writes seven distinct screenshots. Getting there exposed a real
harness defect rather than a product one: the spec's RPC stub keyed answers by
`contract|selector+args` while the router looked up `contract|selector`, so every
per-argument read was dead and the page correctly reported that it could not read
the project.

**A demo world for hand testing.** `./scripts/v5-demo-world.sh` deploys the
creation version on a throwaway anvil (real transactions, chain id 31337),
publishes a launch record plus its summon receipt to a local relay, marks the
record as a DAO's Shares, serves the app on `:5173`, and stays up until Ctrl-C.
The parent ran it and confirmed in a real browser that the project page renders
its governance tabs and the **Agreed rewards** card:

> Agreed rewards — Work whose exact reward is promised before it starts. The
> quantity is fixed in Shares, not in money and not as a percentage of the
> project… Work budget · 0 agreements · Agreed rewards run on their exact terms
> here. No agreed work is listed here yet.

Screenshot: `demo-agreed.png` (36 KB, 1280 wide) and `demo-work.png` (371 KB).

Two host quirks the script works around, both real and worth knowing:
`cast`'s HTTP client panics here (a macOS system-configuration NULL), so every
deployment and read goes over the node's WebSocket transport; and `dev-chain.sh`
boots anvil with `nohup`, which cannot detach without a controlling terminal, so
the demo starts anvil itself and lets the chain script skip its own boot.

### The agreed-reward journey, driven end to end

`scripts/v5-demo-agreement.mjs` runs one agreement against the demo world with
real transactions — propose (manager) → accept (beneficiary) → submit claim,
state the agreed check, bind → two reviewers approve → `ClaimStake.settle`
starts the challenge window → time passes → anyone calls
`DAO.settleAgreement` — and photographs the Work tab's Agreed rewards card after
each step. A full run finished:

> PASS: one agreement proposed, accepted, submitted, approved, challenged,
> settled — 5000000000000000000 Shares minted exactly (challenge window 604800s)

Six screenshots were written with six distinct SHA-256 hashes. On chain the
record ends `terminalKind = 1` (settled), `agreementState = 9`, and
`agreementOfClaim(claimId)` names the agreement — so the settlement path is
real, exact and once-only.

**Correction to an earlier claim, and the defect that is real.** A previous
note here said two agreements in one work area collapse to a single card. That
was wrong, and it was my measurement: `agreed-rewards` is the outer section, so
counting it always returns one. Counting the cards themselves
(`agreed-agreement`) on a world holding **four** agreements returns **four**, each
with its own state — `Offered, waiting for the named person | Settled | Agreed;
the quantity is reserved | Offered…` — and the run's own card tracked
`Offered` → `Agreed` → `Settled` while exactly 8e18 Shares were minted. Nothing
in the lane drops an agreement.

A second correction, from reading the cards directly: the attempt's review
state **is** shown, in the card's next-step line, while the badge stays the
record's own state. On the same world, the agreement left mid-review reads
`Agreed; the quantity is reserved` beside *"The review did not conclude in the
agreed period: the attempt lapses on its own, and the reservation then releases
by expiry"*, and a settled one reads `Settled` beside *"The agreement settled
exactly on its terms."* So nothing is missing from the card; the badge is
record-level by design (offered / agreed / settled) and the step line carries
the attempt. Whether the badge should also mirror the attempt is a design
choice, not a defect, and no fix is needed for the MVP.

### Final evidence: every phase renders, on a world with five agreements

A run against a world already holding four agreements created a fifth and
captured it after each step. The section rendered **five cards** every time, and
this run's card tracked all six phases:

| phase | badge | next-step line |
|---|---|---|
| proposed | Offered, waiting for the named person | "Accepting is the financial moment: this quantity is reserved against the work area's own ceiling then, never before." |
| accepted | Agreed; the quantity is reserved | "One submission at a time, at no currency ask…" |
| submitted | Agreed; the quantity is reserved | "The panel judges one attempt at a time against the agreed criteria; no decision lands by itself…" |
| approved | Agreed; the quantity is reserved | "The panel reached its actual quorum: anyone may settle the claim, which is what starts the attempt's challenge window." |
| window passed | Agreed; the quantity is reserved | "Approved on its own terms; once the challenge window has passed anyone may settle it at the record's exact quantity." |
| settled | Settled | "The agreement settled exactly on its terms." |

Six screenshots, six distinct SHA-256 hashes. The run ended
`PASS … 9000000000000000000 Shares minted exactly`.

So the original report of a multi-agreement defect was wrong twice over: five
agreements render as five cards, and every phase of the new one is visible —
the badge stays record-level and the step line carries the attempt.

**Host note.** `cast send` intermittently panics building macOS proxy settings
(`system-configuration` returns NULL) before reaching the node; the journey
script retries that specific startup failure and never retries a parsed revert.

## Consolidated local gate run (2026-11-03)

Every command below was run from the worktree on branch `v5-governance-rework`;
each result is the command's own exit status, not a summary of someone else's run.

| Gate | Command | Result |
|---|---|---|
| Formatting | `just fmt-check` | **exit 0** |
| File sizes | `just file-size-check` | **exit 0** |
| Majeur fork | `just majeur-fork-check` | **exit 0** — 100 regions, 773 lines, nothing else changed |
| Web checks | `just web-check` | **exit 0** (biome, pubkey truncation, px-text, copy, kinds, templates, knip) |
| Contracts build | `forge build --offline --root contracts` | **exit 0** — compiles, no internal compiler error |
| Contracts tests | `forge test --offline --root contracts` | **734 passed, 0 failed, 2 skipped** (69 suites, 71 s) |
| Workspace clippy | `cargo clippy --workspace --all-targets --exclude buzz-voice -- -D warnings` | **exit 0, zero warnings** |
| Touched crate tests | `cargo test -p buzz-cli -p buzz-core -p buzz-relay` | **2744 passed, 1 failed, 514 ignored** |

**Whole-workspace clippy is no longer blocked.** The only crate it could not build
is `buzz-voice`, whose `sherpa-onnx-sys` build script downloads a native archive
and this host has no DNS. Excluding exactly that crate (nothing else) lets the
gate run, and it passes with `-D warnings`.

**The one failing test is pre-existing.** `cargo test -p buzz-relay` fails
`api::mesh_demo::tests::demo_join_forwarded_arm_round_trips_echo` with a 504
(the demo join's echo wait times out; `mesh_demo.rs:339` expects 200). This
branch does not touch that file (`git diff --name-only 8fecc3258..HEAD -- crates/buzz-relay/src/api/mesh_demo.rs`
is empty), and the same test **fails identically on the base commit**: a detached
worktree at `8fecc3258` with its own target dir ran it and got
`FAILED … finished in 10.11s`, same panic line. So it is an existing
environment/behaviour failure, not a regression from this work, and it is left
for the mesh owners rather than papered over.

## Repo-wide unit gate and a wallet-signed journey

### `cargo test --workspace --exclude buzz-voice --no-fail-fast`

**6783 passed, 13 failed, 1384 ignored** across every test binary in the
workspace (12 distinct failing tests; one databricks test is reported by two
targets)
(`buzz-voice` alone is excluded: its `sherpa-onnx-sys` build script needs a
download this host cannot make). Per-binary highlights: `buzz_acp` 1074/0,
`buzz_cli` 771/0, `buzz_relay` 1623/1, `buzz_core` 350/0, `buzz_sdk` 338/0,
`buzz_auth` 261/0, `buzz_db` 168/0 (+515 ignored, they need Postgres),
`buzz_workflow` 175/0, `buzz_media` 166/0, `buzz_backend_kubernetes` 157/0.

The 12 failures sit in four binaries, in crates this branch does not touch:

| crate | failures | cause |
|---|---|---|
| `buzz-agent` | 9 distinct (`databricks::tests::…`) | `NetworkUnavailable` — these OAuth/catalog tests need real HTTP |
| `buzz-relay` | 1 (`api::mesh_demo::…`) | echo timeout; **proven to fail identically at base `8fecc3258`** |
| `buzz-feature-flags` | 1 (`relay_artifact_provider_features_require_exactly_one_selection`) | "expected static to compile successfully" — it compiles a fixture at test time |
| `git-sign-nostr` | 1 (`test_parse_envelope_rejects_invalid_oa_pubkey`) | parser assertion; crate untouched by this branch |

`git diff --name-only 8fecc3258..HEAD` is empty for `buzz-agent`,
`buzz-feature-flags` and `git-sign-nostr`, so none of those failures can come
from this work.

### The same journey with a wallet signing in the browser

`scripts/v5-demo-wallet-journey.mjs` drives the real screens with
`window.ethereum` backed by the demo chain's unlocked anvil accounts:

- **propose** — the manager opens the proposal form, fills the work area, the
  deliverable, the area's exact criteria words, the beneficiary, the quantity
  and a deadline, and sends it: the card reads
  `Offered, waiting for the named person`;
- **accept** — the beneficiary signs and the card reads
  `Agreed; the quantity is reserved`;
- **submit** — **blocked**, and this is a real finding: the submission form only
  renders once the work's words are published beside the chain record, and the
  proposal's publish affordance did not appear after sending (the relay holds
  zero `47003` updates from the launch author). The card correctly says the words
  "are not published here" and offers no form. So the manager's publish step is
  missing from the flow as shipped, and the beneficiary cannot submit from the
  app until it exists.

Screenshots: `wallet-1-proposed.png` (105 KB) and `wallet-2-accepted.png`
(111 KB), distinct hashes.

### The publish affordance after a failed publish (fixed, partly verified)

The offer's words are published beside the chain record, and the submission
form needs them. When that publish failed, the retry panel lived only on the
*closed* proposal card while the form stayed open — so the button a manager
needs was unreachable, and the beneficiary's card correctly said the words were
"not published here" and offered no form.

`AgreedProposalForm` now closes the form when publishing fails and renders the
pending-publish panel in **both** states. Verified against a freshly built app
(the dev server was serving a stale module, which is what made earlier attempts
look like a logic bug):

```
problem: The offer is on the chain, but its description and the work area's
         words could not be published…
form: 0   closed: 1   panel: 1   cards: 4
```

So the offer is on chain and the retry button is now on screen and clickable.

**Not yet verified: the publish actually succeeding, and therefore the
beneficiary's submit step.** The retry press still fails, and the last attempt's
proposal transaction itself was refused by the wallet
("The offer did not reach the chain"), on a demo world mutated by many earlier
runs. The chain calls are proven (`v5-demo-agreement.mjs` settles end to end);
what remains is the app's publish write and the submit form, on a fresh world.

### Where the publish write actually fails (narrowed)

The relay is not the blocker. Posting the exact event shape the app builds —
kind `47003`, tags `[["a","37001:<author>:demo"]]`, content with `title`, `body`
and `agreement{id, mandate, projectId, deliverable, criteriaWords}` — directly to
the local relay as the launch author returns:

```
HTTP 200 {"accepted":true,"event_id":"b4f024cd…","message":""}
```

So the shape, the tags and the author binding are accepted.

In the browser, with a wallet connected and the retry pressed, **no `EVENT`
frame carrying kind 47003 is ever sent** (the socket shows only `REQ` frames and
the `OK` acknowledgements for auth events). The failure therefore sits in the
app's client-side publish path (`publishMirror` → `signAsUser` →
`publishEvent`) *before* anything reaches the socket — not in the relay, the
event shape, or the tags.

That is the next concrete step: instrument `publishMirror`/`publishEvent` in the
app (they throw away the underlying error and the caller shows a generic
sentence) and fix whichever of signing or the WS publish is failing.

### Why the publish had no identity (root cause, fixed)

The app's identity store accepts a legacy **64-hex** key (it re-encrypts it
NIP-49 on first read) or an `ncryptsec1` blob — **not** a bech32 `nsec1…`. The
journey script wrote `nsec1…`, so `existingUserPubkey()` returned `null` and
every Nostr write failed before reaching the socket. That is exactly the
"no EVENT frame" symptom: the relay was never the problem.

Verified in the app's own module graph, with the hex key:

```
{"pub":"ba5734d8f7091719471e7f7ed6b9df170dc70cc661ca05e688601ad984f068b0"}
```

— the launch author, so signing and author binding are now correct. The script
writes the hex key, and `AgreedProposalForm` now carries the publish error's
message into its notice instead of a generic sentence, so the next failure names
itself.

**Not yet proven:** an app-originated `47003` publish landing. The last run
failed earlier, at the chain send ("The offer did not reach the chain") on a
world mutated by many runs, so the publish was never attempted. The next step is
one clean run on a fresh world.

### The wallet journey now completes in the app

One clean world (`scripts/v5-demo-world.sh`, chain `:51321`) and
`scripts/v5-demo-wallet-journey.mjs` with the hex identity:

```
[propose] wallet 0x70997970…79C8 signed it; card reads: Offered, waiting for the named person
[accept]  wallet 0x15d34AAf…6A65 signed it; card reads: Agreed; the quantity is reserved
[submit]  next: The panel judges one attempt at a time against the agreed criteria;
          no decision lands by itself and nothing accepts automatically.
PASS: proposed, accepted and submitted through the app, each signed by a wallet
```

Three checks, all from outside the app:

1. **An app-originated `47003` landed.** The relay holds two updates from the
   launch author; the new one is this run's, written by the app:
   `Agreed work: the first guide, finished and rev…`, agreement
   `0xa4fe5326db31…`, criteria `docs merged and reviewed`. (The other is the
   earlier manual probe with the placeholder id `0x1111…`.)
2. **The submission bound.** The agreement reads beneficiary
   `0x15d34AAf…6A65`, quantity `3e18`, `claimId 0x9620dc97…`, and
   `agreementOfClaim(0x9620dc97…) == 0xa4fe5326db31…` — the bind landed.
3. **It is in review**: the claim's status is `0` (`Open`), with no verdict yet.

Screenshots: `wallet-1-proposed.png` (102 KB), `wallet-2-accepted.png`
(147 KB), `wallet-3-submitted.png` (97 KB) — three distinct hashes.

The root cause of every earlier attempt was the identity format: the app accepts
a 64-hex key (re-encrypted NIP-49 on read) or an `ncryptsec1` blob, never a
bech32 `nsec1…`. With the hex key the same journey completes.

### The last unproven workspace failure, proven pre-existing

`git-sign-nostr`'s `tests::test_parse_envelope_rejects_invalid_oa_pubkey` was the
one failing test whose pre-existence had not been demonstrated. A detached
worktree at base `8fecc3258`, with its own target directory:

```
$ cargo test -p git-sign-nostr --lib tests::test_parse_envelope_rejects_invalid_oa_pubkey
thread 'tests::test_parse_envelope_rejects_invalid_oa_pubkey' panicked at
  crates/git-sign-nostr/src/lib.rs:2136:9:
assertion failed: result.is_err()
test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 55 filtered out
```

Same test, same file, same line, same assertion as on this branch — and this
branch changes no file in that crate. So all four failing crates
(`buzz-agent`, `buzz-relay`, `buzz-feature-flags`, `git-sign-nostr`) are now
either proven pre-existing or proven untouched-and-environment-bound; none is a
regression from this work. The base worktree was removed afterwards.

### The whole agreed-reward flow, driven from the app

The gap was that approval, the challenge window and settlement had only ever
been driven from the CLI. `scripts/v5-demo-wallet-journey.mjs` now runs all of
it through the real screens with `window.ethereum` signing each call, on a demo
world (`scripts/v5-demo-world.sh`):

```
[propose]  wallet 0x70997970…79C8 signed it; card reads: Offered, waiting for the named person
[accept]   wallet 0x15d34AAf…6A65 signed it; card reads: Agreed; the quantity is reserved
[submit]   next: The panel judges one attempt at a time against the agreed criteria…
[submit]   bound claim 0xb81af6fa… in 0x10c6e953…
[bind]     claim 0xb81af6fa… is bound to 0xc87808da29ed…
[approve]  reviewerA 0x3C44CdDd…93BC signed the approval
[approve]  reviewerB 0x90F79bf6…b906 signed the approval
[window]   the approval quorum was finished, which starts the challenge window
[settle]   wallet 0x15d34AAf…6A65 signed it; card reads Settled; exactly 7000000000000000000 Shares minted
[chain]    terminalKind=1 agreementOfClaim matches; shares still reserved: 3000000000000000000
PASS: proposed, accepted, submitted, approved by both reviewers, review finished,
      challenge window passed and settled — all from the app; exactly 7e18 Shares minted
```

Read back from the chain, independently of the app: the agreement's beneficiary
is `0x15d34AAf…6A65`, its quantity `7e18`, its `claimId` is the claim the app
submitted, `terminalKind = 1` (settled), the claim's status is `4` (`Paid`), the
beneficiary's balance is `13e18` (the `6e18` from the earlier run plus exactly
`7e18`), and `agreementOfClaim` still names the same agreement — the exactly-once
binding survived settlement.

Four screenshots, four distinct SHA-256 hashes: `wallet-1-proposed.png` (97 KB),
`wallet-2-accepted.png` (147 KB), `wallet-3-submitted.png` (97 KB),
`wallet-4-settled.png` (90 KB).

The script scopes every step to its own card (the one naming its own Share
quantity) and reads the binding from the chain, so a world holding other
agreements cannot make a step pass by acting on the wrong one.

### A failed read no longer claims "this factory predates funding terms"

`readFundingContract` caught every failure and returned `null`, which the
funding card rendered as "no funding terms" — a node timeout or a busy node
presented as a fact about the contract. That is the Review-Proven Rule 1 shape
(a caught failure converted into a successful absence), and it was reported by
the browser-spec lane and left unfixed until now.

**The read is now three-way, never two:**

```ts
type FundingContractRead =
  | { kind: "present"; address: string }   // the factory named its contract
  | { kind: "absent" }                     // it answered the zero address
  | { kind: "unreadable"; reason: string }; // the read did not complete
```

Only two things count as `absent`: the contract answering the **zero address**,
or the contract **reverting** the selector (what a factory from before D133
does). Everything else is `unreadable`:

- a node-side failure — timeout, unreachable, busy (`ChainReadError`);
- any other error that is not a revert (an HTTP refusal, a transport `TypeError`);
- an answer that is not exactly one 32-byte word. This last one mattered: an
  empty `0x` from a non-contract address decoded to zero and read as `absent`
  before the shape check was added.

`fundingContractOrThrow` is now the **only** place that turns the three-way
answer into a maybe-address: it returns the address, returns `null` for
`absent`, and **throws** for `unreadable`. The funding card already renders a
`query.isError` state ("The network did not answer, so funding can't be
shown. Try again"), so a failed read is now said out loud instead of hiding the
section; the decision composer shows `decision-funding-unreadable` with the
reason rather than silently not offering the funding forms.

**Regression tests, bound to the production seam** (`fundingTerms.test.mjs`):
the three-way result for a real answer, the zero address, a revert, five kinds
of failed read (timeout, unreachable, busy, transport `TypeError`, HTTP 503),
three malformed answers, and `fundingContractOrThrow` throwing on `unreadable`.
Falsifiability was checked by reverting each guard in turn:

```
=== guard 1 removed (any failure -> absent) ===   tests 7  pass 6  fail 1
=== guard 2 removed (shape check dropped)  ===   tests 7  pass 6  fail 1
=== restored                               ===   tests 7  pass 7  fail 0
```

Against the live demo chain: the real factory answers a 32-byte word naming
`0xeEBe00Ac…8883` (→ `present`), and an address with no code fails the node call
outright (→ `unreadable`, never `absent`).

Gates after the change: `pnpm -C web test` **2581 passed, 0 failed**;
`pnpm -C web typecheck` clean; `just web-check` **exit 0** (biome, copy,
px-text, kinds, templates, knip); biome clean on all eight touched files.

### Auditing the rest of the launchpad readers for the same shape

`readFundingContract` was not the only place a caught failure became an
authoritative absence. Every chain reader in `packages/creaton-core/src/launchpad`
and `web/src/features/launchpad` was swept for a `catch` that returns `null`,
`[]`, `0n` or `""` after a chain call, and each was judged on whether that value
is read as *absence* or as *unknown*:

| Reader | Verdict |
|---|---|
| `readFundingContract` | fixed in the previous change (three-way result) |
| **`readMilestonePanel`** | **was broken — fixed here** |
| **`readPostCourt`** | **was broken — fixed here** |
| `readReviewers` | already correct: `null` surfaces as `reviewersUnreadable` |
| `readOpenedLogs` | `null` is a fallback (re-read per decision), not an absence claim |
| `readChallengeLock` | already correct: `isRevert ? null : throw` |
| `readPayouts` | already correct: `revert ? null : throw` |
| `readExitFee`, `answers` | already correct: `isRefusal ? 0n/false : throw` |
| `readExchangeIfAny` | already correct: `isRefusal ? null : throw` |
| `readLane` | `null` renders as "could not read this budget's agreed rewards" |
| `readU256` (`enforced-check`) | correct: `null` becomes "proposalThreshold unreadable. The claim stands unverified" |
| `readContributions` | correct: `null` renders as "Unknown", never as zero |
| `runway-read.balance` | nullable by type; no absence claim on it |

#### `readMilestonePanel` — a failed read labelled the panel an ordinary budget

The reader that finds which budget judges the team's milestones caught every
failure and returned `null`, documented as "a factory made before panels existed
has no such function". A timeout therefore made **every** budget read
`isMilestonePanel: false`, so the panel was listed as "Not taking work now" and
the decision forms offered it as an ordinary budget.

It now answers three ways, like the funding read: the factory's own **revert** or
the **zero address** is `absent`; no answer, or a reply that is not one 32-byte
word, is `unreadable`. `WorkSnapshot` gains `milestonePanelUnreadable`, following
the existing `reviewersUnreadable` / `bondUnreadable` idiom, and the Work tab
renders `work-panel-unreadable` above the cards while the decision composer
renders `decision-panel-unreadable` — so the mislabel is never shown without
saying why.

#### `readPostCourt` — a failed read hid the appeal path

Same shape, same cause: `court()` caught every failure and returned `null`, and
`null` means "this bounty names no court", so a timeout silently removed the
appeal affordance from a bounty that has one. It now returns `null` only for the
contract's own revert or the zero address, and **throws** on anything else
(matching `readPayouts` and `readChallengeLock`, the closest analogues), so the
post's bounty read fails visibly instead of quietly dropping appeals.

#### Falsifiability

Each guard was removed in turn and the matching test failed:

```
panel guard (revert-only) removed:  pass 22  fail 1
panel guard (shape) removed:        pass 22  fail 1
court guard (revert-only) removed:  pass 14  fail 1
court guard (shape) removed:        pass 14  fail 1
restored:                          pass 38  fail 0
```

Three fixtures had to be made truthful rather than tolerant: `openBounty`'s and
`forecast`'s fake chains now answer `court()` with the zero address (their
bounties genuinely name none) instead of relying on the reader to swallow an
unmodelled call, and the `WorkSnapshot` literals in three tests carry the new
flag.

#### Gates after the change

- core launchpad suite: **454 passed, 0 failed**
- `pnpm -C web test`: **2581 passed, 0 failed**
- `pnpm -C web typecheck`: clean
- `just web-check`: **exit 0** (biome, copy, px-text, kinds, templates, knip)
- `WorkTab.tsx` is **999 lines**, inside the 1000-line gate (the note lives in its
  own `PanelUnreadableNote.tsx`)

### The two unreadable notes, seen in a real browser

`readMilestonePanel`'s three-way fix was only proven by unit tests. The two
notes it drives were rendered in Chromium against the live demo world, with the
panel read made to fail **at the RPC layer** (a JSON-RPC error whose message is
not a revert — the shape the reader classifies as `unreadable`), so the app's own
code path produced the flag:

```
[work] note: Couldn't read which of this DAO's budgets is the milestone panel,
             so the cards below may show it as an ordinary budget. Reload to try again.
[work] cards still on screen: 3 agreed card(s)
[composer] note: Couldn't read which budget is this DAO's milestone panel, so the
                 forms below may offer it as an ordinary budget. Reload to try again.
[composer] the kind picker is still offered: 1
PASS: with 2 milestoneMandate read(s) failing, the Work tab and the decision
      composer each say they could not read the panel, and both still render their content
```

**The control run matters as much as the failing one.** With the same
interception answering the panel call with the zero address the chain really
returns, neither note appears:

```
[work] control: the note is absent, and the tab still renders its content
[composer] control: the note is absent, and the forms are still offered
PASS (control): with the panel read answering normally, neither note appears
```

So the note is caused by the failed read, not rendered unconditionally — and it
does not replace the cards or the forms.

Screenshots (4, distinct hashes): `unreadable-work-tab.png` 440 KB
`631020a1…`, `unreadable-work-note.png` 18 KB `baaca92f…`,
`unreadable-composer.png` 449 KB `20a1f394…`, `unreadable-composer-note.png`
11 KB `b5448424…`.

Reproduce: `scripts/v5-demo-unreadable-notes.mjs` (needs the demo world and a
fresh `vite build` — the dev server serves stale modules, which is what made the
first attempt look like a product bug).

One thing the control run taught: on this host the demo chain's RPC occasionally
drops a request, and the first control attempt showed the note for real. That is
the behaviour working as intended — a failed read is surfaced — but it means the
control has to pin the answer rather than rely on the network.

### The browser journey suite: what blocked it, and what now runs

Running the gate's later journeys (`scripts/mvp-gate.sh --later`) exposed five
tooling defects that made **every** browser journey fail before it reached a
browser on this host. All five are fixed:

| Defect | Why it broke | Fix |
|---|---|---|
| `nohup anvil` | "can't detach from console: Inappropriate ioctl for device" — anvil never started | background start with stdin off the terminal (`setsid` where available) |
| `cast --rpc-url http://…` | Foundry's HTTP client panics building macOS proxy settings (`system-configuration` returns NULL) before the request leaves | every cast call uses the node's WebSocket transport (`CAST_RPC_URL`) |
| the packaged apptoken bootstrap | drives the chain with `cast` over the same HTTP client | handed the ws endpoint; the submodule is not edited |
| `forge script --rpc-url ws://…` | still builds the HTTP client unless `--offline` | `--offline` (everything is vendored) |
| `cast send --json` | newer Foundry writes a log line to stderr, and the call sites merge the streams, so `JSON.parse` saw two lines and reported "no code at `<none>`" for a transaction that had landed | a `send_json` wrapper keeps only the receipt line |

`scripts/dev-chain.sh` now completes end to end here (`exit 0`, "Bootstrap
complete."), and its unit tests still pass (6/6).

**A journey that now passes in a real browser.** `web-challenge-e2e` runs the
whole flow against a real local chain — the founder launches, two backers bid,
the sale graduates and they claim, a milestone is published and objected to and
turned down, published again and unlocked, and a late objection burns what is
left:

```
1 passed, 0 failed, 0 blocked, 0 skipped
RESULT web-challenge-e2e exit=0
```

Getting there needed one spec correction, and it is a copy change, not a
loosened assertion: the app says *"Publishing opens once buyers can claim what
they bought in the sale. That has not happened yet; it opens on its own, with
nothing for the team to do."* (`challenge-copy.ts`), while the spec still
expected the older paraphrase "opens when the buyers can claim". The assertion
now checks the app's own sentence, which means the same thing and says more.

**Two journeys still fail, for reasons that are not product defects:**

- `web-record-e2e`: `executeByVotes failed: gas estimate 6988081 exceeds the
  6000000 cap` — the journey's work-budget vote needs more gas than the CLI's
  cap on this chain. A real config mismatch worth its own fix; recorded, not
  papered over.
- `web-milestone-e2e`: `browser.newPage: Target page, context or browser has
  been closed` — this host's Chromium runs `--single-process` (the only mode the
  sandbox permits), and a second page brings the whole browser down. The
  challenge journey passes because it never opens two at once; the wallet
  journey earlier worked around the same thing with one browser per role.

### The gas cap that blocked `web-record-e2e`

The journey failed with `executeByVotes failed: gas estimate 6988081 exceeds
the 6000000 cap`. That cap is `PROCESS_GAS_CAP` in `launchpad_gov.rs`, set when
executing a passed proposal meant "a mandate and its reviewer panel". A
work-budget proposal costs more than that: a mandate, its claim escrow, a
verifier panel and the first project, measured at **6,988,081** on a real local
chain.

The library already defines the right ceiling for this exact case —
`tx::MAX_GAS_CEILING` (8,000,000), documented as "enough to deploy a mandate and
its reviewer panel in one governance execution, far under a block". The CLI was
holding a tighter number of its own, below the ceiling and below what the
deployment actually costs. It now uses the library's ceiling rather than a
hand-picked constant, so the bound stays hard and single-sourced.

`cargo build`, `cargo clippy -p buzz-cli --all-targets` and the crate's
`launchpad_gov` tests (7/7) pass, and the journey is green:

```
1 passed, 0 failed, 0 blocked, 0 skipped
RESULT web-record-e2e exit=0
```

### The later journey set: what runs, and what each failure actually is

Every journey in the gate's later set was run with the headless-shell flags.
Three pass; the rest fail for reasons that are now named rather than guessed.

| Journey | Result | Cause |
|---|---|---|
| `web-challenge-e2e` | **1 passed** | — |
| `web-record-e2e` | **1 passed** | after the gas-cap fix above |
| `web-dao-journey-e2e` | fails | `locator.click` timed out after the spec's own 420 s budget — a UI step never became clickable |
| `web-economy-e2e` | fails | `browserType.launch: Target page, context or browser has been closed` |
| `web-post-bounty-e2e` | fails | `browserContext.newPage: Target page, context or browser has been closed` |
| `web-rounds-e2e` | fails | copy mismatch: the app says *"You bid for 30 new **Shares** at up to 1.8 USDC."*, the spec expects *"30 new **non-voting s**hares"* |
| `web-milestone-e2e` | fails | `browser.newPage: … closed` |

**The browser-closed failures are one host limitation.** This machine's Chromium
only runs `--single-process` (the only mode its sandbox permits), and any second
page or context brings the whole browser down. `web-challenge-e2e` and
`web-record-e2e` pass because they never open two at once; the wallet journey
earlier worked around it with one browser per role. The fix belongs in those
specs (or in the environment), not in the product.

**The rounds mismatch is a real question, not a stale string.** `rounds-copy.ts`
deliberately distinguishes "Shares" from "non-voting shares" by the round's
`asShares` terms (D177), and the app chose the voting word for this world. Either
the journey's fixture now sells voting Shares (and the spec is stale) or the copy
branch picks the wrong word for this round. That needs a decision, so the
assertion was **not** edited to match.

Two more cast-over-HTTP panics were fixed in the journey scripts themselves
(`web-post-bounty-e2e.sh`, `web-rounds-e2e.sh`), which is why those two now reach
the browser instead of dying at boot.

### Two more journey findings, diagnosed rather than guessed

**`web-economy-e2e` was launching the wrong browser.** It runs under
`playwright.real-relay.config.ts`, the one config with no `PW_CHROMIUM_PATH`
escape hatch, so it launched the pinned Chromium — which dies on this host
before the first page. The config now takes the same hatch the other configs
have. That moved the failure from

```
browserType.launch: Target page, context or browser has been closed   (0 ms)
```

to

```
browserContext.newPage: Target page, context or browser has been closed  (64 ms)
```

which is the real remaining cause and is **not** a config problem: the spec's
own doc comment says "One person: a browser of their own", but `arrive()` calls
`browser.newContext()`, so all three people share one browser. With
`--single-process` Chromium (the only mode this sandbox permits) the second
context kills it. The fix is the pattern the wallet journey already uses — one
launched browser per person, closed at the end of the test — and it is a change
to `web/tests/e2e-real/economy.spec.ts` alone.

**The rounds copy mismatch is a real cross-surface inconsistency.** In one
funding round the app says two different things about the same units:

- the funding card reads *"On sale for the project: 40 new **non-voting shares**
  at 1.65 USDC each or more"* — from the funding terms (`asShares = false`);
- the round card reads *"You bid for 30 new **Shares** at up to 1.8 USDC."* —
  from `roundUnit(round, daoShares)`, which compares the round's token
  (`round.shares`) with the DAO's Shares address and returns "Shares" when they
  are equal.

`WeeklyRounds.openFunding` sets the round's token from
`IFundingTerms.reserve(dao)`, which is `asShares ? shares() : loot()`. So the
round token should differ from the DAO's Shares for a non-voting sale. Either
`reserve()` returned `shares()` for a round whose terms say otherwise, or the
DAO's `loot()` is the same address as its `shares()` in this world — and if it
is, the funding card's "non-voting shares" is the misleading surface, not the
round card's "Shares".

That needs a decision about which surface is right, so the spec's assertion was
**not** edited. The evidence needed to settle it is one read on a live world:
`terms.asShares`, `dao.shares()`, `dao.loot()`, and the round's `shares` field.
