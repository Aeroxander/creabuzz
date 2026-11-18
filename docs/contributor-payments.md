# Contributor payments for the first project

The task board's contribution review and onchain payments are separate today.
Marking a task done, or accepting its contribution record, does not transfer
USDC. Task rewards are contribution points; they are not a currency balance.
This preserves the DAO OS rule that the chain is the ledger for money.

## Confirming the person to pay

On the contributor's social profile (`/u/<Nostr public key>`), choose **Link
payment wallet**. Sharing the address requires explicit consent: the link
connects that Nostr identity with the wallet's public transaction history.

The browser requests a SIWE signature and an EIP-712 `NostrSigner` signature,
then signs the public kind:37017 binding with the same Nostr account. The
existing SIWE registration endpoint receives the attestation too. A reader
verifies the Nostr event signature and recovers the EVM signer locally before
offering a copyable payment address. Copying checks the latest record again,
including revocations made since the profile loaded. The full checksummed
address and chain id are shown together. This proves control of both keys, not
the person's legal identity or the quality of their work.

Proofs expire after one year. A newer revocation, expired proof or malformed
signed statement suppresses the old payment address. **Remove public wallet**
publishes a revocation without removing community membership; old public
records remain in history. The account menu's **Unbind wallet** also withdraws
an active public proof before revoking SIWE membership. A failed public update
is retained in this browser, scoped to its relay and Nostr author, for retry.
Two kinds of wallet can be linked:

- **A browser wallet** signs the link with an ordinary EVM signature, which anyone can check offline.
- **A passkey account**, the smart account made for people who sign in with a passkey, signs through its
  passkey (**Sign with my passkey account**). A smart account has no key to check offline, so its signature is
  one only the account contract can judge (ERC-1271). The app asks the account before it publishes anything,
  the server asks it again when the record arrives, and every reader asks it before showing the address as
  verified. If the network cannot be reached, the address is not shown as verified and the card says why; it
  never falls back to trusting the record. The account has to exist on chain to answer: the first time, the
  app creates it with one sponsored, empty operation. The passkey account has no SIWE message, so linking it
  creates no server-side wallet membership. It is the Kernel 0.3.3 account the rest of the app uses.

A server accepts passkey-account links only when it is set up to ask a chain (`BUZZ_EVM_AUTH`,
`BUZZ_EVM_RPC_URL`, `BUZZ_EVM_CHAIN_ID`); without that it refuses them rather than store a claim it cannot
check. Each such record costs the server one bounded RPC call (timeouts and a response cap apply); records
signed by an ordinary wallet cost nothing extra, and removing a link never needs the chain.

## Manual payment

1. Agree the task, amount, token and network, and have someone other than the
   contributor verify delivery.
2. Open the contributor's profile and check the verified payment wallet.
3. If funds are in a team-controlled wallet, send from that wallet's own UI to
   the verified address on the agreed network. Record the transaction link
   with the task after it confirms.
4. If funds are in the DAO treasury, use **Decisions → New decision
   → Pay from the treasury**. The payment form offers named recipients only
   when both signatures verify on the project's chain. It checks the latest
   proof again when a person is selected. Alternatively paste an agreed
   address. Check the full recipient, token contract, network and amount;
   holders then back, queue and execute the proposal. Opening it sends no
   currency. Funds already reserved in a work budget or locked raise reserve
   are not the same as the DAO's available treasury balance.

Do not also pay the same work through a funded claim. The task board does not
automatically reconcile an external transfer or a treasury proposal into a
paid task status; the confirmed transaction is the payment receipt.

## Funded claims

The existing Work flow is:

1. The DAO approves and funds a work budget, then approves a project inside it.
2. The contributor files a claim from the wallet that must receive the money,
   naming the amount, evidence and acceptance check. A deposit, if requested,
   is held while the claim is reviewed.
3. The project manager takes on the claim, reserving its payment. The required
   reviewers approve it; a contributor cannot review their own claim.
4. Anyone can **Finalize review** once the review quorum is met.
5. After the challenge window ends, the contributor uses **Refresh work
   status**, then **Claim payment** from the original wallet.

`ClaimStake.payout` checks the caller against the stored contributor, marks the
claim paid before transferring currency, and pays the amount plus returned
deposit to that stored address. A later profile wallet change cannot redirect
an existing claim. Shares awards require a separate DAO decision.

## Trust and validation record

- **Censorship resistance:** profile discovery and publishing depend on the
  selected community relay and its membership policy. A relay can withhold
  records; local signature checks prevent it from forging another person's
  link. A payer still depends on the relay for the latest revocation. Chain
  payouts can be called directly using the contracts and CLI; the web UI uses
  the configured RPC and the user's injected wallet.
- **Open:** this change uses the existing public event kind, SIWE endpoint,
  contract ABI and installed cryptography libraries. It introduces no hosted
  identity service, paymaster or new contract. It is a local change in this
  checkout; publishing and deployment are separate work.
- **Privacy:** publishing the link is opt-in. Nostr authors, wallet addresses,
  signatures, chains and payment transactions are public. Removing a link
  withdraws its current use but cannot erase historical copies. Relay/RPC
  providers can observe request metadata; no analytics were added here.
- **Security:** the app gains no custody or token allowance from wallet
  linking. Manual payments require the payer's wallet or a DAO vote; funded
  claims retain their contract recipient, funding bounds, independent review
  and challenge window. This change does not assess the entire deployment's
  admin/upgrade powers or the currency issuer's controls.

Validation includes a Foundry-generated EIP-712 signature vector, malformed
and foreign proof tests, browser linking/retry/revocation tests, and the
isolated Anvil journey in `scripts/web-paid-work-e2e.sh`. The latter exercises
real six-decimal currency transfers through both funded claims and manual
treasury decisions, using public development accounts and a mock relay.
These checks establish local behavior, not a security audit or production
deployment assurance.
