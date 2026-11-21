# The phone path: back from a passkey account, with the network fee paid by the server (step 3b)

Status: built and proven on a local chain, 19 November 2026, branch `v6`. It is step 3b of `JOIN-LEAVE-DESIGN.md`, brought
forward because a person on a phone with no wallet app was the largest gap between the product and "join in seconds".
Nothing here is legal or tax advice, and no figure is a forecast. **What is not proven is listed in the last section and
matters: this ran against stand-ins for the bundler and the sponsor, and with a software passkey and a browser's virtual
one, never against an operator's real services or a real phone.**

## What a person sees

A person on a phone with no wallet signs up with a passkey (the sign-up that already existed). The app derives their own
account from that passkey, shows its address on You, and sends their Back from it: two presses (Back, then Back with 25
dollars), one typed field, one passkey prompt. The network fee is paid by the server's sponsor, so the account holds no
coin. The Back sheet says "Your passkey is asked once, for both steps. The server pays the network fee."

A person who has a wallet in their browser sees exactly what they saw before. A browser with both gets a small choice on
You ("Back from": the wallet in this browser, or my passkey account); the wallet stays the default and the choice is
remembered. A phone with no wallet, in a build where passkey sending is on but a setting is missing, reads on You: "Backing
from this phone is not switched on for this server yet. Open this page in a browser with a wallet to back now." The money
screens keep showing their existing "open this page in a browser with your wallet" line there, and nothing waits or hangs.
In a build where passkey sending is off, a phone with no wallet sees exactly what it saw before.

## What was built, in commit order

| Commit | What |
|---|---|
| `15e96b7dd` | Move the Kernel account, user-operation, bundler and sponsor code (nine files with their tests) and the software passkey into `packages/creaton-core`, with one-line re-export shims at the old web paths. Only import paths changed in the moved code. The sponsored-sender parity test against web's injected wallet stays in web. |
| `86b337864` | Core: check the sponsor's answer, record a sent operation at once, read call data back (below). |
| `8813c2562` | App: one sender interface (wallet or passkey account), the passkey sender (small shell in the first download, the rest a lazy chunk), the You choice, the copy, `app/.env.example`. |
| `c16798cbe` | `scripts/phone-loop.sh` and the anvil scenarios: the passkey account sends on a local chain through EntryPoint. |
| `ce676e4be` | One set of expectations run against both senders on a real chain. |
| `2fd1ff14a` | `scripts/pot-app-phone-e2e.sh`: a real browser signs up with a passkey and backs a project on the local chain; the You choice by keyboard and touch. |
| `32c88e9bd` | The Back sheet speaks of the passkey, not of a wallet, when the passkey account sends. |
| `23fe05c8f` | Keep the unused-exports scan clean. |

### Core (`packages/creaton-core/src/aa/`)

- `sendSponsoredUserOp` now (a) checks the sponsor's answer with `assertSponsorshipKeepsCall`: sender, nonce, init code and
  call data must be exactly what the client built, gas limits at most 10,000,000 each, and a fee ceiling at most 10 times
  the one asked for; a failure is a typed `SponsorshipRefusedError`, thrown before anything is signed; (b) calls a
  `beforeSign(op)` hook with the final unsigned operation; (c) calls `onSubmitted({userOpHash, sender, nonce})` the moment the
  bundler accepts the operation, before the wait; (d) on a timeout throws `UserOpPendingError` carrying the hash, account and
  sequence (its message is unchanged, so the old tests still match).
- The bundler and the sponsor can be set by URL (`ZerodevConfig.bundlerUrl`, `sponsorUrl`); with neither, the old
  project-id URL is built exactly as before.
- New: `getUserOperationByHash` on the bundler transport; chain reads `blockNumber`, `chainId`, `getLogs`;
  `readEntryPointSequence` (the account's next sequence at EntryPoint, key 0); `decodeExecuteCallData` and `callDataCarries`
  (the inverse of the call-data encoder, strict: it refuses anything that is not byte-for-byte the canonical encoding of its
  calls); `passkeyCredentialId()` in `passkey-identity.ts`.
- The existing 875 lines of `kernel033` tests and all moved tests pass unchanged; the new tests are in
  `aa/phone-send-core.test.mjs` (13 tests).

### App (`app/src/features/money/`)

- `wallet.ts`: `MoneyWallet` keeps its name and shape. Added, all optional so no stand-in breaks: `kind`, `availability()`,
  `capabilities`, and `sendCalls(calls, chainId, options?)` whose result may carry `userOpHash`. New `WalletStepError`
  reasons: `not-set-up`, `no-passkey`, `not-known`. The injected wallet is otherwise untouched (its 354 lines of tests pass
  unchanged).
- `sender.ts`: `chooseSender` and `useSender`. Rule: passkey sending is only ever used when the build turned it on
  (`VITE_CREATON_PASSKEY_ACCOUNT=1`); with it off, `useSender` is the injected wallet and nothing else. With it on: a browser
  with a wallet uses the wallet unless the person chose their passkey account and it can send; a browser with no wallet uses
  the passkey sender (even when it cannot send, so it can say why). `useWallet()` in `use-money.ts` now returns `useSender()`.
- `passkey-sender.ts` (first download) and `passkey-sender-impl.ts` (lazy chunk, 17.8 kB): availability without any prompt or
  network call, the targets check, the choice of network; the impl builds one operation from the calls, has the sponsor pay,
  asks for the passkey once, sends, and waits.
- `send-targets.ts`, `SenderChoice.tsx` (on You), copy in `money-copy.ts`.
- First download: the entry chunk is 434,834 bytes against a 450,000 budget (it was 429,179 before this work; the passkey code
  is a separate chunk).

## What the person signs is what the sheet showed

The sender takes the calls from the same builders the sheet describes (`backCalls` etc.), encodes them once
(`encodeExecuteCallData`) and passes the result as the operation's call data. Just before the passkey is asked, the final
sponsored operation's call data is read back and must carry exactly those calls, in that order (`callDataCarries`); a
reordered or different call stops the send with nothing signed. Bound by:

- `passkey-sender.test.ts` "refuses to sign anything but the calls it was given": the request the sender builds has the
  encoded calls; its `beforeSign` passes the shown calls and throws on a swapped or different one; zero passkey prompts.
- `passkey-sender.test.ts` first test and `passkey-back.test.ts`: the operation the bundler received decodes to exactly the
  given calls (and, for the Back, to exactly the app's own `backCalls`).
- `phone-send-core.test.mjs`: a sponsor answer that changes sender, nonce, init code or call data is refused, one field at a
  time, and a send stops before signing or sending on an absurd gas limit.

## How it was proven (local, no outside service)

`scripts/phone-loop.sh` starts a throwaway anvil, deploys EntryPoint v0.7 at its canonical address
(0x0000000071727De22E5E9d8BAf0edAc6f37da032) through the CREATE2 deployer anvil has at genesis, from the creation payload in the
vendored Kernel repo's v3.3 tag (`app/tests/anvil/fixtures/entrypoint-v07.json`), sets the deployed Kernel 0.3.3 stack
(factory, Kernel, the passkey validator, the P-256 verifier) at its own addresses from runtime code read once from public
Sepolia (`kernel033-stack.json`, public chain data), deploys a paymaster that pays for everything
(`accept-all-paymaster.json`, built from `contracts/test/helpers/AcceptAllPaymaster.sol`), and runs a Node stand-in for the
bundler and sponsor (`app/tests/anvil/stand-in-bundler.ts`, no `cast`). A software passkey behind `navigator.credentials`
signs in the production way (the sign-up ceremony, then real assertions). The account's address, its deploy on first send,
the hash check, the signature wrapping and the validator's check of the signature are the production code and the deployed
contracts.

Result of the last run (`bash scripts/phone-loop.sh`): 3 test files, 14 tests passed, 0 failed, 35 claims (it was 31 when this report was first written and 33 after its review fixes; later work added the rest):

```
PASS a real Back (approve the round, then ask 25 dollars) from a passkey account changed the round's own record of the ask
PASS a real Back is one operation and one passkey signature (the real-dollar path of two calls included)
PASS the signed operation's call data equals the app's own backCalls, in order
PASS a refusal by the real round (a round that is not open) comes back as the app's own words, from the receipt's revert reason
PASS the account paid no network fee: it held no coin before or after the Back
PASS the first send deploys the account and changes contract state through EntryPoint (25 dollars minted to it)
PASS one passkey prompt (one signature) for the whole first send, deploy included
PASS the signed operation's call data decodes to exactly the calls the sheet described
PASS the account held no coin and the network fee was paid by the sponsor's paymaster
PASS two calls (approve, then transfer) landed as one operation with one passkey prompt, in order
PASS a batch whose second call reverts lands as reverted and the first call (approve) is not kept
PASS the reason the account's call gave is read from the operation's receipt and carried with the failure
PASS a sponsor refusal is shown in plain words, before any passkey prompt, with nothing sent
PASS the check just before the passkey is asked passes the shown calls and stops reordered or different calls
PASS after a reload an operation the bundler still holds is found as waiting
PASS an operation the bundler dropped is found as unknown, never as landed
PASS when another operation took the dropped one's place it reads as replaced, and the new one as landed
PASS a repeat press after a dropped operation signs again and lands once
PASS an operation sent on after the page timed out is found as landed and counted once
PASS a second send started while one runs is refused; the first lands once
PASS a phone with no wallet reads the chain (balance, block, logs) through the configured node
PASS the wallet sender sends calls in the order given
PASS the wallet sender finds a landed send as landed
PASS the wallet sender finds a hash the network never saw as unknown
PASS the wallet sender reports a revert as reverted with the contract's reason
PASS the wallet sender's batch that reverts: the call before it stays, as the step's own `landed` count says
PASS the passkey sender sends calls in the order given
PASS the passkey sender finds a landed send as landed
PASS the passkey sender finds a hash the network never saw as unknown
PASS the passkey sender reports a revert as reverted with the contract's reason
PASS the passkey sender's batch that reverts: nothing is kept (all or nothing)
phone-loop: 35 claims proven
```

(The loop runs in about 4 seconds on this machine once anvil is up. `scripts/pot-app-loop.sh`, which runs the same folder with
the platform loop, passes with these files in it: 8 files, 18 tests.)

`scripts/pot-app-phone-e2e.sh` runs the same path in a real browser (Chromium with its virtual authenticator, which signs real
WebAuthn assertions the deployed validator checks): it builds the app with the phone settings, starts anvil, signs up with a
passkey, mints play dollars to the account shown on You, and backs a project whose contracts are the platform's real ones.
Last run: 2 tests passed, 0 failed.

```
[path] Back from a passkey account: 2 presses, 1 typed fields (1 words), 28 words read, about 11 s
passkey prompts for the Back: 1
```

## Measured presses and signatures for a Back on the passkey path

| | Presses | Typed fields | Passkey prompts (signatures) | Wallet confirmations | Operations sent |
|---|---|---|---|---|---|
| Back from a passkey account (measured: `pot-app-phone-e2e.sh`, real browser, real contracts) | 2 (Back, Back with 25 dollars) | 1 (the amount) | 1 | 0 | 1 |
| Back from a wallet (existing `money.spec.ts`, same sheet) | 2 | 1 | 0 | 2 (approve, ask), the wallet's own | 2 |

The measured Back is today's: approve the round, then ask, which is the real-dollar path (two calls). It lands as **one**
operation and takes **one** passkey prompt, because the sender is call-agnostic and two calls go as one all-or-nothing batch.
The play-dollar Back of `JOIN-LEAVE-DESIGN.md` 2.1 item 6 is one call (`transferAndCall` on the play dollar); no play-dollar
token or new join call exists in this track's tree yet (they are step 1a, another engineer's), so that exact Back could not be
measured. It cannot cost more than the measured one: a single call is the first scenario above, one operation, one passkey
prompt, and the `execute` single mode was exercised there. When step 1a lands, the same two Playwright specs run it by
changing the calls the builder gives; nothing in the sender changes. "Presses" counts what the person does in the app; the
passkey prompt is the device's own prompt, not a press. No time is promised: the "about 11 s" above is the spec's reading-time
estimate, not a measured duration of the send.

## What an operator must configure

All by name, at build time (they end up in the page every visitor downloads, so **no key or secret may be in any of them**;
if the bundler or sponsor needs a key, give the URL of a small proxy that holds it). Documented in `app/.env.example`; the
repo has no value for any of them.

| Name | Meaning |
|---|---|
| `VITE_CREATON_PASSKEY_ACCOUNT` | `1` turns passkey sending on. Unset or anything else: the feature is off and the app is exactly as before. |
| `VITE_CREATON_CHAIN_ID` | The network the project lives on (already used for the Launcher). |
| `VITE_CREATON_RPC_URL` | A node on that network, for reads and for the account's address. |
| `VITE_CREATON_BUNDLER_URL` | Where a signed step is sent: an ERC-4337 bundler for EntryPoint 0.7. |
| `VITE_CREATON_SPONSOR_URL` | Optional: where the fee is asked to be paid; the bundler URL when unset. |

With any of the chain id, node or bundler missing, the app says the plain sentence above. The sponsor must speak the method
`zd_sponsorUserOperation` (ZeroDev's) and the bundler `eth_sendUserOperation`, `eth_getUserOperationReceipt` and
`eth_getUserOperationByHash`; the account stack is Kernel 0.3.3 on EntryPoint 0.7 (decision D34). ERC-7677 is not built.

## Where the per-account daily limit on sponsored sends must be enforced

**At the sponsor, or a thin service the operator runs in front of it. Not in this app.** JOIN-LEAVE-DESIGN says "a server
setting". What it must hold, in this order of importance:

1. A total daily spend cap for the whole sponsor. A new passkey is a new account, so a per-account limit alone can be farmed
   by making accounts.
2. A per-account limit per UTC day (the account is the `sender` of the operation, known before it is sponsored).
3. An allow-list of target contracts the sponsor will pay to call (the project's contracts, the dollar token), so the sponsor
   does not pay for arbitrary calls.
4. A per-device or per-IP rule, for the same farming reason.

What the client can honestly enforce, and does: (a) it only builds an operation whose targets are contracts it knows (the
ones a project's numbers name, the dollar token its rounds take, the build's Launcher and Router) and refuses others with
`not-known` before anything loads; (b) one operation in flight per account (an in-page guard; the account's sequence number
also makes a second operation in the same slot fail, so a duplicate cannot land); (c) it shows the sponsor's refusal, in plain
words ("The free network fee was refused for this account, for example because today's free sends are used up. Nothing was
sent. Try again tomorrow, or use a browser with a wallet.") and asks for no passkey when the sponsor refuses (proven). It
keeps **no** "sends today" counter: clearing the browser's storage resets it, so it would only look like a limit.

## Every choice made under the owner's standing go (the owner may overrule)

Chosen under the owner's standing go; the owner may overrule

1. **Kernel 0.3.3 and EntryPoint 0.7 (D34)**, not the vendored v4 on EntryPoint 0.8.
2. **The proven `zd_sponsorUserOperation` wire protocol** on an operator-configured URL; ERC-7677 later.
3. **The injected wallet stays the default** when one is present; the passkey account is used when there is no wallet, and by
   a manual choice on You when both exist. The feature is off unless the build turns it on.
4. **No self-paid fees and no recovery module on the test network.** The passkey is the only key to the account; the You
   screen says so on first use ("Your passkey is the only key to the money in this account: if you lose it, that money cannot
   be got back."). **Recovery must be decided before any real-dollar account:** a recovery validator can only be added in the
   account's init data, which changes the account's address, so it cannot be added later without moving accounts.
5. **A repeat press after a dropped passkey send signs again** (the signed operation is not stored). Because the operation is
   deterministic apart from its signature, a repeat can land as the same operation (and then reads as landed) or as a
   replacement; either way it lands once (proven).
6. **Daily limits live at the operator's sponsor only** (previous section). The client checks targets, one in flight, and
   shows the refusal.
7. **Local proof: capture once from public Sepolia** (the plan's option A) for the Kernel stack, with the plan's option B
   (compile from the v3.3 tag) not needed. The four runtime codes and the EntryPoint payload are committed as fixtures.
8. **The sponsor's answer is bounded by constants I chose:** each gas field at most 10,000,000, a fee ceiling at most 10 times
   the one the client asked for. Generous on purpose; a real operator's numbers may call for tuning.
9. **The known-targets set is filled where the app already reads the chain** (`useProjectNumbers` for a project's contracts,
   `readQuote` for the dollar token) plus the build's Launcher and Router, in a small registry (`send-targets.ts`); a passkey
   send to anything else is refused. This costs two lines in `use-money.ts` and means team and market sends from a passkey
   account work only once their contracts are known to that registry (below).
10. **`via` on `PendingSend` was not added.** A pending record is keyed by action and sending account; a passkey account's
    address is never a wallet's, so a record cannot be read by the wrong sender.
11. **The plan's `SendResult` / `Sender` names were not introduced.** `MoneyWallet` kept its name and the new members are
    optional, so no screen or stand-in changed. `sendCalls` gained an optional third argument and an optional `userOpHash`.
12. **I added `app/.env.example`** (there was none for the app) to document the settings, and `app/playwright.pot-phone.config.ts`
    plus two scripts for the phone proofs. I did not touch the root `knip.jsonc` (outside this track), and so typed the
    software passkey inside the app's tests rather than adding a declaration file the scan would flag.
13. **Wording on the Back sheet** (`BackBox.tsx`, three strings and the press label) now depends on the sender: a call-site
    edit to keep the sheet true on the passkey path. Other sheets still say "wallet" (below).

## What is not proven

- **No real bundler or sponsor.** The stand-in answers fixed gas and pays from a paymaster that accepts everything. Gas
  estimation, a hosted sponsor's policy and limit refusals and their wording, rate limits, and which account or contract
  addresses a hosted service accepts were not exercised. This needs one run on a public test network with an operator's URLs
  (the old fork script `scripts/web-passkey-contributor-e2e.sh` still reaches the moved code through the shims but needs an
  outside node; I did not run it).
- **No real device.** Chromium's virtual authenticator and a software passkey stand in for iOS and Android passkeys, PRF on
  Safari, wallet-browser quirks and cross-device sync.
- **No play-dollar `transferAndCall` Back** (step 1a is not in this tree); the measured Back is the two-call dollar Back.
- **The account address comes from the configured node.** A node that lied could show a wrong deposit address. Not cross-checked
  in this cut; do it (or compute the CREATE2 address locally) before a first real deposit.

## What is not done

- **Sheets other than Back still say "your wallet"** for a passkey sender in their own sentences (the error words of every
  sheet now follow the sender, see "Review fixes"): the refund and take-out sheets in `Receipts.tsx`,
  Open backing, the team send sheets, and the weekly update. They belong to other tracks; `useMoneySend(...).words` gives each
  of them the right words (`where`, `waiting`, `twoCalls`), and `Back` shows the pattern.
- **Team and market actions from a passkey account.** `signTypedData` is refused (`capabilities.signsMessages` is false), so
  linking a passkey account to a team seat needs `signKernelHash` and the wallet-proof ERC-1271 path (the next step after
  Back). `LinkWallet` still renders for a passkey sender and would show an error if pressed; hiding it when the sender cannot
  sign is a one-line change in `team/LinkWallet.tsx`, which I left to its owner. Sends to the Launcher or Router go only when
  the build names them.
- **Speed-up and cancel for passkey sends**, ERC-7677, self-paid fees, recovery and guardians, a faucet call inside the first
  operation, merging the two ABI encoders, removing the `import.meta.env` fallbacks from the moved files, moving web's
  `passkey-wallet.ts` and launchpad senders, the v4 stack: all as the plan listed them, not built.
- **Layer 2 of the plan** (swapping `walletOf` in `tests/anvil/steps.ts` so the whole existing loop runs from smart accounts)
  was not done: it needs one passkey per actor and the step 1a contracts. The real Back from a passkey account on the
  platform's contracts (`passkey-back.test.ts`) covers the part of it that matters here.
- **The first-send account address is derived by the node on every cold start of a page that has not seen it**; it is
  remembered per network and owner key afterwards (`creaton.money.passkey-account`), so a reload makes no call for it.

## Checks that were run (all from this tree, last runs)

- `packages/creaton-core`: `pnpm test` 1131 tests, 1131 passed, 0 failed (it was 1118 before this work: 13 new). `biome check`
  on the files I touched: clean. (One earlier formatting error in `launchpad/evmAbiDecode.test.mjs` is not mine and was
  already there.)
- `web`: `pnpm test` 3502 tests, 3501 passed, 0 failed, 1 skipped; `tsc --noEmit` clean; `pnpm build` builds; `pnpm check:unused`
  (the unused-exports scan) clean; `biome check src/features/identity` clean.
- `app`: `vitest run` 263 tests in 42 files, 263 passed, 0 failed; `tsc --noEmit` clean; `biome check .` clean; `check:copy`,
  `check:px-text` pass; `check:file-sizes` passes (run with `CHECK_FILE_SIZES_BASE=43ffb2c08`, since this machine has no
  `origin/main`); `pnpm build` and the bundle budget pass (entry chunk 434,834 bytes of 450,000).
- Playwright, the existing `smoke` project (every spec of the app, including `money`, `money-review`, `team`, `market`,
  `earlier`, `passkey`, `a11y`): 73 tests, 73 passed, 0 failed (4.9 minutes). The `passkey` sign-up spec failed once in an
  earlier partial run under load (its 20 second wait for the unlock bar) and passed on a rerun alone and in the full run; I
  did not change it.
- `scripts/phone-loop.sh` 31 claims then, 35 now; `scripts/pot-app-phone-e2e.sh` 2 tests passed; `scripts/pot-app-loop.sh` 8 files, 18 tests passed.

Rules held: no secret, key or service URL with a key is in the repo (settings by name only; the local scripts use this run's
own loopback addresses); no names, amounts or wallets of real people (the fixtures are contract bytecode and anvil's public
test accounts); no model or AI-vendor name in code, comments, docs, tests or commit subjects; no revenue wording about Shares; no `unsafe`, no new `unwrap()`/`expect()`; new public API in core has doc comments; the legal line is not restated
here (the Back sheet still carries it word for word, and the browser spec checks it).

## Review fixes

Two independent reviews of commits `15e96b7dd..e94d7d26b` found two blockers and several important defects. Each is
reproduced, fixed, and pinned by a test that fails without the fix (checked by putting the old code back for a moment).

**Blockers**

1. **A passkey Back that timed out and later landed was sent again as its second call alone.** A passkey Back is one
   operation of two calls, but it was remembered as "call 0 of 2", so the next press took "landed" to mean "the first call
   landed, send the rest" and sent the ask by itself (or, for "replaced", skipped the look-up and sent a full second Back).
   Fixed in `sendStep` (`use-money.ts`): a sender that sends the whole step as one operation (`capabilities.atomicBatch`) is
   remembered as the last of its calls, so landed means done, replaced goes through `confirm`, and a later look never sends
   a lone later call. Tests: `app/src/features/money/passkey-step.test.tsx`, through `useMoneySend` with the real passkey
   sender and its real sending part (only the network answers and the signing call are stand-ins).
2. **`VITE_CREATON_SPONSOR_URL` was ignored on the app's real path.** `sendKernel033UserOp` always passes its own bundler
   transport, and the sponsor transport was only built when none was passed, so the fee request went to the bundler.
   Fixed in `zerodev.ts`: whenever a sponsor address is set, the fee request goes there, whatever transport is passed.
   Tests: `phone-fixes.test.mjs` (through `sendKernel033UserOp`, and with a transport passed). The anvil loop and the browser
   run now give the app two addresses, a bundler that knows no `zd_` method and a sponsor that answers only
   `zd_sponsorUserOperation`, so they pass only when the fee is asked at the sponsor's own address (claim 32 below). A
   sponsor setting that is set but unusable now makes the app say it is not switched on, instead of being dropped silently.

**Important**

3. **The address cache was shared between the wallet and the passkey sender.** The query keys now carry the sender
   (`["money","address",kind]`, and the same for the on-network check and the connect write). Test: "the account shown".
4. **The pending record was written only when the wait timed out.** Core has a new `onSigned` hook (after signing, before
   the send); the passkey sender passes it on as `SendOptions.onSent`, and `sendStep` writes the record at that moment and
   clears it when the step lands, reverts or is plainly refused. A tab killed during the wait now finds it again.
5. **An accepted-but-unacknowledged send was reported as "nothing changed".** A send whose answer was lost, and whose retry
   was told "already known", left no record. With the record written at signing, and bundler errors now carrying
   `maybeDelivered` (a timeout, a dropped connection or a 5xx on any try), only the bundler's own plain refusal as the
   first and only try is "did not go through"; anything else after signing is "pending", which the next press resolves by
   looking the operation up.
6. **The bundler's receipt was trusted completely.** A receipt for another operation (a different `userOpHash`) is now never
   taken as an answer, in the wait or in `outcomeOf`. A bundler that cannot answer the look-up now makes the step "still
   pending" (it used to read as "unknown", which meant "never sent" and a fresh send).
7. **Copy on the Back path spoke of a wallet when the passkey sent.** `WalletStepError` carries which sender stopped it
   (set by `useMoneySend`); `moneyProblem` says the passkey account's own words for "pending", "replaced", the wrong
   network, not enough dollars and the network coin. The wallet's words are byte for byte what they were.
8. **`LinkWallet` was a dead end on a phone with no wallet.** It is hidden when the sender cannot sign messages.
9. **A sponsor's paymaster fields were unchecked.** The zero address, a field that is too short, and paymaster gas limits
   above 10,000,000 are refused before anything is signed. The zero address from the node as the account is refused too.
10. **Wrong message for a browser that holds no passkey for the account.** "To back from this phone you need to be signed in
    with a passkey" was wrong for a person who is signed in by recovery key. It now says "This browser does not hold the
    passkey for an account here, so it cannot back from one. Sign in with your passkey on the phone where you made it, or
    open this page in a browser with a wallet."
11. **Settings that carry a key.** An address with a name, a password, or a key/token/secret in its query is refused.
12. **Documented:** the wording a sponsor must use for the daily limit to read in plain words (`app/.env.example`), and the
    honest limit of the known-targets check (`send-targets.ts`: it catches this app's mistakes, not an attacker, and the
    dollar token comes from the configured node).

**Added proof.** `phone-loop.sh`: 33 claims (two new: the fee is asked at the sponsor's address and the operation sent to the
bundler's; an operation signed by a key the account does not know is refused by the validator and nothing changes; the loop proves 35 now).
`pot-app-phone-e2e.sh` now runs the browser against the same two addresses. Two older core test fixtures gave receipts with a
placeholder `userOpHash`; they now name the operation, as a real receipt does.

**Declined or left, with the reason**

- **Making the account recoverable from the passkey alone, or publishing the public key and credential id with the profile**
  (both reviews, important): not built. It is the recovery decision the report already says must be taken before any
  real-dollar account (a recovery module changes the account's address, and a published key or a discoverable-credential
  sign-in changes what the person reveals and how sign-in works); it is not a defect of the send path. What this cut does is
  the honest message above. **Before real dollars: a person whose browser storage is cleared, or who opens the site on a
  laptop, cannot reach the account from the passkey alone** (iOS Safari also drops script-written storage after about a week
  of non-use). The money would be stranded while the key still exists in the keychain. Decide this first.
- **Node cross-check of the receipt** (the `UserOperationEvent` for the hash and sender in the bundle transaction): not
  built. The hash check above stops a receipt for another operation; a bundler that lies about its own operation's result is
  not stopped, and the Back's own `confirm` read of the round's record is the cross-check that holds for money. Do it with
  the first real bundler.
- **An operator-pinned paymaster address** (a new build setting): not built; the zero address and the gas caps are refused.
  The page's caps protect the person, not the sponsor: an attacker builds operations in their own code.
- **A timeout on the passkey prompt** (optional): not built. A prompt that never settles holds the in-page lock for that
  account until the page is reloaded.
- **Recomputing the account's CREATE2 address locally**, **a stack-version key on the remembered address**, and **telling the
  person a hostile bundler learns the sender, the calls and the IP** (optional): not built; the first was already listed.

**What the sponsor must enforce** (additions from the attack review; the placement, at the operator's side, stands)

- The sponsor address and any key are public in the page, so anyone can call `zd_sponsorUserOperation` directly with accounts
  of their own: a per-account limit alone is farmable because accounts cost nothing. Keep the whole-sponsor daily cap first.
- Pin the init code to the known factory, init data and validator; allow only nonce key 0; decode the account's `execute`
  call data and allow only the single (0x00) and batch (0x01) modes, never delegatecall; allow-list the inner call targets
  and selectors. A policy that looks only at the outer "to" sees the account itself and checks nothing.
- The app asks the sponsor before the passkey prompt, so a limit that counts requests is spent by people who cancel the
  prompt. Count operations that reach `eth_sendUserOperation`, or land.
- Cap the total gas of an operation (verification, call, pre-verification, paymaster) and give the paymaster a short validity
  window. The first operation (the account's deploy) costs most: limit it per device or address.

**Checks run after the fixes**

- `packages/creaton-core`: `pnpm test` 1139 tests, 1139 passed, 0 failed (8 new in `phone-fixes.test.mjs`).
- `web`: `pnpm test` 3502 tests, 3501 passed, 0 failed, 1 skipped (unchanged).
- `app`: `vitest run` 280 tests in 44 files, 280 passed, 0 failed (it was 263 in 42 files);
  `tsc --noEmit` clean; `biome check .` clean; `check:copy`, `check:px-text` pass; `check:file-sizes` passes with
  `CHECK_FILE_SIZES_BASE`; `pnpm build` passes the bundle budget (entry chunk 436,474 bytes of 450,000).
- `scripts/phone-loop.sh`: 3 files, 13 tests passed, 33 claims (3 files, 14 tests, 35 claims now). `scripts/pot-app-phone-e2e.sh`: 2 passed (1 passkey prompt, 2
  presses, 1 typed field).
