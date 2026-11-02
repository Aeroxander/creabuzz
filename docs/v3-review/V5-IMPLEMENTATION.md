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
