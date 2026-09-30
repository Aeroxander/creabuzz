# Protocol Bible

Fill this in with the team. It is the canon @The Contract Developer, @The App Developer, @The Security Reviewer, and @Deploy Ops all work from: anything here is true for this protocol, anything not here is still open — say so rather than assuming.

## What we're building

One paragraph: what the protocol does, for whom, and what it deliberately does not do.

## Chain targets

| Chain | Chain ID | Why this one | Status |
|-------|----------|--------------|--------|
| e.g. Base | 8453 | | planned / live |

Record the decision, not just the choice — the "why" is what stops a re-litigation every quarter.

## Contract registry

| Contract | Address | Deployer | Verified at | Notes |
|----------|---------|----------|-------------|-------|
| | | | | |

Addresses are the fastest way to lose funds. Never paste an address into code or a doc from memory — verify it on the explorer, then record it here.

## Threat model

Write it as sentences an attacker could disagree with.

- **Assets**: what is worth stealing? (funds, governance weight, user permissions, availability, reputation)
- **Trust boundaries**: who is trusted with what? Owner, multisig, oracles, keepers, users, external protocols.
- **Adversaries we assume**: a hostile caller with one transaction of budget? a compromised owner key? a rational MEV bot? a compromised external dependency?
- **Explicitly out of scope**: name what we are *not* defending against, so a reviewer knows where the wall ends.

## Invariants

Numbered, testable, and enforced by at least one test. "Total assets backing a share ≥ total shares minted" — not "funds are safe".

1.
2.
3.

Each invariant needs a test that fails when it breaks. If it has no test, mark it `unenforced` and treat it as a finding.

## Roles and powers

| Role | Can | Cannot | Held by |
|------|-----|--------|---------|
| | | | |

## Upgrade & pause

- Is there a proxy? Which pattern? What can the owner change after deploy?
- Who can pause, and what does pausing actually stop?
- Is there an escape hatch for users, and does it work while paused?

## Deploy checklist

Run this top to bottom for every deploy. @Deploy Ops rehearses it on testnet first; a human executes production steps.

- [ ] Change passed the #security review loop with no open high-severity findings.
- [ ] Invariants in this doc have tests, and the full suite is green.
- [ ] Chain ID, RPC, and explorer confirmed against this table — not from memory.
- [ ] Addresses and constructor args recorded *before* broadcasting.
- [ ] Contract source verified on the explorer immediately after deploy.
- [ ] Smoke test run against the deployed address: read, write, revert path.
- [ ] This registry updated with the new row.
- [ ] Monitoring/alerting pointed at the new address.
- [ ] Rollback or migration path written down, and someone other than the author has read it.

## Open questions

- [ ] Anything unresolved — decisions pending in #governance go here with a link to the thread.
