# creabuzz

A fork of [block/buzz](https://github.com/block/buzz): **a DAO OS — agentic
Slack plus a DAO launchpad, wired into one loop.** The product contract is
[docs/dao-os.md](docs/dao-os.md); the org vocabulary is
[docs/nips/NIP-ORG.md](docs/nips/NIP-ORG.md) and the launch vocabulary is
[docs/nips/NIP-LP.md](docs/nips/NIP-LP.md).

## What this fork adds

| Area | Where |
| --- | --- |
| Org graph: seats, grants, budgets, approvals, contribution records | `crates/buzz-core/src/org_grant.rs`, `crates/buzz-relay/src/handlers/{org_grant_enforcement,budget_enforcement}.rs`, `crates/buzz-sdk`, `buzz org …` in `crates/buzz-cli`, desktop `features/org` |
| Money plane: token launch (CCA auction), settlement, DAO (majeur), allowance ledger | `contracts/`, `crates/buzz-evm-{auth,allowance}`, desktop + web `features/launchpad` |
| Wallet identity: SIWE, passkey accounts, ERC-4337 | `web/src/features/identity`, `desktop/src-tauri/src/commands/{wallet,passkey}.rs` |
| Wiki: human pages (kind 44001) and agent pages (kind 44002), nightly distill | `web/src/features/wiki`, `crates/buzz-agwiki`, `crates/buzz-skillopt`, `buzz agwiki …` |
| Project templates that start a whole project (channels, agents, workflows, wiki, org, budgets) | `templates/`, `crates/buzz-cli/src/commands/templates` |
| Browser web client (community, work board, wiki, launchpad) | `web/` |
| Agent runtimes beyond ACP: fleet worker, browser agent, Paperclip on-ramp | `crates/buzz-fleet-worker`, `web/src/features/fleet`, `crates/buzz-paperclip` |

## Staying mergeable with upstream

Only about 160 of the files this fork touched are upstream files; the rest are
new. To keep it that way:

- New behaviour goes in new files and new crates; edits to upstream files stay
  small and are called out in the commit message.
- New event kinds are registered in `crates/buzz-core/src/kind.rs` first, and
  mirrored in `desktop/src/shared/constants/kinds.ts`,
  `web/src/shared/constants/kinds.ts` and `mobile/lib/shared/relay/nostr_models.dart`.
- Migrations take the next free number *at merge time*. Upstream moves fast:
  expect to renumber.
- Everything opt-in stays behind an env var or a preview feature flag, and the
  relay stays wire-compatible with stock Buzz clients.

```bash
git remote add upstream https://github.com/block/buzz
git fetch upstream main
git branch upstream-mirror upstream/main     # a pristine mirror; never commit here
git merge upstream-mirror                    # from the fork's feature branch
```

## Safe defaults

The launchpad is testnet-only until the contracts are audited and a legal
posture exists: mainnet chain presets are off unless `VITE_ENABLE_MAINNET` is
set, and every launch dialog says the contracts are unaudited. See
[docs/dao-os.md](docs/dao-os.md) rule R4.
